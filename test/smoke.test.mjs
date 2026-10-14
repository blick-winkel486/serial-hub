/**
 * 冒烟测试：用内置 VIRTUAL 虚拟板跑通 守护进程 → hub → IPC → serial-api 全链路。
 *
 * 不依赖真实硬件与 serialport 原生模块（虚拟端口是纯 JS），因此可在任何环境运行：
 *   node --test test/
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createDaemon } from '../src/daemon.js'
import { DaemonClient } from '../src/client.js'
import { createSerialApi } from '../src/serial-api.js'
import { IPC_HOST } from '../src/config.js'

/** 起一个用随机高端口、关掉 Web/桥的守护进程实例，返回 {daemon, port}。 */
async function bootDaemon() {
  const port = 48000 + Math.floor(Math.random() * 10000)
  const daemon = createDaemon({ webPort: 0, bridgePort: 0 })
  await daemon.listen(port)
  return { daemon, port }
}

async function connectApi(port, consumer) {
  const client = new DaemonClient({ host: IPC_HOST, port, consumer })
  await client.connect()
  return { client, api: createSerialApi(client) }
}

test('VIRTUAL：打开 → 读到输出 → 写命令 → expect_send 命中 → 关闭', async () => {
  const { daemon, port } = await bootDaemon()
  const { client, api } = await connectApi(port, 'test-1')
  try {
    // 初始未打开
    const s0 = await api.status()
    assert.equal(s0.open, false)

    // 打开虚拟板
    const s1 = await api.open({ port: 'VIRTUAL', baudRate: 115200 })
    assert.equal(s1.open, true)
    assert.equal(s1.virtual, true)

    // expect_send：等到 U-Boot 倒计时提示出现，同一瞬间发回车打断
    const es = await api.expectSend({ pattern: 'Hit any key', keys: ['enter'], timeoutMs: 15000 })
    assert.equal(es.matched, true, '应在虚拟板上命中 U-Boot 提示')
    assert.equal(es.sent, true, '命中后应已发送')

    // 读取新内容：应包含设备输出
    const r = await api.read({ direction: 'in' })
    assert.ok(r.recordCount >= 1, '应读到至少一条设备输出')
    assert.ok(r.text.length > 0, '输出文本不应为空')

    // 游标语义：再读一次应为空（没有新内容）
    const r2 = await api.read({ direction: 'in' })
    assert.equal(r2.recordCount, 0, '游标前进后应无新内容')

    // 发送命令
    const w = await api.write({ data: 'help' })
    assert.ok(w.written >= 4, '应写出 help\\r 的字节')

    // 关闭
    await api.close()
    const s2 = await api.status()
    assert.equal(s2.open, false)
  } finally {
    client.close()
    await daemon.close()
  }
})

test('两个 consumer 有独立游标', async () => {
  const { daemon, port } = await bootDaemon()
  const a = await connectApi(port, 'consumer-a')
  const b = await connectApi(port, 'consumer-b')
  try {
    await a.api.open({ port: 'VIRTUAL' })
    await a.api.expectSend({ pattern: 'Hit any key', keys: ['enter'], timeoutMs: 15000 })

    // A 先读走
    const ra = await a.api.read({ direction: 'in' })
    assert.ok(ra.recordCount >= 1)

    // B 从自己的游标（起点）读，应仍能读到 A 已读过的内容
    const rb = await b.api.read({ direction: 'in' })
    assert.ok(rb.recordCount >= ra.recordCount, 'B 的游标独立，应读到更多历史')
  } finally {
    a.client.close()
    b.client.close()
    await daemon.close()
  }
})
