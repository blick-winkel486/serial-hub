#!/usr/bin/env node
/**
 * serialctl —— serial-hub 的命令行客户端（零接入方案）。
 *
 * 给"只能执行 shell 命令"的 AI 用：它调 serialctl 的各子命令即可操作串口，
 * 与 MCP、Web 面板共用同一个守护进程。也可人工用于快速调试。
 *
 * 用法：
 *   serialctl status                    当前状态
 *   serialctl ports                     列出端口（含 VIRTUAL）
 *   serialctl open VIRTUAL              打开端口
 *   serialctl close                     关闭
 *   serialctl send "ls -l"              发一行（自动补回车）
 *   serialctl send --raw "03"           发十六进制（Ctrl-C）
 *   serialctl keys enter                发按键（enter/ctrl-c/...）
 *   serialctl read [--dir in]           读"我还没看过的新内容"
 *   serialctl wait "login:" --timeout 60000   等提示符
 *   serialctl expect-send --pattern "Hit any key" --keys enter
 *   serialctl signals --dtr false       DTR 电平（复位板子用）
 *   serialctl mark "开始烧写"            插标记
 */

import { ensureDaemon } from '../src/client.js'
import { createSerialApi, formatRead } from '../src/serial-api.js'
import { ipcPort } from '../src/config.js'
import { fileURLToPath } from 'node:url'

const DAEMON_ENTRY = fileURLToPath(new URL('../src/daemon.js', import.meta.url))

function parseArgs(argv) {
  const out = { _: [], flags: {} }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) {
        out.flags[key] = true
      } else {
        out.flags[key] = next
        i += 1
      }
    } else {
      out._.push(a)
    }
  }
  return out
}

function num(value) {
  if (value === undefined || value === true) return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

async function main() {
  const { _, flags } = parseArgs(process.argv.slice(2))
  const command = _[0]

  const client = await ensureDaemon({ port: ipcPort(), spawnEntry: DAEMON_ENTRY })
  const api = createSerialApi(client)

  switch (command) {
    case 'status': {
      const st = await api.status()
      console.log(st.open
        ? `已打开 ${st.port} @${st.options?.baudRate}${st.virtual ? '（虚拟）' : ''}｜输入权：${st.lease?.holder ?? '无'}｜缓冲 seq ${st.bufferedFromSeq}..${st.seq}`
        : `未打开串口${st.lastError ? '｜上次错误：' + st.lastError : ''}`)
      break
    }
    case 'ports': {
      const r = await api.listPorts()
      for (const p of r.ports) console.log(`${p.path}${p.virtual ? '（虚拟）' : ''}${p.friendlyName ? ' — ' + p.friendlyName : ''}`)
      if (r.warning) console.error('注意：' + r.warning)
      break
    }
    case 'open': {
      const port = _[1]
      if (!port) throw new Error('用法：serialctl open <port> [--baud 115200]')
      await api.open({ port, baudRate: num(flags.baud) })
      console.log(`已打开并独占 ${port}`)
      break
    }
    case 'close':
      await api.close()
      console.log('已关闭串口')
      break
    case 'send': {
      const data = _.slice(1).join(' ') || flags.data
      const r = await api.write({ data, raw: !!flags.raw, newline: flags.newline !== false })
      console.log(`已写入 ${r.written} 字节`)
      break
    }
    case 'keys': {
      const keys = _.slice(1)
      if (keys.length === 0) throw new Error('用法：serialctl keys <enter|ctrl-c|...>')
      const r = await api.write({ keys })
      console.log(`已发送按键 ${keys.join(', ')}（共 ${r.written} 字节）`)
      break
    }
    case 'read': {
      const r = await api.read({
        sinceSeq: num(flags.since),
        maxBytes: num(flags.bytes),
        maxLines: num(flags.lines),
        direction: typeof flags.dir === 'string' ? flags.dir : undefined,
        connection: typeof flags.connection === 'string' ? flags.connection : undefined,
        stripAnsi: !!flags['strip-ansi'],
      })
      console.log(formatRead(r))
      break
    }
    case 'wait': {
      const pattern = _.slice(1).join(' ') || flags.pattern
      if (!pattern) throw new Error('用法：serialctl wait "<regex>" [--timeout 15000]')
      const r = await api.wait({ pattern, timeoutMs: num(flags.timeout) })
      console.log(r.matched ? `命中 /${r.pattern}/（"${r.match}"）` : `超时/取消未命中 /${r.pattern}/`)
      if (r.text) console.log(r.text)
      process.exitCode = r.matched ? 0 : 1
      break
    }
    case 'expect-send': {
      const pattern = flags.pattern || _[1]
      if (!pattern) throw new Error('用法：serialctl expect-send --pattern "<regex>" [--keys enter] [--data "cmd"] [--raw]')
      const keys = typeof flags.keys === 'string' ? flags.keys.split(',') : undefined
      const r = await api.expectSend({
        pattern,
        keys,
        data: typeof flags.data === 'string' ? flags.data : undefined,
        raw: !!flags.raw,
        timeoutMs: num(flags.timeout),
      })
      console.log(r.matched
        ? (r.sent ? `命中 /${r.pattern}/，已原子发出 ${r.sentBytes} 字节` : `命中但发送失败：${r.writeError}`)
        : `超时未命中 /${r.pattern}/，未发送`)
      if (r.text) console.log(r.text)
      process.exitCode = r.matched && r.sent ? 0 : 1
      break
    }
    case 'signals': {
      const signals = {}
      if (flags.dtr !== undefined) signals.dtr = String(flags.dtr) === 'true'
      if (flags.rts !== undefined) signals.rts = String(flags.rts) === 'true'
      const r = await api.signals(signals)
      console.log('已设置控制线：' + JSON.stringify(r))
      break
    }
    case 'mark': {
      const label = _.slice(1).join(' ') || flags.label
      const r = await api.mark(label)
      console.log(`已在 seq ${r.seq} 插入标记"${r.label}"`)
      break
    }
    default:
      console.error('未知命令，可用：status ports open close send keys read wait expect-send signals mark')
      process.exitCode = 2
  }

  client.close()
}

main().catch((error) => {
  console.error('serialctl 错误：' + String(error?.message ?? error))
  process.exit(1)
})

