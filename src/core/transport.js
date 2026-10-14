/**
 * 串口传输层抽象。
 *
 * 设计要点：SerialHub 不直接依赖 serialport 原生模块，只依赖这个极小的约定面，
 * 于是同一套 hub / 工具 / 面板可以跑在三种基底上：
 *
 *   1. `openNativeSerial` —— 真实串口（serialport@13，N-API 预编译，已实测
 *      可在本机 Electron 自带的 Node 24.21 下加载）。
 *   2. `openVirtualSerial` —— 纯 JS 的虚拟板子（带 U-Boot 倒计时 + 登录 + 假 shell），
 *      没有真实硬件时用来验证整条链路，也可作为给用户的演示端口。
 *   3. 未来的子进程桥（Windows pwsh / POSIX stty）—— 万一原生模块不可用时的 Plan B。
 *
 * Transport 约定（EventEmitter）：
 *   事件：'data' (Buffer) | 'error' (Error) | 'close' ({ error?: Error })
 *   方法：write(Buffer) => Promise<void>
 *         close()        => Promise<void>
 *         setSignals({dtr?, rts?}) => Promise<void>
 */

import { EventEmitter } from 'node:events'

/** 虚拟演示端口的端口名。 */
export const VIRTUAL_PORT_NAME = 'VIRTUAL'

/* ------------------------------------------------------------------ *
 * 真实串口
 * ------------------------------------------------------------------ */

/**
 * 列出本机串口。
 * @param {object|null} [serialPortCtor] - 仅测试用：注入 serialport 的 mock binding 类。
 * @returns {Promise<Array<{path: string, manufacturer?: string, serialNumber?: string, vendorId?: string, productId?: string, friendlyName?: string}>>}
 */
export async function listNativePorts(serialPortCtor = null) {
  const { SerialPort } = serialPortCtor ? { SerialPort: serialPortCtor } : await import('serialport')
  const ports = await SerialPort.list()
  return ports.map((p) => ({
    path: p.path,
    manufacturer: p.manufacturer,
    serialNumber: p.serialNumber,
    vendorId: p.vendorId,
    productId: p.productId,
    friendlyName: p.friendlyName ?? p.pnpId,
  }))
}

/**
 * 打开一个真实串口。
 * @param {object} options - 端口参数。
 * @returns {Promise<EventEmitter>} 已打开的 transport。
 */
export async function openNativeSerial(options) {
  // options.serialPortCtor 是给测试用的注入口（serialport 的 SerialPortMock），
  // 生产路径不传，走真实的 serialport。
  const { SerialPort } = options.serialPortCtor
    ? { SerialPort: options.serialPortCtor }
    : await import('serialport')
  const port = new SerialPort({
    path: options.port,
    baudRate: options.baudRate ?? 115200,
    dataBits: options.dataBits ?? 8,
    stopBits: options.stopBits ?? 1,
    parity: options.parity ?? 'none',
    rtscts: options.rtscts ?? false,
    autoOpen: false,
  })

  await new Promise((resolve, reject) => {
    port.open((error) => (error ? reject(error) : resolve()))
  })

  const transport = new EventEmitter()
  transport.portName = options.port

  port.on('data', (chunk) => transport.emit('data', Buffer.from(chunk)))
  port.on('error', (error) => transport.emit('error', error))
  port.on('close', (info) => {
    transport.emit('close', {
      error: info && info.disconnected ? new Error('串口设备已断开（可能是 USB 转串口被拔出）') : undefined,
    })
  })

  transport.write = (buffer) =>
    new Promise((resolve, reject) => {
      if (!port.isOpen) return reject(new Error('串口未打开'))
      port.write(buffer, (error) => (error ? reject(error) : resolve()))
    })

  transport.close = () =>
    new Promise((resolve, reject) => {
      if (!port.isOpen) return resolve()
      port.close((error) => (error ? reject(error) : resolve()))
    })

  transport.setSignals = (signals) =>
    new Promise((resolve, reject) => {
      const patch = {}
      if (signals.dtr !== undefined) patch.dtr = signals.dtr
      if (signals.rts !== undefined) patch.rts = signals.rts
      if (Object.keys(patch).length === 0) return resolve()
      port.set(patch, (error) => (error ? reject(error) : resolve()))
    })

  // 打开后立刻应用调用方要求的 DTR/RTS（很多板子靠 DTR 进下载模式）。
  if (options.dtr !== undefined || options.rts !== undefined) {
    try {
      await transport.setSignals({ dtr: options.dtr, rts: options.rts })
    } catch {
      /* 某些驱动不支持设置控制线，忽略即可 */
    }
  }

  return transport
}

/* ------------------------------------------------------------------ *
 * 虚拟演示串口（无硬件自测 / 演示）
 * ------------------------------------------------------------------ */

const UBOOT_BANNER = [
  '',
  'U-Boot 2018.09 (Nov 20 2024 - 10:31:07 +0800)',
  '',
  'CPU:   Freescale i.MX6ULL rev1.1 792 MHz (running at 396 MHz)',
  'DRAM:  512 MiB',
  'MMC:   FSL_SDHC: 0, FSL_SDHC: 1',
  'In:    serial',
  'Out:   serial',
  'Err:   serial',
  'Net:   FEC0 [PRIME]',
  'Normal Boot',
]

const KERNEL_LOG = [
  '',
  'Starting kernel ...',
  '',
  '[    0.000000] Booting Linux on physical CPU 0x0',
  '[    0.000000] Linux version 5.10.160 (build@dev) (arm-linux-gnueabihf-gcc 9.3.0) #1 SMP PREEMPT',
  '[    0.000000] CPU: ARMv7 Processor [410fc075] revision 5 (ARMv7), cr=10c5387d',
  '[    0.210431] Memory: 508640K/524288K available',
  '[    0.331204] fec 2188000.ethernet eth0: registered PHC device 0',
  '[    0.442890] mmc0: SDHCI controller on 2190000.usdhc [2190000.usdhc] using ADMA',
  '[    0.775330] VFS: Mounted root (ext4 filesystem) on device 179:2.',
  '[    0.881016] Freeing unused kernel memory: 1024K',
]

const SHELL_HELP = [
  '可用命令：uname -a | ls | cat /proc/cpuinfo | free | dmesg | biglog | help | exit',
]

/**
 * 打开一个虚拟板子串口。
 *
 * 模拟行为：U-Boot 倒计时（期间收到任意字节即停在 U-Boot 提示符）→ 内核启动日志
 * → buildroot 登录提示 → 假 shell。带终端回显，输出分片且有时间间隔，
 * 因此"静默判空闲"与"正则等待"都能被真实地检验。
 *
 * @param {object} [options] - 选项。
 * @returns {Promise<EventEmitter>} transport。
 */
export async function openVirtualSerial(options = {}) {
  const transport = new EventEmitter()
  transport.portName = VIRTUAL_PORT_NAME
  transport.virtual = true

  let mode = 'uboot_countdown' // uboot_countdown | uboot | login | password | shell
  let line = ''
  let closed = false
  const timers = new Set()
  let echo = true
  /** DTR 电平：真实 CH340 自动复位电路靠它复位板子，这里也据此模拟复位。 */
  let dtr = false
  /** 倒计时消息的定时器：被按键打断时要取消掉（真实板子不会再继续倒数）。 */
  let countdownTimers = []

  const at = (ms, fn) => {
    const timer = setTimeout(() => {
      timers.delete(timer)
      if (!closed) fn()
    }, ms)
    timers.add(timer)
    return timer
  }

  const send = (text) => {
    if (!closed) transport.emit('data', Buffer.from(text, 'utf8'))
  }

  const lines = (arr, stepMs, startMs = 0) => {
    arr.forEach((text, index) => at(startMs + index * stepMs, () => send(text + '\r\n')))
    return startMs + arr.length * stepMs
  }

  /** 停掉所有尚未触发的时序（复位时用）。 */
  const stopTimers = () => {
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
  }

  /* ---- 启动序列（可被 DTR 复位重启） ---- */

  /** 内核启动 → 登录提示。复位后的自动启动与 U-Boot 的 boot 命令共用这条路径。 */
  const bootKernel = () => {
    const afterKernel = lines(KERNEL_LOG, 30, 80)
    at(afterKernel + 120, () => {
      mode = 'login'
      send('\r\nbuildroot login: ')
    })
  }

  const startBoot = (delay = 0) => {
    mode = 'uboot_countdown'
    line = ''
    echo = true
    const afterBanner = lines(UBOOT_BANNER, 35, delay + 120)
    let countdownAt = afterBanner
    countdownTimers = []
    for (const n of [3, 2, 1]) {
      countdownTimers.push(at(countdownAt, () => send(`Hit any key to stop autoboot:  ${n}`)))
      countdownAt += 400
    }
    at(countdownAt, () => {
      if (mode !== 'uboot_countdown') return
      mode = 'boot'
      send('\r\n')
      bootKernel()
    })
  }

  /** 模拟 DTR 复位：丢掉未完成的时序，板子重新上电。 */
  const resetBoard = () => {
    stopTimers()
    startBoot(120)
  }

  startBoot()

  /* ---- 假 shell 命令 ---- */
  const runCommand = (command) => {
    const [head] = command.trim().split(/\s+/)
    const emit = (arr) => arr.forEach((text, index) => at(120 + index * 25, () => send(text + '\r\n')))

    switch (head) {
      case '':
        break
      case 'uname':
        emit(['Linux buildroot 5.10.160 #1 SMP PREEMPT armv7l GNU/Linux'])
        break
      case 'ls':
        emit(['bin  dev  etc  home  lib  linuxrc  mnt  proc  root  run  sbin  sys  tmp  usr  var'])
        break
      case 'free':
        emit(['              total        used        free      shared  buff/cache   available',
              'Mem:         508640       31204      411020         420       66416      447956'])
        break
      case 'dmesg':
        emit(KERNEL_LOG.slice(1, 8))
        break
      case 'biglog':
        // 故意输出大量文本，用来检验 read/wait 的截断纪律。
        for (let i = 0; i < 400; i += 1) {
          at(120 + i * 2, () => send(`[${String(i).padStart(5, '0')}] fake kernel message line number ${i}\r\n`))
        }
        break
      case 'help':
        emit(SHELL_HELP)
        break
      case 'exit':
        emit(['logout'])
        at(700, () => {
          mode = 'login'
          send('\r\nbuildroot login: ')
        })
        return null
      default:
        emit([`-sh: ${head}: not found`])
        break
    }
    return 900
  }

  const prompt = () => {
    at(280, () => send('# '))
  }

  const handleLine = (text) => {
    if (mode === 'login') {
      mode = 'password'
      echo = false
      send('\r\nPassword: ')
      return
    }
    if (mode === 'password') {
      mode = 'shell'
      echo = true
      send('\r\n# ')
      return
    }
    if (mode === 'uboot') {
      const command = text.trim()
      if (command === 'boot' || command === 'bootm') {
        mode = 'boot'
        send('\r\n')
        bootKernel()
      } else if (command === 'help') {
        send('\r\nprintenv  setenv  boot  help\r\n=> ')
      } else {
        send(`\r\nUnknown command '${command}' - try 'help'\r\n=> `)
      }
      return
    }
    if (mode === 'shell') {
      const wait = runCommand(text)
      if (wait !== null) prompt()
    }
  }

  transport.write = async (buffer) => {
    for (const byte of buffer) {
      // U-Boot 倒计时期间任意按键都会打断自动启动。
      if (mode === 'uboot_countdown') {
        mode = 'uboot'
        // 真实板子被打断后不会再继续倒数：取消剩余倒计时消息，
        // 否则"已经进了 => 还在打印 3/2/1"会误导判断。
        for (const timer of countdownTimers) {
          clearTimeout(timer)
          timers.delete(timer)
        }
        countdownTimers = []
        send('\r\n=> ')
        continue
      }
      if (byte === 0x0d) {
        if (echo) send('\r\n')
        const completed = line
        line = ''
        handleLine(completed)
        continue
      }
      if (byte === 0x0a) continue
      if (byte === 0x03) { // Ctrl-C
        send('^C\r\n')
        line = ''
        if (mode === 'shell') prompt()
        continue
      }
      line += String.fromCharCode(byte)
      if (echo) send(String.fromCharCode(byte))
    }
  }

  transport.close = async () => {
    closed = true
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    transport.emit('close', {})
  }

  transport.setSignals = async (signals) => {
    if (signals.dtr === undefined) return
    const previous = dtr
    dtr = signals.dtr
    // 真实开发板的 CH340 自动复位电路一般在**释放** DTR 时拉复位：
    // 拉高/置位（true）按住复位，释放（false）→ 板子重新上电。
    // 这里模拟同一行为，于是"拉 DTR → 放 DTR → 打断自动启动"这条工作流可以真跑。
    if (previous === true && dtr === false) resetBoard()
  }

  return transport
}
