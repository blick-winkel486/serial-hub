/**
 * 浏览器信任围栏（插件自有路由的跨站 / DNS-rebinding 防护）。
 *
 * 行为照抄 `dsh-better-sidebar/src/trust-fence.ts`（它本身抄自 /api 网关的围栏
 * `@deepseek-ai/dsh-client-connection` 的 api-request-trust.ts + loopback-hostname.ts），
 * 因为**没有任何 DSH 包导出这些辅助函数** —— 第三方插件只能自己复制一份。
 *
 * 重要：这是跨站 / DNS-rebinding 防御，**不是鉴权**。host 的浏览器会话 cookie
 * 只覆盖 host 自己的 /api 与 /plugins 路由；插件路由对任何能解析 loopback 的
 * 进程都是可达的，所以这层检查是必需的。
 */

/** Electron 桌面外壳应用页面的 origin。 */
const SHELL_APP_ORIGIN = 'dsh-app://app'

function header(headers, name) {
  const value = headers?.[name]
  return typeof value === 'string' ? value : undefined
}

/** 归一化后的 hostname 是否指向本地回环。 */
export function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return (
    parts.length === 4 &&
    parts[0] === '127' &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  )
}

function parseAuthority(authority) {
  try {
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

/** 规范化的 authority 形式：hostname，或写明了端口时的 hostname:port。 */
function canonicalAuthority(entry, entryUrl) {
  const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port
  return port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`
}

/** 请求的 authority 是否命中 trustedHosts（精确或省略端口）。 */
function isTrustedAuthority(hostUrl, trustedHosts) {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}

/**
 * 判断一个请求是否有权访问本插件的路由。
 * @param {object} request - node 的 HTTP 请求（至少要有 headers）。
 * @param {string[]} trustedHosts - 本部署对外服务的非回环 authority 列表。
 * @returns {boolean} Host 是我们自己的（回环或受信任）且浏览器标记同源。
 */
export function isTrustedApiRequest(request, trustedHosts = []) {
  const host = header(request.headers, 'host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false
  // 明确的跨站浏览器标记：拒绝。
  if (header(request.headers, 'sec-fetch-site') === 'cross-site') return false
  const origin = header(request.headers, 'origin')
  if (origin === undefined) return true
  if (origin === SHELL_APP_ORIGIN) return true
  try {
    return new URL(origin).hostname === hostUrl.hostname
  } catch {
    return false
  }
}
