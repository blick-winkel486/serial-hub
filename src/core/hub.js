/**
 * SerialHub —— 串口中枢。
 *
 * 这是整个插件的唯一真源：**全机只有它持有串口**，人（Web 面板 / TCP 桥）与
 * AI（serial_* 工具）都只是它的订阅者和写入者。
 *
 * 三条不变量：
 *   1. 单写者 —— 串口只被这一个对象打开（因此与 MobaXterm 天然互斥）。
 *   2. 单一真源 —— 所有字节按到达顺序进入同一个带单调 seq 的环形缓冲，
 *      所以"AI 读到的"必然等于"人看到的"。
 *   3. 可归属 —— 每条记录带 actor（human / agent / device / system），
 *      面板能显示是谁在敲，事后也能审计。
 *
 * 另外提供"消费者游标"：以不透明 consumer id（例如会话 id）为键记住上次读到
 * 的 seq，于是 `read()` 不传参就是"读我还没看过的部分"，这正是 AI 需要的手感。
 */

import { EventEmitter } from 'node:events'
import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import {
  VIRTUAL_PORT_NAME,
  listNativePorts,
  openNativeSerial,
  openVirtualSerial,
} from './transport.js'

/** 串口控制台上一条命令的默认结束符（U-Boot 与 getty 都接受 CR）。 */
const DEFAULT_TERMINATOR = '\r'

/** 一次 `wait` 内累积的扫描窗口上限，避免长时间匹配把内存拖大。 */
const MAX_SCAN_BYTES = 256 * 1024

/** 去掉 ANSI 转义序列（颜色、光标控制等），便于 AI 阅读。 */
const ANSI_PATTERN = /\u001B\[[0-9;?]*[ -/]*[@-~]|\u001B\][^\u0007]*\u0007/g

export function stripAnsi(text) {
  return text.replace(ANSI_PATTERN, '')
}

export class SerialHubError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'SerialHubError'
    this.code = code
  }
}

export class SerialHub extends EventEmitter {
  /**
   * @param {object} [config] - 中枢配置。
   * @param {number} [config.maxBufferBytes] - 环形缓冲上限（字节）。
   * @param {string|null} [config.logDir] - JSONL 落盘目录，null 关闭落盘。
   * @param {boolean} [config.enableVirtualPort] - 是否提供虚拟演示端口。
   * @param {string} [config.virtualPortName] - 虚拟端口名。
   */
  constructor(config = {}) {
    super()
    this.setMaxListeners(0)

    this.config = {
      maxBufferBytes: config.maxBufferBytes ?? 512 * 1024,
      logDir: config.logDir ?? null,
      enableVirtualPort: config.enableVirtualPort !== false,
      virtualPortName: config.virtualPortName ?? VIRTUAL_PORT_NAME,
    }

    /** 当前连接；null 表示串口未打开。 */
    this.connection = null
    /**
     * 每次 open 递增的连接序号。记录都带 `conn`，于是"这一次连接"与"上一块板子"
     * 可以被区分开：换端口/重连后，默认的 read/wait/回放只看当前连接，
     * 不会把上一块板子的输出混进来（环形缓冲本身仍然保留全部历史）。
     */
    this.connectionSeq = 0
    this.connectionId = null
    /** 环形缓冲：[{ seq, ts, dir, actor, label?, bytes, text }] */
    this.records = []
    this.bufferBytes = 0
    this.seq = 0
    /** 输入权归属：谁最后敲了键盘。 */
    this.lease = { holder: null, since: null }
    /** 每条方向的流式 UTF-8 解码器（保证多字节字符跨块不乱码）。 */
    this.decoders = { in: new TextDecoder('utf-8'), out: new TextDecoder('utf-8') }
    /** 消费者游标：consumer id -> 已读到的 seq。 */
    this.cursors = new Map()
    this.subscribers = new Set()
    this.logStream = null
    this.logFile = null
    this.lastError = null
  }

  /* ---------------------------------------------------------------- *
   * 只读视图
   * ---------------------------------------------------------------- */

  get isOpen() {
    return this.connection !== null
  }

  /** 当前状态快照（面板与 serial_status 工具共用）。 */
  status() {
    const first = this.records[0]
    return {
      open: this.isOpen,
      port: this.connection?.port ?? null,
      virtual: this.connection?.virtual ?? false,
      options: this.connection?.options ?? null,
      openedAt: this.connection?.openedAt ?? null,
      lease: { ...this.lease },
      connectionId: this.connectionId,
      connectionSeq: this.connectionSeq,
      seq: this.seq,
      bufferedBytes: this.bufferBytes,
      bufferedRecords: this.records.length,
      bufferedFromSeq: first ? first.seq : null,
      subscribers: this.subscribers.size,
      logFile: this.logFile,
      lastError: this.lastError ? String(this.lastError.message ?? this.lastError) : null,
    }
  }

  /* ---------------------------------------------------------------- *
   * 端口发现
   * ---------------------------------------------------------------- */

  /**
   * 列出可用端口。原生模块不可用时也要能工作（返回虚拟端口 + 错误说明）。
   * @returns {Promise<{ports: object[], warning: string|null}>}
   */
  async listPorts() {
    const ports = []
    let warning = null

    if (this.config.enableVirtualPort) {
      ports.push({
        path: this.config.virtualPortName,
        virtual: true,
        friendlyName: '虚拟开发板（演示 / 无硬件自测）',
        description: '带 U-Boot 倒计时与登录流程的模拟串口，用于验证面板与工具链路。',
      })
    }

    try {
      const native = await listNativePorts()
      if (native.length === 0) {
        warning = '系统当前没有检测到真实串口。请确认 USB 转串口已插好（本机历史记录里有 CH340 的 COM6 / COM8）。'
      }
      ports.push(...native)
    } catch (error) {
      warning = `无法枚举原生串口（serialport 原生模块未就绪？）：${String(error.message ?? error)}`
    }

    return { ports, warning }
  }

  /* ---------------------------------------------------------------- *
   * 打开 / 关闭
   * ---------------------------------------------------------------- */

  /**
   * 打开串口。已被占用时抛错，绝不静默接管。
   * @param {object} options - 端口参数。
   * @param {'human'|'agent'|'system'} [options.actor] - 谁在操作。
   * @returns {Promise<object>} 打开后的状态快照。
   */
  async open(options, { actor = 'agent' } = {}) {
    if (this.isOpen) {
      throw new SerialHubError(
        `串口已被占用：当前正在使用 ${this.connection.port}。需要先 serial_close 才能打开别的端口。`,
        'PORT_BUSY',
      )
    }
    const port = options.port
    if (!port) throw new SerialHubError('必须指定串口名（例如 COM6 或 /dev/ttyUSB0）。', 'NO_PORT')

    const isVirtual = this.config.enableVirtualPort && port === this.config.virtualPortName
    if (!isVirtual && !this.config.enableVirtualPort && port === this.config.virtualPortName) {
      throw new SerialHubError('虚拟端口已被配置禁用。', 'VIRTUAL_DISABLED')
    }

    const transport = isVirtual
      ? await openVirtualSerial()
      : await openNativeSerial({
          port,
          baudRate: options.baudRate,
          dataBits: options.dataBits,
          stopBits: options.stopBits,
          parity: options.parity,
          rtscts: options.rtscts,
          dtr: options.dtr,
          rts: options.rts,
        })

    this.connection = {
      id: (this.connectionId = ++this.connectionSeq),
      transport,
      port,
      virtual: isVirtual,
      openedAt: Date.now(),
      options: {
        baudRate: options.baudRate ?? 115200,
        dataBits: options.dataBits ?? 8,
        stopBits: options.stopBits ?? 1,
        parity: options.parity ?? 'none',
        rtscts: options.rtscts ?? false,
      },
    }

    this.#wireTransport(transport)
    this.#openLog(port)
    this.#claim(actor)

    this.#push({
      dir: 'system',
      actor,
      text: isVirtual
        ? `已打开虚拟演示端口 ${port}`
        : `已打开 ${port} @${this.connection.options.baudRate} ${this.connection.options.dataBits}${this.connection.options.parity[0].toUpperCase()}${this.connection.options.stopBits}`,
    })

    this.#emitState()
    return this.status()
  }

  /**
   * 关闭串口并释放输入权。
   * @param {object} [options] - 选项。
   * @returns {Promise<object>} 关闭后的状态快照。
   */
  async close({ actor = 'agent' } = {}) {
    if (!this.isOpen) return this.status()
    const { port, transport } = this.connection
    this.#push({ dir: 'system', actor, text: `正在关闭 ${port}` })
    this.connection = null
    this.lease = { holder: null, since: null }

    try {
      await transport.close()
    } catch (error) {
      this.lastError = error
    }

    this.#closeLog()
    this.#emitState()
    return this.status()
  }

  /* ---------------------------------------------------------------- *
   * 写入
   * ---------------------------------------------------------------- */

  /**
   * 向串口写入数据。
   *
   * @param {object} args - 写入参数。
   * @param {string} args.data - 文本，或 raw 模式下的十六进制字节串。
   * @param {boolean} [args.newline] - 是否追加结束符（默认 true）。
   * @param {string} [args.terminator] - 结束符，默认 '\r'。
   * @param {boolean} [args.raw] - data 视为十六进制（如 '03' 表示 Ctrl-C）。
   * @param {'human'|'agent'|'system'} [args.actor] - 谁在写。
   * @returns {Promise<object>} 写入结果。
   */
  async write(args, { actor = 'agent' } = {}) {
    if (!this.isOpen) throw new SerialHubError('串口尚未打开。先调用 serial_open。', 'NOT_OPEN')

    const buffer = buildWriteBuffer(args)
    if (buffer.length === 0) return { written: 0, seq: this.seq }

    this.#claim(actor)
    // 先记账再发出，保证缓冲里的顺序与线上顺序一致。
    const record = this.#push({ dir: 'out', actor, bytes: buffer })

    try {
      await this.connection.transport.write(buffer)
    } catch (error) {
      this.lastError = error
      this.#push({ dir: 'system', actor: 'system', text: `写入失败：${String(error.message ?? error)}` })
      throw new SerialHubError(`写入失败：${String(error.message ?? error)}`, 'WRITE_FAILED')
    }

    return { written: buffer.length, seq: record.seq }
  }

  /**
   * 设置 DTR / RTS 控制线（CH340 等靠 DTR 让板子进下载模式）。
   * @param {{dtr?: boolean, rts?: boolean}} signals - 目标电平。
   * @param {object} [options] - 选项。
   * @returns {Promise<object>} 结果。
   */
  async setSignals(signals, { actor = 'agent' } = {}) {
    if (!this.isOpen) throw new SerialHubError('串口尚未打开。', 'NOT_OPEN')
    this.#claim(actor)
    try {
      await this.connection.transport.setSignals(signals)
    } catch (error) {
      throw new SerialHubError(`设置控制线失败：${String(error.message ?? error)}`, 'SIGNAL_FAILED')
    }
    this.#push({
      dir: 'system',
      actor,
      text: `设置控制线 ${JSON.stringify(signals)}`,
    })
    return { ok: true, ...signals }
  }

  /* ---------------------------------------------------------------- *
   * 读取
   * ---------------------------------------------------------------- */

  /**
   * 读取缓冲中的增量。
   *
   * 不传 sinceSeq 时，从该 consumer 上次读到的位置继续（首次为缓冲区起点），
   * 因此 `serial_read()` 的语义是"给我我还没看过的部分"。
   *
   * @param {object} [args] - 读取参数。
   * @returns {object} 读取结果。
   */
  read(args = {}) {
    const { consumer = 'default', stripAnsi: wantStrip = false } = args
    // 默认不含 'activity'：那些是"AI 正在等什么"的面板提示，不该污染模型的读取。
    // 需要时传 direction: 'all'。
    const directions = normalizeDirections(args.direction ?? ['in', 'out', 'system', 'mark'])
    // 默认只看"当前这一次连接"的数据：换端口/重连后不会把上一块板子的输出读进来。
    // 需要看全部历史时传 connection: 'all'。
    const connection = this.#connectionFilter(args.connection)
    const maxBytes = clampInt(args.maxBytes, 64 * 1024, 64, this.config.maxBufferBytes)
    const maxLines = clampInt(args.maxLines, 2000, 1, 100000)

    const startSeq = resolveStartSeq(this, args.sinceSeq, consumer)
    const firstAvailable = this.records[0]?.seq ?? null

    const selected = []
    let bytes = 0
    let lines = 0
    let truncated = false

    // records 按 seq 严格递增，用二分直接跳到 startSeq 之后，避免每次 read
    // 都从环形缓冲头部把整段历史重新扫一遍（缓冲很大时这是主要开销）。
    let index = seqLowerBound(this.records, startSeq)
    for (; index < this.records.length; index += 1) {
      const record = this.records[index]
      if (connection !== null && record.conn !== connection) continue
      if (!directions.has(record.dir)) continue
      const size = record.bytes.length || record.text.length
      const lineCount = countLines(record.text)
      if (selected.length > 0 && (bytes + size > maxBytes || lines + lineCount > maxLines)) {
        truncated = true
        break
      }
      selected.push(record)
      bytes += size
      lines += lineCount
    }

    const lastSeq = selected.length > 0 ? selected[selected.length - 1].seq : startSeq
    this.cursors.set(consumer, lastSeq)

    let text = selected.map((record) => record.text).join('')
    if (wantStrip) text = stripAnsi(text)

    return {
      fromSeq: selected.length > 0 ? selected[0].seq : startSeq,
      toSeq: lastSeq,
      latestSeq: this.seq,
      recordCount: selected.length,
      bytes,
      lines,
      truncated,
      droppedBeforeStart: firstAvailable !== null && startSeq < firstAvailable - 1,
      text,
    }
  }

  /**
   * 等待设备输出匹配正则 —— expect 语义，AI 自动调试的灵魂工具。
   *
   * @param {object} args - 等待参数。
   * @param {string} args.pattern - 正则（字符串形式）。
   * @param {number} [args.timeoutMs] - 超时，默认 15000。
   * @param {number} [args.sinceSeq] - 从哪个 seq 之后开始扫（默认从 consumer 游标）。
   * @param {string} [args.consumer] - 消费者 id。
   * @param {string} [args.direction] - 监听的记录方向，默认 'in'（只看设备输出）。
   * @param {AbortSignal} [args.signal] - 取消信号。
   * @returns {Promise<object>} 匹配结果。
   */
  async wait(args) {
    return this.#awaitMatch(args)
  }

  /**
   * 原子 "expect → send"：命中正则的**同一个 tick** 内就把字节发出去。
   *
   * 为什么必须原子：模型每调用一次工具都有**秒级**往返延迟，而 U-Boot 的自动启动窗口
   * 通常只有 3 秒 —— "先 serial_wait 再 serial_write" 这种两次调用必然错过
   * （实测：等 wait 返回时倒计时早跑完、内核都起来了）。合并成一次调用就没有这个缝。
   *
   * 典型用法（配合 DTR 复位）：
   *   serial_signals({dtr:true})  → 按住复位
   *   serial_signals({dtr:false}) → 释放，板子重新上电
   *   serial_expect_send({pattern:'Hit any key to stop autoboot', keys:['enter']})
   *   → 停在 U-Boot 的 "=> " 提示符
   *
   * @param {object} args - 与 wait 相同，另加 payloadHex。
   * @param {string} args.payloadHex - 命中后立刻发出的字节（十六进制）。
   * @returns {Promise<object>} 等待结果，并附带 sent / sentBytes / writeError。
   */
  async expectSend(args) {
    const payload = Buffer.from(String(args.payloadHex ?? ''), 'hex')
    if (payload.length === 0) {
      throw new SerialHubError('expectSend 需要非空的 payloadHex（十六进制字节串）。', 'EMPTY_PAYLOAD')
    }
    const actor = args.actor ?? 'agent'
    let pending = null
    let writeError = null

    const result = await this.#awaitMatch({
      ...args,
      onMatch: () => {
        // 命中即发：write() 的同步段会把字节立刻交给驱动，中间没有模型往返。
        try {
          pending = this.write({ data: payload.toString('hex'), raw: true }, { actor })
          pending.catch((error) => {
            writeError = error
          })
        } catch (error) {
          writeError = error
        }
      },
    })

    if (pending) await pending.catch(() => {})
    const ok = pending !== null && writeError === null
    return {
      ...result,
      sent: ok,
      sentBytes: ok ? payload.length : 0,
      writeError: writeError ? String(writeError.message ?? writeError) : null,
    }
  }

  /** 内部实现：等待匹配（wait 与 expectSend 共用；后者用 onMatch 在同一 tick 内发送）。 */
  async #awaitMatch(args) {
    const {
      pattern,
      timeoutMs = 15_000,
      consumer = 'default',
      signal,
      contextChars = 400,
    } = args
    const directions = normalizeDirections(args.direction ?? 'in')
    // 与 read 一致：默认只在"当前连接"的输出里等，避免拿上一块板子的旧输出误命中。
    const connection = this.#connectionFilter(args.connection)

    let regex
    try {
      regex = pattern instanceof RegExp ? pattern : new RegExp(String(pattern), 'm')
    } catch (error) {
      throw new SerialHubError(`正则无效：${String(error.message ?? error)}`, 'BAD_PATTERN')
    }

    const startSeq = resolveStartSeq(this, args.sinceSeq, consumer)
    let scan = ''
    let scanTrimmed = false
    // 这几个必须在"立即命中"分支之前就存在：若缓冲里已有匹配，succeeded() 会
    // 在监听器安装之前就调用 finish()。
    let timer = null
    let onRecord = null
    let onAbort = null
    /** 防重入：onMatch 里的写入会产生新记录，可能再次触发匹配导致 finish 跑两次。 */
    let settled = false

    const collect = (record) => {
      scan += record.text
      if (scan.length > MAX_SCAN_BYTES) {
        scan = scan.slice(scan.length - MAX_SCAN_BYTES)
        scanTrimmed = true
      }
    }
    // 与 read 一致：records 按 seq 递增，用二分定位起点，跳过已读过的历史。
    let scanIndex = seqLowerBound(this.records, startSeq)
    for (; scanIndex < this.records.length; scanIndex += 1) {
      const record = this.records[scanIndex]
      if (directions.has(record.dir) && (connection === null || record.conn === connection)) {
        collect(record)
      }
    }

    const finish = (result, cursorSeq = this.seq) => {
      // 只有**命中**才推进消费者游标：命中的内容已经随结果返回，不该在后续 read
      // 里重复出现（省上下文）。超时或取消时**不消耗**缓冲，让调用方还能用
      // serial_read 把这段时间的输出完整取回。
      //
      // 注意 cursorSeq：命中回调（expectSend 的 onMatch）会写入新记录并把 this.seq
      // 推高，所以游标必须停在**命中那一刻**，否则设备随即回过来的响应会被误标成
      // "已读过"，后续 serial_wait 就永远等不到它了（真踩过）。
      if (result.matched) this.cursors.set(consumer, cursorSeq)
      if (onRecord) this.off('record', onRecord)
      if (timer) clearTimeout(timer)
      if (signal && onAbort) signal.removeEventListener('abort', onAbort)
      return result
    }

    const succeeded = (match) => {
      if (settled) return null
      settled = true
      const index = match.index ?? 0
      const from = Math.max(0, index - contextChars)
      // 命中那一刻的 seq（onMatch 里的写入会让 this.seq 前进）
      const matchedAtSeq = this.seq
      // 命中即回调：expectSend 在这里把字节发出去，仍在同一个 tick 内。
      try {
        args.onMatch?.(match)
      } catch {
        /* onMatch 自身出错不应影响等待结果的返回 */
      }
      return finish(
        {
          matched: true,
          pattern: regex.source,
          match: match[0],
          groups: match.slice(1),
          text: scan.slice(from, Math.min(scan.length, index + match[0].length + contextChars)),
          toSeq: matchedAtSeq,
          latestSeq: this.seq,
          scanTrimmed,
        },
        matchedAtSeq,
      )
    }

    const existing = regex.exec(scan)
    if (existing) return succeeded(existing)

    const result = await new Promise((resolve) => {
      onRecord = (event) => {
        if (settled) return
        if (event.record.dir === undefined || !directions.has(event.record.dir)) return
        if (connection !== null && event.record.conn !== connection) return
        collect({ text: event.record.text })
        const match = regex.exec(scan)
        if (match) {
          const outcome = succeeded(match)
          if (outcome) resolve(outcome)
        }
      }
      const onTimeout = () => {
        resolve(
          finish({
            matched: false,
            timeout: true,
            pattern: regex.source,
            text: scan.slice(-2000),
            toSeq: this.seq,
            latestSeq: this.seq,
            scanTrimmed,
          }),
        )
      }
      onAbort = () =>
        resolve(
          finish({
            matched: false,
            aborted: true,
            pattern: regex.source,
            text: scan.slice(-500),
            toSeq: this.seq,
            latestSeq: this.seq,
          }),
        )

      timer = setTimeout(onTimeout, Math.max(1, Math.min(timeoutMs, 30 * 60 * 1000)))
      this.on('record', onRecord)
      if (signal) {
        if (signal.aborted) return onAbort()
        signal.addEventListener('abort', onAbort, { once: true })
      }
      return undefined
    })

    return result
  }

  /* ---------------------------------------------------------------- *
   * 标记与订阅
   * ---------------------------------------------------------------- */

  /**
   * 广播一条"活动"记录：面板用它显示 AI 正在做什么（例如"正在等待 /login:/"）。
   * dir='activity' 的记录不进终端屏幕，只进活动栏。
   * @param {{kind: string, text: string, actor?: string}} args - 活动内容。
   * @returns {object} 记录。
   */
  announce({ kind, text, actor = 'agent' }) {
    const record = this.#push({ dir: 'activity', actor, text: `[${kind}] ${text}` })
    return { seq: record.seq, kind, text: record.text }
  }

  /**
   * 当前连接的设备输出（供面板/桥做屏幕回放）。
   * 只回放**这一次连接**的内容，避免重连后把上一块板子的画面重放出来。
   * @param {{count?: number}} [options] - 选项。
   * @returns {object[]} 序列化后的记录。
   */
  backlog({ count = 400 } = {}) {
    const connection = this.#connectionFilter('current')
    return this.records
      .filter(
        (record) =>
          record.dir === 'in' &&
          record.bytes.length > 0 &&
          (connection === null || record.conn === connection),
      )
      .slice(-count)
      .map(serializeRecord)
  }

  /**
   * 在日志里插一条标记，便于后续引用某个时间点。
   * @param {{label: string, actor?: string}} args - 标记内容。
   * @returns {object} 标记记录。
   */
  mark({ label, actor = 'agent' }) {
    const record = this.#push({ dir: 'mark', actor, text: String(label ?? '') })
    return { seq: record.seq, label: record.text, ts: record.ts }
  }

  /**
   * 订阅记录与状态变化（Web 面板 / TCP 桥用）。
   * @param {(event: object) => void} listener - 回调。
   * @returns {() => void} 取消订阅。
   */
  subscribe(listener) {
    this.subscribers.add(listener)
    this.#emitState()
    return () => {
      this.subscribers.delete(listener)
      this.#emitState()
    }
  }

  /** 释放所有资源（插件卸载时调用）。 */
  async dispose() {
    const transport = this.connection?.transport
    if (transport) {
      try {
        await transport.close()
      } catch {
        /* 忽略卸载期错误 */
      }
    }
    this.connection = null
    this.#closeLog()
    this.subscribers.clear()
    this.removeAllListeners()
  }

  /* ---------------------------------------------------------------- *
   * 内部实现
   * ---------------------------------------------------------------- */

  /**
   * 解析"看哪次连接"的过滤条件。
   *
   * - `'all'`            → null（不过滤，看全部历史）
   * - 数字               → 指定连接序号
   * - `'current'`/省略   → 当前连接的序号；若当前没打开，就用**最后一次**连接
   *                        （于是"关掉端口后再分析刚才的日志"依然可用）
   * @param {string|number|undefined} mode - 过滤模式。
   * @returns {number|null} 连接序号或 null。
   */
  #connectionFilter(mode) {
    if (mode === 'all') return null
    if (typeof mode === 'number' && Number.isFinite(mode)) return mode
    if (mode !== undefined && mode !== 'current') return null
    if (this.connectionId !== null) return this.connectionId
    return this.connectionSeq > 0 ? this.connectionSeq : null
  }

  #wireTransport(transport) {
    transport.on('data', (chunk) => {
      this.#push({ dir: 'in', actor: 'device', bytes: Buffer.from(chunk) })
    })
    transport.on('error', (error) => {
      this.lastError = error
      this.#push({ dir: 'system', actor: 'system', text: `串口错误：${String(error.message ?? error)}` })
    })
    transport.on('close', (info) => {
      if (!this.connection || this.connection.transport !== transport) return
      const reason = info?.error ? String(info.error.message ?? info.error) : '串口已关闭'
      this.connection = null
      this.lease = { holder: null, since: null }
      this.#push({ dir: 'system', actor: 'system', text: reason })
      this.#closeLog()
      this.#emitState()
    })
  }

  #push({ dir, actor = 'system', bytes = null, text = null, conn = this.connectionId }) {
    const buffer = bytes ?? Buffer.alloc(0)
    const decoded = text !== null ? text : this.decoders[dir === 'in' ? 'in' : 'out'].decode(buffer, { stream: true })
    const record = {
      seq: (this.seq += 1),
      ts: Date.now(),
      dir,
      actor,
      conn,
      bytes: buffer,
      text: decoded,
    }
    this.records.push(record)
    this.bufferBytes += buffer.length || decoded.length
    this.#trim()

    // 热路径优化：只有确实有人在听（订阅者或 'record' 事件监听）时才做
    // serializeRecord（含 base64 编码）。串口空闲时这条路径每秒可能跑很多次，
    // 无人消费时省掉这次编码能明显降低 CPU。
    if (this.subscribers.size > 0 || this.listenerCount('record') > 0) {
      const payload = serializeRecord(record)
      for (const listener of this.subscribers) {
        try {
          listener({ type: 'record', record: payload })
        } catch {
          /* 单个订阅者出错不能影响其余订阅者 */
        }
      }
      this.emit('record', { record: payload })
    }
    this.#log(record)
    return record
  }

  #trim() {
    const limit = this.config.maxBufferBytes
    while (this.bufferBytes > limit && this.records.length > 1) {
      const dropped = this.records.shift()
      this.bufferBytes -= dropped.bytes.length || dropped.text.length
    }
  }

  #claim(actor) {
    if (this.lease.holder === actor) return
    this.lease = { holder: actor, since: Date.now() }
    this.#emitState()
  }

  #emitState() {
    const state = this.status()
    for (const listener of this.subscribers) {
      try {
        listener({ type: 'state', state })
      } catch {
        /* 同上 */
      }
    }
    this.emit('state', { state })
  }

  async #openLog(port) {
    if (!this.config.logDir) return
    try {
      await mkdir(this.config.logDir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const safePort = String(port).replace(/[^A-Za-z0-9._-]/g, '_')
      this.logFile = join(this.config.logDir, `serial-${safePort}-${stamp}.jsonl`)
      this.logStream = createWriteStream(this.logFile, { flags: 'a' })
    } catch (error) {
      this.lastError = error
      this.logStream = null
      this.logFile = null
    }
  }

  #closeLog() {
    if (this.logStream) {
      try {
        this.logStream.end()
      } catch {
        /* 忽略 */
      }
    }
    this.logStream = null
  }

  #log(record) {
    if (!this.logStream) return
    try {
      this.logStream.write(`${JSON.stringify(serializeRecord(record))}\n`)
    } catch {
      /* 落盘失败不影响主链路 */
    }
  }
}

/* ------------------------------------------------------------------ *
 * 纯函数辅助
 * ------------------------------------------------------------------ */

/** 依据参数构造实际写入的字节。 */
export function buildWriteBuffer(args) {
  const terminator = args.terminator ?? DEFAULT_TERMINATOR

  // 面板直接送原始字节（控制字符、Tab 补全等），不需要文本往返。
  if (args.encoding === 'base64') {
    const buffer = Buffer.from(String(args.data ?? ''), 'base64')
    return args.newline ? Buffer.concat([buffer, Buffer.from(terminator, 'utf8')]) : buffer
  }

  if (args.raw) {
    const hex = String(args.data ?? '').replace(/[\s,]/g, '')
    if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) {
      throw new SerialHubError('raw 模式下 data 必须是偶数长度的十六进制串（例如 "03" 表示 Ctrl-C）。', 'BAD_HEX')
    }
    return Buffer.from(hex, 'hex')
  }
  const text = String(args.data ?? '')
  const suffix = args.newline === false ? '' : terminator
  return Buffer.from(text + suffix, 'utf8')
}

/** 记录 -> JSON 可传输形态（base64 保证二进制无损，text 供阅读）。 */
export function serializeRecord(record) {
  return {
    seq: record.seq,
    ts: record.ts,
    dir: record.dir,
    actor: record.actor,
    conn: record.conn ?? null,
    text: record.text,
    base64: record.bytes.length > 0 ? record.bytes.toString('base64') : null,
  }
}

function normalizeDirections(direction) {
  if (!direction || direction === 'all') return new Set(['in', 'out', 'system', 'mark', 'activity'])
  const list = Array.isArray(direction) ? direction : [direction]
  return new Set(list)
}

function resolveStartSeq(hub, sinceSeq, consumer) {
  if (typeof sinceSeq === 'number' && Number.isFinite(sinceSeq)) return sinceSeq
  return hub.cursors.get(consumer) ?? 0
}

/**
 * 在按 seq **严格递增**的 records 上二分，返回第一个 `seq > startSeq` 的下标。
 * 若全都 <= startSeq 则返回 length（表示没有更新的记录）。
 */
function seqLowerBound(records, startSeq) {
  let lo = 0
  let hi = records.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (records[mid].seq > startSeq) hi = mid
    else lo = mid + 1
  }
  return lo
}

function clampInt(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, Math.floor(number)))
}

function countLines(text) {
  if (!text) return 0
  let count = 0
  for (let index = 0; index < text.length; index += 1) if (text.charCodeAt(index) === 10) count += 1
  return count
}
