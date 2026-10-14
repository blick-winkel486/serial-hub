#!/usr/bin/env node
/**
 * serial-hub —— 启动串口守护进程（人类 Web 控制台 + 控制 IPC + 可选 TCP 桥）。
 *
 * 这是 bat / 手动运行的入口。它显式调用 daemon 的 runForeground()——
 * 早期版本只是 `import '../src/daemon.js'`，依赖 daemon 内部的"直接执行"判断，
 * 而 argv[1] 是本文件（bin/serial-hub.js）不是 daemon.js，判断恒为 false，
 * 导致进程什么都不启动就退出 → bat 开浏览器后"127.0.0.1 拒绝连接"。
 *
 * MCP Server / serialctl 首次调用时会自己拉起 src/daemon.js，不走这里。
 */
import { runForeground } from '../src/daemon.js'

runForeground()
