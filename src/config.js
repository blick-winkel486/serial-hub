/**
 * 全局配置：端口、路径等。
 *
 * 三个可调端口（都可用环境变量覆盖，便于多开/避让占用）：
 *   - SERIAL_HUB_PORT       守护进程控制 IPC 端口（默认 48555，仅监听 127.0.0.1）
 *   - SERIAL_HUB_WEB_PORT   人类 Web 控制台端口（默认 48080）
 *   - SERIAL_HUB_BRIDGE_PORT ser2net 式 TCP/Telnet 桥（默认 0 = 关闭，见 daemon）
 */

export const DEFAULT_IPC_PORT = 48555
export const DEFAULT_WEB_PORT = 48080

/** 控制 IPC 只绑定回环，绝不对外。 */
export const IPC_HOST = '127.0.0.1'
export const WEB_HOST = '0.0.0.0'

export function ipcPort() {
  const raw = process.env.SERIAL_HUB_PORT
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 && n < 65536 ? Math.floor(n) : DEFAULT_IPC_PORT
}

export function webPort() {
  const raw = process.env.SERIAL_HUB_WEB_PORT
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 && n < 65536 ? Math.floor(n) : DEFAULT_WEB_PORT
}

/** ser2net 桥端口：默认 0 表示关闭。 */
export function bridgePort() {
  const raw = process.env.SERIAL_HUB_BRIDGE_PORT
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 && n < 65536 ? Math.floor(n) : 0
}
