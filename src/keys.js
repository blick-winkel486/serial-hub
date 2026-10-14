/**
 * keys —— 按键名/文本 → 实际字节的构建（与 DSH 原插件 tools.js 的 keyToBuffer 一致）。
 *
 * hub.write 只认十六进制（raw）或文本，按键名（enter/ctrl-c/...）必须在这里先翻译
 * 成字节，再交给 hub。read/wait/expectSend 的 consumer 注入、以及 expectSend 的
 * payloadHex 组装，都在 serial-api 里统一处理，保持 MCP 与 CLI 语义一致。
 */

import { buildWriteBuffer } from './core/hub.js'

export { buildWriteBuffer }

const NAMED = {
  enter: [0x0d],
  'ctrl-c': [0x03],
  'ctrl-d': [0x04],
  'ctrl-z': [0x1a],
  'ctrl-x': [0x18],
  'ctrl-a': [0x01],
  'ctrl-b': [0x02],
  'ctrl-e': [0x05],
  'ctrl-l': [0x0c],
  space: [0x20],
  tab: [0x09],
  esc: [0x1b],
  backspace: [0x7f],
  up: [0x1b, 0x5b, 0x41],
  down: [0x1b, 0x5b, 0x42],
  right: [0x1b, 0x5b, 0x43],
  left: [0x1b, 0x5b, 0x44],
}

/** 把一个按键名或十六进制串翻译成 Buffer。 */
export function keyToBuffer(key) {
  const lower = String(key).toLowerCase()
  if (NAMED[lower]) return Buffer.from(NAMED[lower])
  if (/^(0x)?[0-9a-fA-F]{2}(\s*(0x)?[0-9a-fA-F]{2})*$/.test(String(key).trim())) {
    return Buffer.from(String(key).replace(/0x|\s/g, ''), 'hex')
  }
  return Buffer.from(String(key), 'utf8')
}
