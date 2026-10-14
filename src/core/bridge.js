/**
 * 可选的 TCP / Telnet 桥 —— ser2net 式。
 *
 * 为什么需要它：串口是独占资源，同一个 COM 口不可能同时被 DSH 和 MobaXterm 打开。
 * 打开这个桥之后，串口仍然由 SerialHub 独占，而 MobaXterm（或 telnet / nc /
 * 手机上的串口 App）可以连到 127.0.0.1:<port> 当串口用 —— 于是**用户与 AI 同时在线**，
 * 甚至能同时开多个观察窗口。
 *
 * 默认关闭，只监听回环地址。
 */

import { createServer } from 'node:net'

/** Telnet 协商字节。 */
const IAC = 255
const WILL = 251
const WONT = 252
const DO = 253
const DONT = 254

/**
 * 启动桥接服务器。
 * @param {import('./hub.js').SerialHub} hub - 串口中枢。
 * @param {{host: string, port: number, mode: 'raw'|'telnet', allowWrite: boolean}} options - 桥配置。
 * @param {{report?: (message: string) => void}} [hooks] - 回调。
 * @returns {() => void} 关闭函数。
 */
export function startSerialBridge(hub, options, hooks = {}) {
  const report = hooks.report ?? (() => {})
  const mode = options.mode ?? 'telnet'
  const allowWrite = options.allowWrite !== false
  const sockets = new Set()

  const server = createServer((socket) => {
    sockets.add(socket)
    socket.setNoDelay(true)

    // 先补上当前屏幕的最后一段（只补**当前连接**的），便于 telnet 客户端立刻看到上下文。
    // 刻意不用 hub.read()：那会推进消费者游标，等于"替 AI 读了"。
    for (const record of hub.backlog({ count: 200 })) {
      const bytes = Buffer.from(record.base64 ?? '', 'base64')
      if (bytes.length === 0) continue
      socket.write(mode === 'telnet' ? escapeTelnet(bytes) : bytes)
    }

    const unsubscribe = hub.subscribe((event) => {
      if (event.type !== 'record') return
      if (event.record.dir !== 'in') return
      const chunk = event.record.base64
        ? Buffer.from(event.record.base64, 'base64')
        : Buffer.from(event.record.text, 'utf8')
      socket.write(mode === 'telnet' ? escapeTelnet(chunk) : chunk)
    })

    socket.on('data', (chunk) => {
      if (!allowWrite) return
      const payload = mode === 'telnet' ? stripTelnetNegotiation(chunk, socket) : chunk
      if (payload.length === 0) return
      // 桥上的写入视为"人"的操作，面板上会显示是人抢了输入权。
      void hub
        .write({ data: payload.toString('hex'), raw: true }, { actor: 'human' })
        .catch((error) => report(`桥写入失败：${String(error?.message ?? error)}`))
    })

    const cleanup = () => {
      unsubscribe()
      sockets.delete(socket)
    }
    socket.on('close', cleanup)
    socket.on('error', cleanup)
  })

  server.on('error', (error) => report(`TCP 桥错误：${String(error?.message ?? error)}`))

  server.listen(options.port, options.host, () => {
    const address = server.address()
    const actualPort = typeof address === 'object' && address !== null ? address.port : options.port
    options.onListening?.(actualPort)
    report(
      `TCP/Telnet 桥已监听 ${options.host}:${actualPort}（模式 ${mode}）—— `
      + `可用 MobaXterm 的 Telnet 会话连它当串口用，与 AI 同时在线。`,
    )
  })

  return () => {
    for (const socket of sockets) socket.destroy()
    sockets.clear()
    server.close()
  }
}

/** 把裸字节转义成 telnet 安全的形式（0xFF 需要双写）。 */
function escapeTelnet(buffer) {
  const out = []
  for (const byte of buffer) {
    out.push(byte)
    if (byte === IAC) out.push(IAC)
  }
  return Buffer.from(out)
}

/**
 * 去掉客户端发来的 telnet 协商，并对所有选项回复"拒绝"。
 * 这样 MobaXterm / telnet 不会因为等不到应答而卡住。
 * @param {Buffer} chunk - 收到的字节。
 * @param {import('node:net').Socket} socket - 用于回写协商应答。
 * @returns {Buffer} 纯数据部分。
 */
function stripTelnetNegotiation(chunk, socket) {
  const out = []
  for (let index = 0; index < chunk.length; index += 1) {
    const byte = chunk[index]
    if (byte !== IAC) {
      out.push(byte)
      continue
    }
    const command = chunk[index + 1]
    if (command === undefined) break
    if (command === IAC) {
      out.push(IAC) // 转义后的 0xFF 是真实数据
      index += 1
      continue
    }
    if (command === WILL || command === DO || command === WONT || command === DONT) {
      const option = chunk[index + 2]
      if (command === WILL) socket.write(Buffer.from([IAC, DONT, option ?? 0]))
      else if (command === DO) socket.write(Buffer.from([IAC, WONT, option ?? 0]))
      index += 2
      continue
    }
    // 其余单字节命令（如 GA、NOP）直接丢弃
    index += 1
  }
  return Buffer.from(out)
}
