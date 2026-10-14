/**
 * console-http —— 人类用的 Web 串口控制台（原生 node:http + ws，不依赖任何宿主）。
 *
 * 路由（页面以 /serial/ 为根，端点全部相对解析）：
 *   GET  /serial/                → xterm 控制台页面（复用 core/console-page.js）
 *   GET  /serial/api/status      → hub.status()
 *   GET  /serial/api/ports       → hub.listPorts()
 *   POST /serial/api/open        → hub.open(...)
 *   POST /serial/api/close       → hub.close(...)
 *   POST /serial/api/write       → hub.write(...)
 *   POST /serial/api/signals     → hub.setSignals(...)
 *   WS   /serial/ws              → 实时 record/state 流 + 真人输入
 *   GET  /serial/vendor/xterm.*  → 静态资源（来自 node_modules/@xterm/xterm）
 *
 * 所有 /serial/api/* 都过信任围栏（回环/受信 host + 同源标记），防跨站与 DNS-rebinding。
 */

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'

import { renderConsolePage } from './core/console-page.js'
import { isTrustedApiRequest } from './core/trust-fence.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = join(HERE, '..')

const VENDOR_FILES = new Map([
  ['xterm.js', ['node_modules', '@xterm', 'xterm', 'lib', 'xterm.js']],
  ['xterm.css', ['node_modules', '@xterm', 'xterm', 'css', 'xterm.css']],
])

const BACKLOG_RECORDS = 400

/**
 * 启动 Web 控制台。
 * @param {import('./core/hub.js').SerialHub} hub
 * @param {{port: number, host?: string, defaultPort?: string|null, defaultBaudRate?: number, trustedHosts?: string[]}} options
 */
export function startConsole(hub, options) {
  const host = options.host ?? '0.0.0.0'
  const trusted = options.trustedHosts ?? []

  const server = createServer((req, res) => {
    handleHttp(hub, req, res, trusted, options).catch((error) => {
      sendJson(res, 500, { error: String(error?.message ?? error) })
    })
  })

  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    if (url.pathname !== '/serial/ws') {
      socket.destroy()
      return
    }
    if (!isTrustedApiRequest(req, trusted)) {
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => attachSocket(ws, hub))
  })

  server.listen(options.port, host)

  return {
    server,
    close: () => {
      for (const client of wss.clients) {
        try {
          client.terminate()
        } catch {
          /* 忽略 */
        }
      }
      try {
        wss.close()
      } catch {
        /* 忽略 */
      }
      server.close()
    },
  }
}

async function handleHttp(hub, req, res, trusted, options) {
  const url = new URL(req.url ?? '/', 'http://dsh.internal')
  const path = url.pathname

  // 页面本体
  if (req.method === 'GET' && (path === '/serial' || path === '/serial/')) {
    const html = renderConsolePage({
      defaultPort: options.defaultPort ?? null,
      defaultBaudRate: options.defaultBaudRate ?? 115200,
    })
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' })
    res.end(html)
    return
  }

  // 静态资源
  if (req.method === 'GET' && path.startsWith('/serial/vendor/')) {
    const name = normalize(path.replace('/serial/vendor/', '')).replace(/^[/\\.]+/, '')
    const parts = VENDOR_FILES.get(name)
    if (!parts) return sendJson(res, 404, { error: '未知资源' })
    try {
      const body = await readFile(join(PACKAGE_ROOT, ...parts))
      const type = name.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/javascript; charset=utf-8'
      res.writeHead(200, { 'content-type': type, 'cache-control': 'public, max-age=3600' })
      res.end(body)
    } catch {
      sendJson(res, 404, { error: '资源未安装（是否 npm install？）' })
    }
    return
  }

  // REST API
  if (path.startsWith('/serial/api/')) {
    if (!isTrustedApiRequest(req, trusted)) return sendJson(res, 403, { error: 'forbidden' })
    const route = path.replace(/^\/serial\/api\/?/, '')
    try {
      if (req.method === 'GET' && (route === 'status' || route === '')) {
        return sendJson(res, 200, hub.status())
      }
      if (req.method === 'GET' && route === 'ports') {
        return sendJson(res, 200, await hub.listPorts())
      }
      if (req.method === 'POST' && route === 'open') {
        const body = await readJsonBody(req)
        const opened = await hub.open(body ?? {}, { actor: 'human' })
        return sendJson(res, 200, opened ?? { ok: true })
      }
      if (req.method === 'POST' && route === 'close') {
        await hub.close({ actor: 'human' })
        return sendJson(res, 200, { ok: true })
      }
      if (req.method === 'POST' && route === 'write') {
        const body = await readJsonBody(req)
        const written = await hub.write(
          { data: body?.data, encoding: body?.encoding, raw: body?.raw, newline: body?.newline },
          { actor: 'human' },
        )
        return sendJson(res, 200, written ?? { ok: true })
      }
      if (req.method === 'POST' && route === 'signals') {
        const body = await readJsonBody(req)
        await hub.setSignals({ dtr: body?.dtr, rts: body?.rts }, { actor: 'human' })
        return sendJson(res, 200, { ok: true })
      }
      return sendJson(res, 404, { error: `未知接口 ${route}` })
    } catch (error) {
      return sendJson(res, 400, { error: String(error?.message ?? error) })
    }
  }

  sendJson(res, 404, { error: 'not found' })
}

/** 一个面板连接：先回放屏幕，再转发增量，并接受真人输入。 */
function attachSocket(ws, hub) {
  const backlog = hub.backlog({ count: BACKLOG_RECORDS })
  send(ws, { type: 'hello', state: hub.status(), backlog })

  const unsubscribe = hub.subscribe((event) => {
    if (event.type === 'record') send(ws, { type: 'record', record: event.record })
    else if (event.type === 'state') send(ws, { type: 'state', state: event.state })
  })

  const heartbeat = setInterval(() => {
    if (ws.readyState === 1) ws.ping?.()
  }, 30_000)

  ws.on('message', (raw) => {
    let message
    try {
      message = JSON.parse(String(raw))
    } catch {
      return
    }
    const fail = (error) => send(ws, { type: 'error', error: String(error?.message ?? error) })
    switch (message?.type) {
      case 'write':
        void hub
          .write(
            { data: message.data, encoding: message.encoding, raw: message.raw, newline: message.newline },
            { actor: 'human' },
          )
          .catch(fail)
        break
      case 'open':
        void hub.open(message.options ?? {}, { actor: 'human' }).catch(fail)
        break
      case 'close':
        void hub.close({ actor: 'human' }).catch(fail)
        break
      case 'signals':
        void hub.setSignals({ dtr: message.dtr, rts: message.rts }, { actor: 'human' }).catch(fail)
        break
      default:
        break
    }
  })

  const cleanup = () => {
    clearInterval(heartbeat)
    unsubscribe()
  }
  ws.on('close', cleanup)
  ws.on('error', cleanup)
}

function send(ws, payload) {
  if (ws.readyState === 1) ws.send(JSON.stringify(payload))
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload ?? {})
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
  res.end(body)
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 1024 * 1024) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(new Error(`请求体不是合法 JSON：${String(error.message)}`))
      }
    })
    req.on('error', reject)
  })
}

