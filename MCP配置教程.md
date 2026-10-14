# serial-hub · AI 接入与配置教程

这个工具让**任意支持 MCP 的 AI**（workbuddy、VS Code 里的 Cline 等）能自主读写你的串口，和人通过同一个 Web 控制台共用同一条串口。

本文讲两件事：
1. **人类控制台**怎么用（你随时看板子、敲命令）。
2. **给 AI 配 MCP**，让它自己会用（配好后它会自己开端口、wait 提示符、发密码、读输出）。

---

## 〇、先跑起来（一键）

双击文件夹里的：

```
启动serial-hub.bat
```

它做了三件事：**首次自动装依赖 → 启动守护进程 → 自动打开人类控制台**。

然后浏览器会打开（或手动访问）：

> **http://127.0.0.1:48080/serial/**

保持那个黑色窗口开着 = 服务在运行；**关掉窗口或按 Ctrl+C = 停止服务**。

想无硬件自测：面板里「端口」选 **VIRTUAL**（虚拟开发板，带 U-Boot 倒计时和登录流程），点「连接」，就能看到模拟输出。

---

## 一、人类控制台（你用的）

打开上面的网址后：

- **端口**：下拉选（`VIRTUAL` 或真实串口如 `COM6`）；插/拔 USB 转串口后点 **⟳** 重新检测。
- **波特率**：默认 115200。
- **连接 / 断开**：打开/关闭串口。
- 中间大屏是设备输出，**直接在这里敲键盘**就能发命令。
- 右侧「活动」栏实时显示 **AI 正在发什么、正在等什么**，以及输入权现在在谁手里（AI=黄，你=绿）。

控制台和 AI 走的是**同一条串口**，不是两个连接——你在面板里敲的、AI 敲的、板子吐的，都汇总在同一条带序号的记录流里。

---

## 二、给 AI 配 MCP（核心）

配好后，那个 AI 的工具列表里会多出 11 个 `serial_*` 工具，**它自己会调用**，不需要你一步步指挥。

### 通用原理

MCP（Model Context Protocol）是"把外部工具接给 AI"的标准协议。workbuddy 和 Cline 都支持。配置的本质都一样——**告诉 AI：启动哪个命令、它就是 MCP 服务**。区别只是这个配置写进哪个文件、哪个菜单。

### 通用 JSON 片段（内容各宿主相同，只是放的位置不同）

```json
{
  "mcpServers": {
    "serial-hub": {
      "command": "node",
      "args": [
        "D:\\AI-agent\\OUTPUT\\serial-hub\\bin\\serial-hub-mcp.js"
      ]
    }
  }
}
```

> 路径要用你机器上的**实际绝对路径**，Windows 下反斜杠在 JSON 里要写成 `\\`。

---

### A. VS Code 里的 AI（Cline / Continue / Roo 等）

**Cline**（常见）：
1. VS Code 侧边栏打开 Cline → 右上角 **⋮ / MCP Servers**（或设置里搜 "MCP"）。
2. 选 **"Edit MCP Settings"**，它会打开一个 `cline_mcp_settings.json`。
3. 把上面的通用 JSON 片段**合并进去**（若已有别的 server，保留并加上 `"serial-hub"` 这一项）：
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
4. 保存，回到 MCP 面板看到 `serial-hub` 状态变绿/可用即可。
5. 在对话里直接说："**看下串口现在什么情况 / 帮我把板子连上登录进去**"，它就会调用工具。

**Continue / Roo 等**：同样在各自设置的 MCP 配置项里，粘贴同一段 JSON。

> 关键：AI 的**工作目录**不同不影响——`args` 里是绝对路径，MCP 服务从任何目录都能起。前提是**该工具文件夹已 `npm install`**（第一次由 bat 或 AI 自动完成）。

---

### B. workbuddy 里的 AI

workbuddy 支持 MCP，官方有 MCP 配置说明。配置思路相同——把上面那段 JSON 填进它的 MCP Server 配置处：

1. 找到 workbuddy 的 **MCP / 工具 / 外部服务** 配置入口（菜单或配置文件，参照其文档 "MCP" 一节）。
2. 新增一个 server，填：
   - **命令**：`node`
   - **参数**：`D:\AI-agent\OUTPUT\serial-hub\bin\serial-hub-mcp.js`
   - （或直接粘贴通用 JSON，视 workbuddy 是"表单式"还是"JSON 式"而定）
3. 保存后，AI 即可看到 11 个 `serial_*` 工具。

> 如果 workbuddy 只支持"JSON 配置文件"，就把通用 JSON 原样写进去。

---

### C. 别的、能跑 shell 的 AI（Claude Code、各类终端 agent）

没有 MCP 也能用——把 CLI 当工具给它：
- 命令是 `node D:\AI-agent\OUTPUT\serial-hub\bin\serialctl.js <子命令>`
- 子命令：`status / ports / open <port> / read / send <text> / keys enter / wait <regex> / expect-send ...`
- 详见 `README.md` 的「CLI：零接入」一节。

---

## 三、把"使用手册"喂给 AI（重要）

MCP 配好只是让 AI **有了工具**，但它还不知道**怎么正确用**（比如"登录密码要用 expect_send 抢、不能轮询"，这个知识 AI 不会天生知道）。

两种方式（可叠加）：

1. **自动（基础）**：MCP server 连接时，会自动下发一段 `instructions` 系统提示，包含最基本用法。
2. **手动（推荐，更可靠）**：把工具文件夹里的

   ```
   docs\AI-INSTRUCTIONS.md
   ```

   作为**系统提示 / 自定义指令**喂给你的 AI；或让 AI 自己读一遍这个文件。

   手册里有：心智模型、5 条铁律、11 个工具速查、**可直接抄的标准调试工作流**（DTR 复位 → 停 U-Boot → 登录 → 拿 shell）、上下文卫生、与人协作的注意点。

---

## 四、常见问题

**Q：双击 bat 没反应 / 报错找不到 node？**
A：没装 Node.js。去 https://nodejs.org/ 装 20+（勾选 "Add to PATH"），装好重开 bat。

**Q：面板打不开 http://127.0.0.1:48080/serial/ ？**
A：确认那个黑色守护进程窗口还开着（它被关=服务停了）。或端口被占了，用 `SERIAL_HUB_WEB_PORT=48081` 换端口再起（见 README）。

**Q：AI 连不上 MCP / 列表里没有 serial_* 工具？**
A：① 确认工具文件夹已 `npm install`（`node_modules` 存在）；② 确认 JSON 里的路径是**真实绝对路径**、反斜杠转义正确；③ 重启 AI 客户端让它重新加载 MCP；④ 看 Cline 的 MCP 面板里 `serial-hub` 是否变绿。

**Q：真实板子连不上、报 serialport 相关错误？**
A：这是原生依赖在运行时能否加载的问题（`serialport` 的预编译二进制要匹配你当前 Node/系统）。先用 **VIRTUAL** 跑通整条链路，确认工具链本身没问题；再排查真机。README「依赖与运行时」一节有说明。

**Q：想改端口？**
A：环境变量 `SERIAL_HUB_PORT`（控制 IPC，默认 48555）、`SERIAL_HUB_WEB_PORT`（Web，默认 48080）。bat 里没设就是默认；要在 bat 里设可在启动前加 `set SERIAL_HUB_WEB_PORT=48081`。

---

## 五、文件速查

| 文件 | 用途 |
|---|---|
| `启动serial-hub.bat` | 一键装依赖+起服务+开面板（人类入口） |
| `bin/serial-hub.js` | 守护进程本体（bat 会调它） |
| `bin/serial-hub-mcp.js` | MCP Server（配给 workbuddy / Cline） |
| `bin/serialctl.js` | CLI（给只能跑 shell 的 AI） |
| `docs/AI-INSTRUCTIONS.md` | **喂给 AI 的使用手册** |
| `README.md` | 完整说明、架构、环境变量 |
