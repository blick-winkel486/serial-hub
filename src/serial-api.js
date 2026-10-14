/**
 * serial-api —— 把 DaemonClient 包成高层串口操作，MCP 与 CLI 共用。
 *
 * 与 hub 精确对齐的要点（hub 的确切签名见 core/hub.js）：
 *   - read/wait/expectSend 的 consumer 放在 **args 内**（不是第二参）；这里统一
 *     用 client.consumer 注入，于是"每个会话读到的是自己还没看过的部分"。
 *   - read 参数：sinceSeq / maxBytes / maxLines / direction('in'|'out'|'all') /
 *     connection('current'|'all') / stripAnsi；结果字段 recordCount/bytes/fromSeq/... 。
 *   - write 返回 {written, seq}；raw 只认十六进制，按键名先用 keys.js 翻译。
 *   - expectSend 接收 payloadHex（十六进制），结果含 sent/sentBytes/writeError。
 */

import { buildWriteBuffer, keyToBuffer } from './keys.js'

export function createSerialApi(client) {
  const consumer = () => client.consumer

  return {
    status: () => client.call('status'),
    listPorts: () => client.call('listPorts'),
    backlog: (options) => client.call('backlog', { options }),

    open: (options) => client.call('open', { options, actor: 'agent' }),
    close: () => client.call('close', { actor: 'agent' }),

    /** 发送文本或 raw 十六进制；支持按键名序列。返回 {written, seq}。 */
    write: ({ data, newline = true, raw = false, encoding, keys } = {}) => {
      if (Array.isArray(keys) && keys.length > 0) {
        // 逐键发送：每个按键独立一条记录，便于面板逐条显示。
        return (async () => {
          let written = 0
          let seq = 0
          for (const key of keys) {
            const r = await client.call('write', {
              args: { data: keyToBuffer(key).toString('hex'), raw: true },
              actor: 'agent',
            })
            written += r.written ?? 0
            seq = r.seq
          }
          return { written, seq, keys: keys.length }
        })()
      }
      const buffer = buildWriteBuffer({ data, raw, newline })
      const args = raw
        ? { data: buffer.toString('hex'), raw: true }
        : encoding
          ? { data: buffer.toString('base64'), encoding: 'base64' }
          : { data, newline }
      return client.call('write', { args, actor: 'agent' })
    },

    /** 读取"我还没看过的新内容"。 */
    read: ({ sinceSeq, maxBytes, maxLines, direction, connection, stripAnsi } = {}) =>
      client.call('read', {
        args: { sinceSeq, maxBytes, maxLines, direction, connection, stripAnsi, consumer: consumer() },
      }),

    /** expect 语义：等待设备输出匹配正则。 */
    wait: ({ pattern, timeoutMs, sinceSeq, direction, connection, contextChars } = {}) =>
      client.call('wait', {
        args: { pattern, timeoutMs, sinceSeq, direction, connection, contextChars, consumer: consumer() },
      }),

    /** 原子 expect→send：命中即发。payload 由 keys 或 data/raw 组装成十六进制。 */
    expectSend: ({ pattern, keys, data, raw, newline = true, timeoutMs, contextChars, connection } = {}) => {
      let payload
      if (Array.isArray(keys) && keys.length > 0) {
        payload = Buffer.concat(keys.map(keyToBuffer))
      } else {
        payload = buildWriteBuffer({ data, raw, newline })
      }
      if (payload.length === 0) {
        return Promise.reject(new Error('expect-send 需要 keys 或 data 之一作为命中后要发送的内容。'))
      }
      return client.call('expectSend', {
        args: {
          pattern,
          payloadHex: payload.toString('hex'),
          timeoutMs,
          contextChars,
          connection,
          consumer: consumer(),
        },
      })
    },

    signals: (signals) => client.call('signals', { signals, actor: 'agent' }),

    mark: (label) => client.call('mark', { args: { label }, actor: 'agent' }),
    announce: (kind, text) => client.call('announce', { args: { kind, text }, actor: 'agent' }),
  }
}

/** 给 CLI 的便捷：把 read 结果格式化成可读文本（字段对齐 hub）。 */
export function formatRead(result) {
  const head = `seq ${result.fromSeq}→${result.toSeq}｜最新 ${result.latestSeq}｜${result.recordCount} 条｜${result.bytes} 字节`
  const flags = []
  if (result.truncated) flags.push('已按上限截断，可用 --since ' + result.toSeq + ' 续读')
  if (result.droppedBeforeStart) flags.push('起点之前的记录已被环形缓冲挤出')
  const meta = flags.length ? `（${flags.join('；')}）` : ''
  return `${head}${meta}\n${result.text || '(无新增输出)'}`
}
