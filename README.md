# serial-hub

让 **任何 AI**（workbuddy、VS Code 里的 Cline、Claude Desktop、Cursor、DSH……）都能和人类工程师**共用同一条串口**，自主地看输出、发命令、交互式调试嵌入式开发板上的 Linux。

```
                 ┌──────────────────────────────────┐
  人(浏览器)────▶│   serial-hub 守护进程（常驻）       │◀── MCP ──▶ VS Code 的 AI (Cline)
  Web 控制台      │   唯一持有并独占串口的那一个对象      │
                 │   hub: 环形缓冲 + seq + 游标        │◀── MCP ──▶ workbuddy 的 AI
  MobaXterm ────▶│   控制 IPC（本地 TCP，换行 JSON）     │
  (TCP 桥,可选)   └──────────────────────────────────┘
                        ▲
                        └── CLI (serialctl) ── 任何"只能跑 shell"的 AI
```

## 它解决什么

嵌入式工程师调板子时，人盯串口终端、AI 想帮忙却"看不见也摸不着"。serial-hub 把串口提升成一个**常驻服务**：人用 Web 控制台（xterm 终端），AI 通过 MCP 或 CLI 工具接入，**双方共享同一个 SerialHub、同一条物理连接**——AI 看到的 == 人看到的，AI 发的 == 人看到的，`serial_expect_send` 还能让 AI 在正确的毫秒发出命令（抢 U-Boot 倒计时、登录密码）。

## 核心设计

- **单一真源**：所有数据（设备输出、AI 发的、人敲的）进同一个按 `seq` 严格递增的环形缓冲。任何客户端读到的都是同一份真相。
- **独占而不互斥**：串口只被守护进程打开一次；人和多个 AI 都是它的客户端，彼此不抢端口。
- **读取游标**：每个会话/每个 CLI consumer 有独立游标，`read` 默认是"给我还没看过的部分"。
- **原子 expect→send**：`serial_expect_send` 在命中正则的同一 tick 内发字节，解决交互式提示的秒级竞态。
- **上下文卫生**：read/wait 有硬上限并显式报截断，绝不把整段 `dmesg` 灌进模型上下文。

## 安装

```bash
cd serial-hub
npm install        # serialport(N-API 预编译) + ws + @xterm/xterm + MCP SDK + zod
```

> `serialport` 有原生依赖；若在非 Electron 的普通 Node 下加载失败，先用内置 `VIRTUAL` 虚拟端口验证整条链路（见下）。

## 快速开始（无硬件自测）

```bash
# 1) 前台起守护进程（会打印 Web 控制台地址）
node bin/serial-hub.js
#    → 人类 Web 控制台：http://127.0.0.1:48080/serial/
#    → 控制 IPC：127.0.0.1:48555

# 2) 用 CLI 走一遍（虚拟板）
serialctl ports                 # 应看到 VIRTUAL 虚拟演示板
serialctl open VIRTUAL
serialctl wait "U-Boot" --timeout 5000
serialctl read
serialctl close
```

人类打开 `http://127.0.0.1:48080/serial/` 就能看到 xterm 终端，和 CLI/AI 共用同一个口。

## 三种接入方式

| 方式 | 适合谁 | 说明 |
|---|---|---|
| **MCP Server**（推荐） | workbuddy、Cline 等支持 MCP 的 AI | 一次配置，工具即插即用 |
| **CLI (`serialctl`)** | 只能执行 shell 命令的 AI | 零集成，直接跑命令 |
| **人类 Web 控制台** | 你 | xterm 终端，随时看/敲 |

---

## 接入 A：MCP Server（workbuddy / Cline / Claude Desktop / Cursor）

MCP Server 以 stdio 与宿主通信；首次被调用时若守护进程没在跑，会**自动在后台拉起一个**（长期存活，可被多个 AI 共用）。

把下面配置加到宿主的 MCP 配置里（把 `D:\\AI-agent\\OUTPUT\\serial-hub` 换成你的实际绝对路径）：

**VS Code Cline / Claude Desktop / Cursor（`mcpServers` JSON）**

```json
{
  "mcpServers": {
    "serial-hub": {
      "command": "node",
      "args": ["D:\\AI-agent\\OUTPUT\\serial-hub\\bin\\serial-hub-mcp.js"]
    }
  }
}
```

**workbuddy**（支持 MCP 的客户端同理）——指向同一个入口：

```json
{
  "mcpServers": {
    "serial-hub": {
      "command": "node",
      "args": ["D:\\AI-agent\\OUTPUT\\serial-hub\\bin\\serial-hub-mcp.js"]
    }
  }
}
```

装好后，AI 侧会出现 11 个 `serial_*` 工具。**把这本手册 `docs/AI-INSTRUCTIONS.md` 作为系统提示/知识喂给 AI**（或让它读一遍），它就知道怎么正确使用了。

## 接入 B：CLI（任何能跑 shell 的 AI）

无需任何对接，直接命令。都打到同一个守护进程：

```bash
serialctl status                         # 状态 / 输入权 / 缓冲范围
serialctl ports                          # 列串口（含 VIRTUAL）
serialctl open COM6 --baud 115200        # 打开并独占
serialctl send "ls -l"                   # 发送（自动补 \r）
serialctl send --raw "0d"                # 发送十六进制
serialctl keys ctrl-c enter              # 发送按键序列
serialctl read [--since 42] [--max-bytes 65536]   # 读"还没看过的"新输出
serialctl wait "login:" --timeout 10000  # 等输出匹配
serialctl expect-send "login:" "root"    # 命中即发（竞态安全）
serialctl mark "开始烧写"                 # 插标记
serialctl signals --dtr 0 --rts 0        # DTR/RTS（复位板子）
serialctl daemon                         # 前台起守护进程（调试用）
```

CLI 默认用固定游标 `cli`（多次调用共享）。给每个独立任务一个独立游标用 `--consumer <id>`。

## 接入 C：人类 Web 控制台

浏览器打开 `http://127.0.0.1:48080/serial/`（端口可用 `SERIAL_HUB_WEB_PORT` 改）。xterm 渲染设备输出，右侧"活动"栏显示谁在发、AI 在等什么。可保存记录为 txt。

---

## 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `SERIAL_HUB_PORT` | `48555` | 控制 IPC 端口（仅 127.0.0.1） |
| `SERIAL_HUB_WEB_PORT` | `48080` | 人类 Web 控制台端口 |
| `SERIAL_HUB_BRIDGE_PORT` | `0`（关闭） | ser2net 式 TCP/Telnet 桥端口；>0 时在 127.0.0.1 开启，MobaXterm 可 Telnet 连它当串口用 |

---

## 目录结构

```
serial-hub/
├─ bin/
│  ├─ serial-hub.js        # 启动守护进程（人类控制台 + IPC + 可选桥）
│  ├─ serial-hub-mcp.js    # MCP Server 入口（给 AI）
│  └─ serialctl.js         # CLI 入口（给能跑 shell 的 AI）
├─ src/
│  ├─ daemon.js            # 守护进程主体：hub + IPC + 控制台 + 桥
│  ├─ client.js            # DaemonClient（换行 JSON over 本地 TCP）
│  ├─ cli.js               # CLI 与 MCP 共用的连接层
│  ├─ cli-main.js          # serialctl 命令实现
│  ├─ mcp-server.js        # 11 个 serial_* MCP 工具（描述即说明书）
│  ├─ serial-api.js        # 高层串口操作（MCP/CLI 共用，对齐 hub 语义）
│  ├─ keys.js              # 按键名 → 字节
│  ├─ config.js            # 端口等配置
│  ├─ console-http.js      # 人类 Web 控制台（原生 http + ws）
│  └─ core/                # 与宿主无关的核心逻辑（从 DSH 插件复用）
│     ├─ hub.js            # SerialHub：单一真源 / 环形缓冲 / 游标 / expectSend
│     ├─ transport.js      # 真实串口 + 虚拟演示串口
│     ├─ console-page.js   # xterm 控制台页面（纯函数）
│     ├─ bridge.js         # TCP/Telnet 桥
│     └─ trust-fence.js    # 信任围栏（防跨站 / DNS-rebinding）
├─ docs/
│  └─ AI-INSTRUCTIONS.md   # ★ 给 AI 的使用手册
├─ test/                   # 冒烟测试（虚拟板跑通整条链路）
└─ package.json
```

## 测试

```bash
npm test     # 用 VIRTUAL 虚拟板跑通 打开→U-Boot→登录→shell 全链路
```

## 许可

MIT

