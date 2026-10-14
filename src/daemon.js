/**
 * serial-hub 守护进程 —— 整个工具的核心。
 *
 * 职责：
 *   1. 持有**唯一**的 SerialHub（串口只被它打开一次）——这是"单一真源"，
 *      人类面板、MCP、CLI、TCP 桥都只是它的订阅者/写入者。
 *   2. 控制 IPC（本地 TCP，换行 JSON）：MCP Server 与 CLI 通过它调 read/write/
 *      wait/expectSend 等，游标以 consumer 为键存在这里。
 *   3. 人类 Web 控制台（xterm 面板 + REST + WS）。
 *   4. 可选 ser2net 式 TCP/Telnet 桥（SERIAL_HUB_BRIDGE_PORT>0 时开启）。
 *
 * 运行：node src/daemon.js   （或 npm run daemon，或 serial-hub）
 */

import { createServer } from 'node:net'

import { SerialHub } from './core/hub.js'
import { startSerialBridge } from './core/bridge.js'
import { startConsole } from './console-http.js'
import { IPC_HOST, WEB_HOST, ipcPort, webPort, bridgePort } from './config.js'

const log = (...args) => console.log('[serial-hub]', ...args)

export function createDaemon(options = {}) {
  const hub = new SerialHub({
    maxBufferBytes: options.maxBufferBytes ?? 512 * 1024,
    logDir: options.logDir ?? null,
    enableVirtualPort: options.enableVirtualPort !== false,
    virtualPortName: options.virtualPortName,
  })

  /** 已订阅 record/state 推送的 IPC 连接集合。 */
  const subscribers = new Set()
  const broadcast = (message) => {
    const line = `${JSON.stringify(message)}\n`
    for (const socket of subscribers) {
      if (!socket.destroyed) socket.write(line)
    }
  }
  hub.subscribe((event) => {
    if (event.type === 'record') broadcast({ type: 'record', record: event.record })
    else if (event.type === 'state') broadcast({ type: 'state', state: event.state })
  })

  const ipc = createServer((socket) => handleIpcSocket(socket, hub, subscribers))
  const consoleHandle = startConsole(hub, {
    port: options.webPort ?? webPort(),
    host: options.webHost ?? WEB_HOST,
    defaultPort: options.defaultPort ?? null,
    defaultBaudRate: options.defaultBaudRate ?? 115200,
  })

  let bridge = null
  const bport = options.bridgePort ?? bridgePort()
  if (bport > 0) {
    bridge = startSerialBridge(hub, { host: '127.0.0.1', port: bport, mode: 'telnet', allowWrite: true }, { report: (m) => log(m) })
  }

  return {
    hub,
    ipc,
    console: consoleHandle,
    async listen(port) {
      await new Promise((resolve) => ipc.listen(port, IPC_HOST, resolve))
      log(`控制 IPC 已监听 ${IPC_HOST}:${port}`)
      log(`人类 Web 控制台：http://127.0.0.1:${options.webPort ?? webPort()}/serial/`)
      if (bridge) log(`TCP/Telnet 桥已开启：127.0.0.1:${bport}`)
      log('串口尚未打开，等待面板或 AI 打开。')
    },
    async close() {
      for (const socket of subscribers) {
        try {
          socket.destroy()
        } catch {
          /* 忽略 */
        }
      }
      subscribers.clear()
      bridge?.()
      consoleHandle.close()
      ipc.close()
      await hub.dispose()
    },
  }
}

/** 处理一个 IPC 连接：换行 JSON，请求/响应 + 可选订阅推送。 */
function handleIpcSocket(socket, hub, subscribers) {
  let buffer = ''

  const respond = (id, ok, resultOrError) => {
    if (socket.destroyed) return
    const payload = ok ? { id, ok: true, result: resultOrError } : { id, ok: false, error: String(resultOrError) }
    socket.write(`${JSON.stringify(payload)}\n`)
  }

  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (line.trim().length === 0) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      if (!message || typeof message.method !== 'string') continue
      if (message.method === 'subscribe') {
        subscribers.add(socket)
        socket.on('close', () => subscribers.delete(socket))
        socket.on('error', () => subscribers.delete(socket))
        respond(message.id, true, { ok: true })
        continue
      }
      handleMethod(hub, message.method, message.params ?? {})
        .then((result) => respond(message.id, true, result))
        .catch((error) => respond(message.id, false, error?.message ?? error))
    }
  })

  socket.on('error', () => {
    /* 连接断开由 close/error 清理 */
  })
}

/** 方法分发：把 IPC 调用映射到 hub 操作。 */
async function handleMethod(hub, method, params) {
  const actor = params.actor || 'agent'
  switch (method) {
    case 'status':
      return hub.status()
    case 'listPorts':
      return hub.listPorts()
    case 'backlog':
      return hub.backlog(params.options ?? {})
    case 'open':
      await hub.open(params.options ?? {}, { actor })
      return hub.status()
    case 'close':
      await hub.close({ actor })
      return { ok: true }
    case 'write':
      return hub.write(params.args ?? {}, { actor })
    case 'read':
      // consumer 已在 args 内（serial-api 注入）；hub.read 只接受一个 args 参数。
      return hub.read(params.args ?? {})
    case 'wait':
      return hub.wait(params.args ?? {})
    case 'expectSend':
      return hub.expectSend(params.args ?? {})
    case 'signals':
      await hub.setSignals(params.signals ?? {}, { actor })
      return { ok: true }
    case 'announce':
      return hub.announce(params.args ?? { kind: 'activity', text: '', actor })
    case 'mark':
      return hub.mark(params.args ?? { label: '', actor })
    default:
      throw new Error(`未知方法 ${method}`)
  }
}

// ------------------------------------------------------------------ *
// 前台运行（被 node src/daemon.js 直接执行、或被 bin/serial-hub.js 调用时）
// ------------------------------------------------------------------ *
import { pathToFileURL } from 'node:url'

/**
 * 前台启动守护进程：监听 IPC + Web 控制台（+ 可选桥），并挂上优雅退出。
 * 被 bat / 手动 `node src/daemon.js` 启动时走这里。
 */
export function runForeground() {
  const daemon = createDaemon()
  daemon.listen(ipcPort()).catch((error) => {
    console.error('[serial-hub] 启动失败：', error)
    process.exit(1)
  })

  let closing = false
  const shutdown = async (signal) => {
    if (closing) return
    closing = true
    console.log(`[serial-hub] 收到 ${signal}，正在停止…`)
    try {
      await daemon.close()
    } catch {
      /* 关闭期错误忽略 */
    }
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

// 只有"被当作脚本直接执行"时才自启动；被 import（例如上面的 bin 入口）时
// 绝不能自启，否则会产生双重守护进程。
// 用 pathToFileURL 把 Windows 反斜杠路径正确转成 file:// URL 再比较 import.meta.url。
const invokedDirectly =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  runForeground()
}

