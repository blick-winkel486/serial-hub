/**
 * 串口控制台页面（自包含 HTML，无构建步骤）。
 *
 * 为什么自带页面而不是只做侧边栏面板：这条路径不依赖 Web 客户端的 slot / React
 * 契约，任何浏览器（包括另一台机器、手机）都能打开，且和 AI 共用同一个 SerialHub。
 * 侧边栏原生面板作为后续增强。
 *
 * 页面行为：
 *   - xterm.js 渲染**设备输出**（dir='in'），与真实串口终端一致；
 *     不把 AI 写出去的内容重复写进屏幕（那会被板子回显，造成双份）。
 *   - 右侧"活动"栏显示 out / mark / activity 记录并标注 actor，
 *     于是"AI 正在敲什么、在等什么"一眼可见。
 */

/**
 * 生成控制台页面 HTML。
 * @param {{defaultPort: string|null, defaultBaudRate: number}} defaults - 界面默认值。
 * @returns {string} HTML。
 */
export function renderConsolePage(defaults) {
  const initialPort = JSON.stringify(defaults.defaultPort ?? '')
  const initialBaud = String(defaults.defaultBaudRate ?? 115200)

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>串口控制台 · DSH</title>
<link rel="stylesheet" href="vendor/xterm.css">
<style>
  :root { color-scheme: dark; --bg:#0d1117; --panel:#161b22; --line:#30363d; --fg:#e6edf3; --dim:#8b949e; --accent:#4493f8; --ai:#d29922; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:13px/1.5 ui-sans-serif,system-ui,"Segoe UI",sans-serif; height:100vh; display:flex; flex-direction:column; }
  header { display:flex; gap:8px; align-items:center; padding:8px 10px; background:var(--panel); border-bottom:1px solid var(--line); flex-wrap:wrap; }
  select,input,button { background:#0d1117; color:var(--fg); border:1px solid var(--line); border-radius:6px; padding:5px 8px; font:inherit; }
  button { cursor:pointer; }
  button:hover:not(:disabled) { border-color:var(--accent); }
  button:disabled { opacity:.45; cursor:default; }
  /* 小图标按钮：只放一个符号，靠 title 说明用途 */
  button.icon { padding:5px 8px; font-size:14px; line-height:1; min-width:30px; }
  .dot { width:9px; height:9px; border-radius:50%; background:#6e7681; }
  .dot.on { background:#3fb950; box-shadow:0 0 8px #3fb950; }
  .spacer { flex:1; }
  .lease { padding:2px 8px; border-radius:999px; border:1px solid var(--line); color:var(--dim); font-size:12px; }
  .lease.agent { color:var(--ai); border-color:#5c4405; }
  .lease.human { color:#3fb950; border-color:#1f6f34; }
  .hint { color:var(--dim); font-size:12px; }
  main { flex:1; display:flex; min-height:0; }
  #screen { flex:1; min-width:0; padding:6px 4px 6px 8px; overflow:hidden; }
  #plain { flex:1; margin:0; padding:8px; overflow:auto; white-space:pre-wrap; word-break:break-all; font:12px/1.45 ui-monospace,Consolas,monospace; display:none; }
  #plainInput { display:none; margin:0 8px 8px; }
  #activity { width:320px; border-left:1px solid var(--line); background:var(--panel); display:flex; flex-direction:column; min-height:0; }
  #activity h2 { margin:0; padding:8px 10px; font-size:12px; font-weight:600; color:var(--dim); border-bottom:1px solid var(--line); }
  #feed { list-style:none; margin:0; padding:6px 0; overflow:auto; flex:1; font:12px/1.5 ui-monospace,Consolas,monospace; }
  #feed li { padding:3px 10px; border-bottom:1px solid #1c2128; word-break:break-all; }
  #feed li.agent { color:var(--ai); }
  #feed li.human { color:#3fb950; }
  #feed li.system, #feed li.mark { color:var(--dim); }
  #feed .who { color:var(--dim); margin-right:6px; }
  @media (max-width: 820px) { #activity { display:none; } }
</style>
</head>
<body>
<header>
  <span class="dot" id="dot" title="连接状态"></span>
  <select id="port" title="串口"></select>
  <button id="refreshPorts" class="icon" title="重新检测串口列表（插上板子后点这个）">⟳</button>
  <input id="baud" size="7" value="${initialBaud}" title="波特率">
  <button id="connect">连接</button>
  <button id="disconnect" disabled>断开</button>
  <button id="clear">清屏</button>
  <button id="save" title="把当前记录导出成 txt 文件">保存记录</button>
  <span class="spacer"></span>
  <span class="lease" id="lease">输入权：无</span>
  <span class="hint" id="hint"></span>
</header>
<main>
  <div id="screen"></div>
  <pre id="plain"></pre>
  <aside id="activity">
    <h2>活动 —— 谁在发 / AI 在等什么</h2>
    <ul id="feed"></ul>
  </aside>
</main>
<input id="plainInput" placeholder="输入命令后回车（无 xterm 时的降级模式）">
<script src="vendor/xterm.js"></script>
<script>
(function () {
  'use strict'

  var DEFAULT_PORT = ${initialPort}
  var wantPort = DEFAULT_PORT || null
  var lease = null
  var backend = 'agent'
  var term = null
  var plain = document.getElementById('plain')
  var plainInput = document.getElementById('plainInput')
  var feed = document.getElementById('feed')
  var dot = document.getElementById('dot')
  var leaseEl = document.getElementById('lease')
  var hintEl = document.getElementById('hint')
  var portEl = document.getElementById('port')
  var baudEl = document.getElementById('baud')

  /* ---------- 终端渲染 ---------- */
  function computeSize() {
    var box = document.getElementById('screen')
    var cols = Math.max(20, Math.floor((box.clientWidth - 12) / 8.4))
    var rows = Math.max(6, Math.floor((box.clientHeight - 12) / 17))
    return { cols: cols, rows: rows }
  }

  // xterm 的 npm 包是 UMD 包装（已核实：bundle 头部是 exports/define/全局三分支，
  // 末尾把 Terminal 挂到全局）。不同打包方式下全局名可能是
  // "Terminal" 或 "xterm.Terminal"，两种都接受，找不到才降级为纯文本。
  var TerminalCtor =
    (typeof window.Terminal === 'function' && window.Terminal) ||
    (window.xterm && typeof window.xterm.Terminal === 'function' && window.xterm.Terminal) ||
    null

  if (TerminalCtor) {
    var size = computeSize()
    term = new TerminalCtor({
      cols: size.cols,
      rows: size.rows,
      convertEol: false,
      scrollback: 5000,
      fontFamily: 'ui-monospace, Consolas, "Cascadia Mono", monospace',
      fontSize: 13,
      theme: { background: '#0d1117', foreground: '#e6edf3' },
    })
    term.open(document.getElementById('screen'))
    term.onData(function (data) {
      var bytes = new TextEncoder().encode(data)
      var binary = ''
      for (var i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i])
      send({ type: 'write', data: btoa(binary), encoding: 'base64' })
    })
    window.addEventListener('resize', function () {
      var next = computeSize()
      try { term.resize(next.cols, next.rows) } catch (e) { /* 忽略 */ }
    })
  } else {
    document.getElementById('screen').style.display = 'none'
    plain.style.display = 'block'
    plainInput.style.display = 'block'
    hintEl.textContent = '未找到 xterm（vendor/xterm.js 没加载成功），已降级为纯文本模式'
    plainInput.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter') return
      var text = plainInput.value
      plainInput.value = ''
      var bytes = new TextEncoder().encode(text + '\\r')
      var binary = ''
      for (var i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i])
      send({ type: 'write', data: btoa(binary), encoding: 'base64' })
    })
  }

  function writeOut(bytes) {
    if (term) term.write(bytes)
    else { plain.textContent += new TextDecoder().decode(bytes); plain.scrollTop = plain.scrollHeight }
  }

  function writeSystem(text) {
    if (term) term.write('\\r\\n\\x1b[2m' + text + '\\x1b[0m\\r\\n')
    else { plain.textContent += '\\n' + text + '\\n'; plain.scrollTop = plain.scrollHeight }
  }

  /* ---------- 活动流 ---------- */
  var feedCount = 0
  function pushFeed(record) {
    var who = record.actor === 'agent' ? 'AI' : record.actor === 'human' ? '你' : record.actor === 'device' ? '板子' : '系统'
    var li = document.createElement('li')
    li.className = record.actor || 'system'
    var label = document.createElement('span')
    label.className = 'who'
    label.textContent = '[' + who + ']'
    li.appendChild(label)
    li.appendChild(document.createTextNode(record.text.replace(/\\r?\\n/g, ' ⏎ ')))
    feed.appendChild(li)
    feedCount += 1
    while (feedCount > 300) { feed.removeChild(feed.firstChild); feedCount -= 1 }
    feed.scrollTop = feed.scrollHeight
  }

  /* ---------- 记录导出 ---------- */
  // 保留一份完整文字记录（含设备输出、你我发出的内容、系统提示），供"保存记录"导出成 txt。
  var transcript = []
  function remember(record) {
    transcript.push({ ts: record.ts, dir: record.dir, actor: record.actor, text: record.text })
    if (transcript.length > 50000) transcript.splice(0, transcript.length - 50000)
  }

  /* ---------- 与 host 通信 ---------- */
  var socket = null
  function send(message) {
    if (socket && socket.readyState === 1) socket.send(JSON.stringify(message))
    else hintEl.textContent = '尚未连接'
  }

  function applyState(state) {
    if (!state) return
    dot.classList.toggle('on', !!state.open)
    document.getElementById('connect').disabled = !!state.open
    document.getElementById('disconnect').disabled = !state.open
    lease = state.lease && state.lease.holder ? state.lease.holder : null
    leaseEl.textContent = '输入权：' + (lease === 'agent' ? 'AI' : lease === 'human' ? '你' : '无')
    leaseEl.className = 'lease ' + (lease || '')
    if (state.open) hintEl.textContent = state.port + ' @' + state.options.baudRate + (state.virtual ? '（虚拟）' : '')
  }

  function connectSocket() {
    // 相对 document.baseURI 解析（页面在 /serial/ 下），这样反向代理前缀也不会丢。
    // Electron 外壳的自定义 scheme 不能承载 ws:，优先用外壳给出的 streamBaseUrl。
    var override = globalThis.__DSH_TRANSPORT__ && globalThis.__DSH_TRANSPORT__.streamBaseUrl
    var url = new URL('ws', override || document.baseURI)
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    socket = new WebSocket(url.href)
    socket.onopen = function () { hintEl.textContent = '已连接到 host' }
    socket.onclose = function () {
      hintEl.textContent = '与 host 的连接已断开，2 秒后重连…'
      dot.classList.remove('on')
      setTimeout(connectSocket, 2000)
    }
    socket.onmessage = function (event) {
      var message = JSON.parse(event.data)
      if (message.type === 'hello') {
        applyState(message.state)
        ;(message.backlog || []).forEach(function (record) {
          remember(record)
          if (record.dir === 'in' && record.base64) writeOut(base64ToBytes(record.base64))
        })
        return
      }
      if (message.type === 'state') { applyState(message.state); return }
      if (message.type !== 'record') return
      var record = message.record
      remember(record)
      if (record.dir === 'in') { if (record.base64) writeOut(base64ToBytes(record.base64)); return }
      if (record.dir === 'system' || record.dir === 'mark') writeSystem('── ' + record.text)
      pushFeed(record)
    }
  }

  function base64ToBytes(value) {
    var binary = atob(value)
    var bytes = new Uint8Array(binary.length)
    for (var i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    return bytes
  }

  function api(path, body) {
    return fetch('api/' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(function (response) { return response.json() })
  }

  function refreshPorts() {
    // 记住当前选择，重新检测后尽量保持不变（插拔板子时很好用）
    var previous = portEl.value || wantPort
    return api('ports').then(function (result) {
      portEl.innerHTML = ''
      ;(result.ports || []).forEach(function (item) {
        var option = document.createElement('option')
        option.value = item.path
        option.textContent = item.path + (item.friendlyName ? ' — ' + item.friendlyName : '')
        portEl.appendChild(option)
      })
      if (previous) {
        portEl.value = previous
        // 之前那个端口已经不存在了（板子被拔掉）→ 退回第一个
        if (!portEl.value) portEl.selectedIndex = 0
      }
      if (result.warning) hintEl.textContent = result.warning
      if (!wantPort && portEl.value) wantPort = portEl.value
      return result
    })
  }

  document.getElementById('connect').addEventListener('click', function () {
    api('open', { port: portEl.value, baudRate: Number(baudEl.value) || 115200 }).then(function (result) {
      if (result.error) hintEl.textContent = result.error
    })
  })
  document.getElementById('disconnect').addEventListener('click', function () { api('close', {}) })
  // 重新检测串口：插上/拔掉 USB 转串口后点一下，不用刷新页面
  document.getElementById('refreshPorts').addEventListener('click', function () {
    hintEl.textContent = '正在重新检测串口…'
    refreshPorts()
      .then(function (result) {
        var count = (result.ports || []).length
        var names = (result.ports || []).map(function (item) { return item.path }).join(', ')
        hintEl.textContent = '已重新检测：发现 ' + count + ' 个端口' + (names ? '（' + names + '）' : '')
      })
      .catch(function () { hintEl.textContent = '重新检测失败' })
  })
  document.getElementById('clear').addEventListener('click', function () {
    if (term) term.clear(); else plain.textContent = ''
  })
  // 保存导出：把当前记录写成一个 txt 文件下载下来（不依赖 DSH 的会话日志导出）。
  document.getElementById('save').addEventListener('click', function () {
    if (transcript.length === 0) { hintEl.textContent = '还没有可保存的记录'; return }
    var lines = []
    lines.push('# DSH 串口控制台记录')
    lines.push('# 导出时间: ' + new Date().toISOString())
    lines.push('# 端口: ' + (portEl.value || '未选择') + '   波特率: ' + (baudEl.value || ''))
    lines.push('# 说明: [AI] / [你] 开头的是你与 AI 发出的内容，其余为设备输出')
    lines.push('')
    for (var i = 0; i < transcript.length; i += 1) {
      var item = transcript[i]
      var text = item.text.replace(/\\r\\n/g, '\\n')
      if (item.dir === 'in') { lines.push(text.replace(/\\n$/, '')); continue }
      var who = item.actor === 'agent' ? 'AI' : item.actor === 'human' ? '你' : item.actor === 'device' ? '板子' : '系统'
      var stamp = new Date(item.ts).toISOString().substr(11, 12)
      lines.push('[' + stamp + '] [' + who + ']' + (item.dir === 'out' ? ' → ' : ' ') + text.replace(/\\n$/, ''))
    }
    var blob = new Blob([lines.join('\\n')], { type: 'text/plain;charset=utf-8' })
    var url = URL.createObjectURL(blob)
    var anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'serial-' + (portEl.value || 'console') + '-' + new Date().toISOString().replace(/[:.]/g, '-') + '.txt'
    document.body.appendChild(anchor)
    anchor.click()
    document.body.removeChild(anchor)
    setTimeout(function () { URL.revokeObjectURL(url) }, 1000)
    hintEl.textContent = '已导出 ' + transcript.length + ' 条记录'
  })

  connectSocket()
  refreshPorts().then(function () {
    api('status').then(function (state) { applyState(state) })
  })
  setInterval(function () { api('status').then(applyState).catch(function () {}) }, 4000)
})()
</script>
</body>
</html>
`
}
