/**
 * DaemonClient —— 守护进程控制 IPC 的客户端。
 *
 * 传输：本地 TCP（仅 127.0.0.1），**换行分隔的 JSON**（每条消息一行）。
 *   - 请求：`{ id, method, params }`
 *   - 响应：`{ id, ok: true, result }` 或 `{ id, ok: false, error }`
 *   - 推送（仅订阅者收到）：`{ type: 'record', record }` / `{ type: 'state', state }`
 *
 * 每个客户端连接自带一个 consumer id（默认随机 uuid），read/wait/expectSend 的
 * 读取游标以它为键存在守护进程里 —— 于是"每个 AI 会话读到的是自己还没看过的部分"。
 */

import net from 'node:net'

import { IPC_HOST } from './config.js'

export class DaemonError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'DaemonError'
    this.code = code
  }
}

export class DaemonClient {
  /**
   * @param {{host?: string, port: number, consumer?: string}} options
   */
  constructor({ host = IPC_HOST, port, consumer } = {}) {
    this.host = host
    this.port = port
    this.consumer = consumer ?? randomConsumer()
    this._socket = null
    this._buffer = ''
    this._nextId = 1
    this._pending = new Map()
    this._subscribers = new Set()
    this.connected = false
  }

  connect() {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: this.host, port: this.port })
      const onConnectError = (error) => {
        if (!this.connected) reject(error)
      }
      socket.once('connect', () => {
        this._socket = socket
        this.connected = true
        resolve()
      })
      socket.once('error', onConnectError)
      socket.on('data', (chunk) => this._onData(chunk))
      socket.on('error', () => this._failAll(new DaemonError('与守护进程的连接出错')))
      socket.on('close', () => {
        this.connected = false
        this._failAll(new DaemonError('与守护进程的连接已断开'))
      })
    })
  }

  _onData(chunk) {
    this._buffer += chunk.toString('utf8')
    let index
    while ((index = this._buffer.indexOf('\n')) >= 0) {
      const line = this._buffer.slice(0, index)
      this._buffer = this._buffer.slice(index + 1)
      if (line.trim().length === 0) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      this._dispatch(message)
    }
  }

  _dispatch(message) {
    if (message && message.id != null && this._pending.has(message.id)) {
      const { resolve, reject } = this._pending.get(message.id)
      this._pending.delete(message.id)
      if (message.ok) resolve(message.result)
      else reject(new DaemonError(message.error ?? '未知错误'))
      return
    }
    if (message && (message.type === 'record' || message.type === 'state')) {
      for (const listener of this._subscribers) {
        try {
          listener(message)
        } catch {
          /* 单个订阅者出错不影响其余 */
        }
      }
    }
  }

  /**
   * 调用一个守护进程方法。
   * @param {string} method - 方法名。
   * @param {object} [params] - 参数（自动并入 consumer）。
   */
  call(method, params = {}) {
    if (!this._socket || !this.connected) {
      return Promise.reject(new DaemonError('未连接到守护进程，请先 connect()'))
    }
    const id = this._nextId
    this._nextId += 1
    const wire = JSON.stringify({ id, method, params: { ...params, consumer: this.consumer } })
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject })
      this._socket.write(`${wire}\n`, (error) => {
        if (error) {
          this._pending.delete(id)
          reject(error)
        }
      })
    })
  }

  /** 订阅实时 record/state 推送（可选，用于流式查看）。 */
  subscribe(listener) {
    this._subscribers.add(listener)
    void this.call('subscribe').catch(() => {})
    return () => this._subscribers.delete(listener)
  }

  close() {
    try {
      this._socket?.destroy()
    } catch {
      /* 忽略 */
    }
    this.connected = false
  }

  _failAll(error) {
    for (const { reject } of this._pending.values()) reject(error)
    this._pending.clear()
  }
}

function randomConsumer() {
  const rand = Math.random().toString(36).slice(2, 10)
  return `c-${Date.now().toString(36)}-${rand}`
}

/**
 * 确保守护进程在运行：先尝试连接，连不上就**后台拉起一个**（detached，长期存活，
 * 可被多个 AI 同时连接）。
 * @param {object} options
 * @returns {Promise<DaemonClient>} 已连接的客户端。
 */
export async function ensureDaemon({ host = IPC_HOST, port, webPort, spawnEntry }) {
  const client = new DaemonClient({ host, port })
  try {
    await client.connect()
    return client
  } catch {
    /* 没在跑，尝试拉起 */
  }

  if (spawnEntry) {
    const { spawn } = await import('node:child_process')
    const child = spawn(process.execPath, [spawnEntry], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: {
        ...process.env,
        SERIAL_HUB_PORT: String(port),
        ...(webPort != null ? { SERIAL_HUB_WEB_PORT: String(webPort) } : {}),
      },
    })
    child.unref()
  }

  const deadline = Date.now() + 8000
  let lastError
  while (Date.now() < deadline) {
    try {
      await client.connect()
      return client
    } catch (error) {
      lastError = error
      await new Promise((r) => setTimeout(r, 120))
    }
  }
  throw new DaemonError(`守护进程启动超时：${String(lastError?.message ?? lastError)}`)
}
