/**
 * serial-hub-mcp —— 把串口控制面暴露成 MCP tools（给 workbuddy / Cline 等）。
 *
 * 关键设计：
 *   - 首次调用时通过 ensureDaemon **自动在后台拉起守护进程**，AI 无需手动起服务。
 *   - server 级 instructions 会在连接时作为系统提示下发给模型（最基础用法），
 *     完整用法见 docs/AI-INSTRUCTIONS.md。
 *   - 每个工具都返回 { text, structuredContent }：text 给模型读，structuredContent
 *     给程序用（截断/命中/发送字节数等）。
 *
 * 运行：node bin/serial-hub-mcp.js  （由 MCP 客户端以 stdio 方式拉起）
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { ensureDaemon } from '../src/client.js'
import { createSerialApi } from '../src/serial-api.js'
import { ipcPort } from '../src/config.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const DAEMON_ENTRY = join(HERE, '..', 'src', 'daemon.js')

/** 连接时下发给模型的系统提示（最基础用法；完整见 AI-INSTRUCTIONS.md）。 */
const INSTRUCTIONS = `你接入了 serial-hub：与人类共用同一条嵌入式开发板串口，可自主"看/发/交互式调试"。

铁律：
1. 端口靠独占，不能多个程序同时开同一个口——本机别再开 MobaXterm/CRT/PuTTY。
2. 发命令用 serial_write（默认自动补回车 \\r）。登录/提示符等有时限的窗口，必须用
   serial_expect_send 原子"命中即发"，**不要**用 wait 再 write 两段式（模型往返秒级会错过）。
3. 读输出用 serial_read（只给你还没看过的部分）。只关心设备输出时传 direction="in"。
4. wait 适合主动等提示符（如 "login:"、"# "），超时会返回已读到的片段。
5. 打断 U-Boot 自动启动：serial_signals({dtr:true}) 按住复位 → serial_signals({dtr:false})
   释放 → serial_expect_send({pattern:"Hit any key to stop autoboot", keys:["enter"]})。
6. 别人（人类或另一个 AI）也可能在敲。写完关键命令前可 serial_status 看输入权在谁手里。

无硬件时可用 VIRTUAL 虚拟端口通链路。完整工作流见 docs/AI-INSTRUCTIONS.md。`

/** 工具 schema（JSON Schema）。properties 与 DSH 版 serial_* 保持一致。 */
const TOOLS = [
  {
    name: 'serial_status',
    description: '当前状态：是否打开、端口/波特率、缓冲 seq 范围、输入权归属、缓冲字节数。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'serial_list_ports',
    description: '列出可用串口（含虚拟演示端口 VIRTUAL）。插上板子后调用。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'serial_open',
    description: '打开并独占一个串口，之后才能读写。默认 115200 8N1。port 传 "VIRTUAL" 用虚拟板自测。',
    inputSchema: {
      type: 'object',
      properties: {
        port: { type: 'string', description: '串口名，例如 COM6、/dev/ttyUSB0，或 VIRTUAL。' },
        baudRate: { type: 'number', description: '波特率，默认 115200。' },
        dataBits: { type: 'number', description: '数据位，默认 8。' },
        stopBits: { type: 'number', description: '停止位，默认 1。' },
        parity: { type: 'string', description: '校验：none/even/odd，默认 none。' },
        rtscts: { type: 'boolean', description: '是否硬件流控，默认 false。' },
      },
      required: ['port'],
      additionalProperties: false,
    },
  },
  {
    name: 'serial_close',
    description: '关闭串口并释放独占与输入权。调试结束后调用，把端口还给别人。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'serial_write',
    description:
      '向串口写文本（默认自动追加回车 \\r）。串口控制台请用 CR 而不是 LF。与 keys 二选一。raw=true 时 data 是十六进制字节串。',
    inputSchema: {
      type: 'object',
      properties: {
        data: { type: 'string', description: '要发送的文本（或 raw 模式下的十六进制）。' },
        newline: { type: 'boolean', description: '是否追加回车，默认 true。' },
        raw: { type: 'boolean', description: 'data 视为十六进制字节串，例如 "03"=Ctrl-C。' },
        keys: {
          type: 'array',
          items: { type: 'string' },
          description: '按键序列（与 data 二选一），例如 ["enter"]、["ctrl-c"]。支持 enter/ctrl-*/space/tab/esc/up/down/left/right。',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'serial_keys',
    description: '发送按键序列：enter、ctrl-c、ctrl-d、ctrl-z、ctrl-a、ctrl-b、ctrl-e、ctrl-l、space、tab、esc、backspace、up、down、left、right，或十六进制。',
    inputSchema: {
      type: 'object',
      properties: { keys: { type: 'array', items: { type: 'string' }, description: '按键序列。' } },
      required: ['keys'],
      additionalProperties: false,
    },
  },
  {
    name: 'serial_read',
    description:
      '读取串口缓冲中**你还没看过的新内容**（每会话独立游标）。默认含系统提示与你发的内容；只看设备输出传 direction="in"。默认只返回"当前连接"的数据，connection="all" 看全部历史。有硬上限并告知截断——截断时用返回 toSeq 续读，或改用 serial_wait。',
    inputSchema: {
      type: 'object',
      properties: {
        sinceSeq: { type: 'number', description: '从该 seq 之后读；省略则从你的游标继续。' },
        maxBytes: { type: 'number', description: '字节上限，默认 65536。' },
        maxLines: { type: 'number', description: '行数上限，默认 2000。' },
        direction: { type: 'string', description: 'in（仅设备）| out（仅发出）| all，默认 all。' },
        connection: { type: 'string', description: 'current（默认，本次连接）| all（全部历史）。' },
        stripAnsi: { type: 'boolean', description: '是否去 ANSI 转义，默认 false。' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'serial_wait',
    description:
      '等待设备输出出现匹配正则的文本（expect 语义），返回命中处附近上下文。**自动调试主力**，替代盲目轮询。典型：wait("Hit any key to stop autoboot",3000)->keys(["enter"])->wait("=> ")->write("boot")->wait("login:",60000)->wait("# ")。默认只看设备输出、只在当前连接里匹配。命中后内容算已读。',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'JavaScript 正则源码。' },
        timeoutMs: { type: 'number', description: '超时毫秒，默认 15000。' },
        sinceSeq: { type: 'number', description: '从该 seq 之后扫，默认从游标。' },
        direction: { type: 'string', description: '监听方向，默认 in。' },
        connection: { type: 'string', description: 'current（默认）| all。' },
        contextChars: { type: 'number', description: '命中处前后保留上下文字符数，默认 400。' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  {
    name: 'serial_mark',
    description: '在日志里插一条带标签的标记，便于之后引用"从某个时刻开始"的输出。',
    inputSchema: {
      type: 'object',
      properties: { label: { type: 'string', description: '标记文本，例如 "开始烧写"。' } },
      required: ['label'],
      additionalProperties: false,
    },
  },
  {
    name: 'serial_signals',
    description:
      '设置 DTR / RTS 控制线电平。CH340 复位板子：{dtr:true} 按住、{dtr:false} 释放让其重新上电。复位后应立刻 serial_expect_send 打断启动，不要 wait+write 两段。',
    inputSchema: {
      type: 'object',
      properties: { dtr: { type: 'boolean' }, rts: { type: 'boolean' } },
      additionalProperties: false,
    },
  },
  {
    name: 'serial_expect_send',
    description:
      '**原子** expect→send：等到设备输出匹配正则的**同一瞬间**立刻发出按键/数据。打断 U-Boot、以及任何"窗口几百毫秒到几秒"的时序操作必须用它——wait 再 write 会因模型往返(秒级)错过。完整流程：signals({dtr:true})→signals({dtr:false})→expect_send({pattern:"Hit any key to stop autoboot",keys:["enter"]})→wait("=> ")→write("boot")。若命中时缓冲里已有该内容说明晚了，应 DTR 复位重来而非重试。',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '正则源码；命中即发送。' },
        keys: { type: 'array', items: { type: 'string' }, description: '命中后发送的按键序列，与 data 二选一。' },
        data: { type: 'string', description: '命中后发送的文本（与 keys 二选一）；raw=true 时是十六进制。' },
        raw: { type: 'boolean' },
        newline: { type: 'boolean', description: '传 data 时是否补回车，默认 true。' },
        timeoutMs: { type: 'number', description: '超时毫秒，默认 10000。' },
        contextChars: { type: 'number', description: '命中处前后上下文字符数，默认 400。' },
        connection: { type: 'string', description: 'current（默认）| all。' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
]

/* ------------------------------------------------------------------ *
 * Server 运行主体
 * ------------------------------------------------------------------ */

/** 懒连接守护进程（首次工具调用时才拉起），MCP stdio 下串行调用足够。 */
let clientPromise = null
async function api() {
  if (!clientPromise) {
    clientPromise = ensureDaemon({ port: ipcPort(), spawnEntry: DAEMON_ENTRY }).then((client) =>
      createSerialApi(client),
    )
  }
  return clientPromise
}

/** 把一次工具调用结果包成 MCP 的 content + structuredContent。 */
function ok(payload) {
  const text = payload?.text ?? JSON.stringify(payload?.structuredContent ?? payload ?? {}, null, 2)
  return { content: [{ type: 'text', text }], structuredContent: payload?.structuredContent ?? {} }
}

/** 按工具名分派到 serial-api，并生成人话摘要。 */
async function dispatch(name, args) {
  const s = await api()
  switch (name) {
    case 'serial_status': {
      const st = await s.status()
      return ok({
        text: st.open
          ? `已打开 ${st.port} @${st.options?.baudRate}${st.virtual ? '（虚拟）' : ''}；输入权：${st.lease?.holder ?? '无'}；缓冲 seq ${st.bufferedFromSeq}..${st.seq}（${st.bufferedRecords} 条，${st.bufferedBytes} 字节）`
          : `未打开串口。可用端口见 serial_list_ports。${st.lastError ? '　上次错误：' + st.lastError : ''}`,
        structuredContent: st,
      })
    }
    case 'serial_list_ports': {
      const r = await s.listPorts()
      const list = r.ports.map((p) => `${p.path}${p.virtual ? '（虚拟）' : ''}${p.friendlyName ? ' — ' + p.friendlyName : ''}`).join('\n')
      return ok({
        text: `可用端口 ${r.ports.length} 个：\n${list}${r.warning ? '\n注意：' + r.warning : ''}`,
        structuredContent: r,
      })
    }
    case 'serial_open': {
      const st = await s.open(args)
      return ok({ text: `已打开并独占 ${args.port}${args.baudRate ? ' @' + args.baudRate : ''}。`, structuredContent: st })
    }
    case 'serial_close': {
      await s.close()
      return ok({ text: '已关闭串口，独占与输入权已释放。', structuredContent: { ok: true } })
    }
    case 'serial_write': {
      const r = await s.write(args)
      return ok({ text: `已写入 ${r.written} 字节。`, structuredContent: r })
    }
    case 'serial_keys': {
      const r = await s.write({ keys: args.keys })
      return ok({ text: `已发送按键 ${(args.keys || []).join(', ')}（共 ${r.written} 字节）。`, structuredContent: r })
    }
    case 'serial_read': {
      const r = await s.read(args)
      const header = `[seq ${r.fromSeq}..${r.toSeq} / 最新 ${r.latestSeq}；${r.recordCount} 条，${r.bytes} 字节` +
        `${r.truncated ? '；**已截断**，用 sinceSeq=' + r.toSeq + ' 续读' : ''}` +
        `${r.droppedBeforeStart ? '；**起点之前的数据已被环形缓冲丢弃**' : ''}]`
      return ok({
        text: `${header}\n${r.text.length > 0 ? r.text : '(没有新内容)'}`,
        structuredContent: r,
      })
    }
    case 'serial_wait': {
      const r = await s.wait(args)
      const text = r.matched
        ? `命中 /${r.pattern}/（"${r.match}"）。上下文：\n${r.text}`
        : r.aborted
          ? `已取消等待 /${r.pattern}/。最后读到：\n${r.text}`
          : `超时未命中 /${r.pattern}/。最后读到：\n${r.text}`
      return ok({ text, structuredContent: r })
    }
    case 'serial_mark': {
      const r = await s.mark(args.label)
      return ok({ text: `已在 seq ${r.seq} 插入标记"${r.label}"。`, structuredContent: r })
    }
    case 'serial_signals': {
      const r = await s.signals(args)
      return ok({ text: `已设置控制线：${JSON.stringify(r)}。`, structuredContent: r })
    }
    case 'serial_expect_send': {
      const r = await s.expectSend(args)
      let text
      if (!r.matched) {
        text = `超时未命中 /${r.pattern}/，未发送。最后读到：\n${r.text}`
      } else if (r.sent) {
        text = `命中 /${r.pattern}/，已**原子**发出 ${r.sentBytes} 字节。上下文：\n${r.text}`
      } else {
        text = `命中 /${r.pattern}/，但发送失败：${r.writeError ?? '未知'}。上下文：\n${r.text}`
      }
      return ok({ text, structuredContent: r })
    }
    default:
      throw new Error(`未知工具 ${name}`)
  }
}

const server = new Server(
  { name: 'serial-hub', version: '0.1.0' },
  { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params
  try {
    return await dispatch(name, args ?? {})
  } catch (error) {
    return {
      content: [{ type: 'text', text: `serial-hub 错误：${String(error?.message ?? error)}` }],
      isError: true,
      structuredContent: { error: String(error?.message ?? error) },
    }
  }
})

const transport = new StdioServerTransport()
await server.connect(transport)
console.error('[serial-hub-mcp] 已就绪，等待 AI 调用工具；首次调用会自动拉起守护进程。')

