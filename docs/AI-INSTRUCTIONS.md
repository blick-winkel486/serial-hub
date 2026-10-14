# AI 使用手册 · serial-hub

> 给所有接入 serial-hub 的 AI 助手看。你的目标：**自主地通过串口和嵌入式开发板上的 Linux 交互并调试**——你能看到开发板的输出，也能发送命令，人类工程师与你共用同一条串口。
>
> 这套工具对你（模型）而言最重要的不是"能发命令"，而是**能在正确的时机发命令、只读有用的输出、不被海量日志淹没**。下面按"先读懂纪律 → 再学工具 → 最后抄工作流"组织。

---

## 0. 心智模型（务必先建立）

- **串口是独占的**：同一时刻只有一个程序能打开某个端口。serial-hub 用一个**常驻守护进程**独占它，你（通过工具调用）、人类（通过 Web 面板）都只是这个守护进程的客户端——**你们看到的是同一份数据，敲的是同一个口**。
- **单一真源**：开发板的输出、你发出的命令、人类敲的键盘，全部进入**同一个按 seq 严格递增的缓冲**。你读到的东西 == 人类在屏幕上看到的东西。
- **读取游标（consumer）**：每个会话有独立的"我读到哪儿了"的游标。`serial_read()` 不传 `sinceSeq` 时的语义就是"**给我还没看过的新内容**"。读完游标就前进，不会重复。
- **当前连接 vs 全部历史**：默认 `connection="current"`，只看**当前这次打开端口后**的数据——换板子/重连不会把上一块板子的旧输出混进来。要看全部历史才传 `connection="all"`。

---

## 1. 铁律（违反任意一条都会让自动调试失败）

1. **交互式提示符，永远用 `serial_expect_send`，不要"wait 再 write"。**
   U-Boot 的 `Hit any key to stop autoboot` 窗口通常只有 3 秒，登录 `Password:` 提示也是转瞬即过。你每次工具调用有**秒级**往返延迟，"先 `serial_wait` 看到提示、再 `serial_write` 发内容"这两步之间板子早跑完了。`serial_expect_send` 在**命中正则的同一瞬间**就把字节发出去，没有这个缝。
2. **串口结束符用回车 `\r`，不是换行 `\n`。** `serial_write` 默认已帮你补 `\r`，别手动加 `\n`，也别用 `--no-newline` 后忘记自己补。
3. **read/wait 有硬上限，看到截断就续读，绝不硬灌。** 内核启动会喷几千行 `dmesg`。`serial_read` 默认 64KB / 2000 行上限，超了会告诉你 `truncated=true` 并给 `toSeq`——**用 `sinceSeq=toSeq` 继续读下一段**，而不是一次要全部。
4. **不要反复大范围重读同一段输出。** 游标记得你读到哪里，重复读纯属浪费上下文。要定位某个时间点，用 `serial_mark` 打标记，之后用 `sinceSeq` 从标记附近读。
5. **默认只匹配/读取"当前连接"的输出**，避免拿上一块板子的残留误命中。除非你确实要跨连接找内容。

---

## 2. 工具清单（11 个）

| 工具 | 作用 | 关键点 |
|---|---|---|
| `serial_status` | 当前是否已开端口、波特率、缓冲 seq 范围、**输入权在谁手里**、日志路径 | 每次接手先看这个 |
| `serial_list_ports` | 列出可用串口（含虚拟演示板 `VIRTUAL`） | 插上 USB 转串口后再调，能发现新设备 |
| `serial_open` | 打开并**独占**端口 | 被占用会报错；也可等人类在 Web 面板里开好 |
| `serial_close` | 关闭并释放独占与输入权 | 调试结束归还端口 |
| `serial_write` | 写文本（默认补 `\r`）或 raw 十六进制或 base64 | `raw:"03"` = Ctrl-C |
| `serial_keys` | 发按键：`enter`/`ctrl-c`/`up`/十六进制… | 打断 U-Boot、无回显场景 |
| `serial_read` | 读**你还没看过的新内容** | 有游标、有上限、会报截断 |
| `serial_wait` | 等设备输出匹配正则（expect 语义） | **主力**：替代盲目轮询 |
| `serial_expect_send` | 命中正则的**同一瞬间**发送 | 登录密码、U-Boot 倒计时，原子 |
| `serial_mark` | 在日志插一条标记 | 便于之后引用"从某时刻起" |
| `serial_signals` | 设 DTR/RTS 电平 | DTR 拉放 = 复位 CH340 板子 |

### 参数速查（与工具 schema 一致）

**`serial_read`**
- `sinceSeq`：从该 seq 之后读；省略 = 从你的游标继续
- `maxBytes`（默认 65536）、`maxLines`（默认 2000）
- `direction`：`in`（仅设备输出）｜`out`（仅发出）｜`all`（默认）
- `connection`：`current`（默认）｜`all`
- `stripAnsi`：去掉 ANSI 转义序列
- 返回：`fromSeq / toSeq / latestSeq / recordCount / bytes / truncated / droppedBeforeStart / text`

**`serial_wait` / `serial_expect_send`**
- `pattern`：JavaScript 正则源码（不带 `/ /`）
- `timeoutMs`：wait 默认 15000，expect_send 默认 10000
- `contextChars`：命中处前后保留的上下文字符数（默认 400）
- `connection`：`current`（默认）｜`all`
- `serial_expect_send` 额外：`keys`（按键序列）或 `data`（文本）/ `raw`（hex）/ `newline`——**命中后发什么**，与 `keys` 二选一
- 返回：`matched`（是否命中）、`text`（命中处附近上下文）、`toSeq`、`latestSeq`；expect_send 另有 `sent / sentBytes / writeError`

---

## 3. 标准工作流（直接抄）

### 3.1 复位板子并停在 U-Boot（CH340，最常见的"从零开始"）

```
serial_status                              # 确认已开端口
serial_signals {dtr: true}                 # 按住复位
serial_signals {dtr: false}                # 释放 → 板子重新上电
serial_expect_send {pattern: "Hit any key to stop autoboot", keys: ["enter"]}
#   → 命中倒计时提示的同一瞬间发回车，板子停在 "=> "
serial_write "printenv"                    # 现在可以下命令了
```
> 若 `expect_send` 报告"命中时缓冲里已经有该内容"（说明你晚了、倒计时已过），**不要重试同一个 expect**，用上面的 DTR 序列复位重来。
> 不同板子复位电路极性可能相反；不确定时**先问用户**，错误时序会让板子停在异常状态。

### 3.2 U-Boot → 登录 → 拿到 shell（一条链路）

```
serial_expect_send {pattern: "Hit any key to stop autoboot", keys: ["enter"]}
serial_wait {pattern: "=> ", timeoutMs: 5000}
serial_write "boot"
serial_expect_send {pattern: "login:", data: "root"}     # 命中 login: 同一瞬间发 root
serial_wait {pattern: "Password:", timeoutMs: 5000}
serial_expect_send {pattern: "Password:", data: "root"}  # 命中 Password: 同一瞬间发密码
serial_wait {pattern: "# ", timeoutMs: 10000}            # 等到 root shell 提示符
serial_write "uname -a"
serial_read {direction: "in"}                            # 读你还没看过的输出
```
> 密码这类"看到提示就得马上发"的，**一律 `expect_send`**。`serial_wait` 只用于"等一个稳定提示符再继续下一步"，那种场景等到了提示符不会立刻消失，两步调用没有竞态。

### 3.3 只想看设备输出、不看自己发的

```
serial_read {direction: "in"}
```

### 3.4 看历史全部内容（含之前接过的板子）

```
serial_read {connection: "all"}
```

---

## 4. 上下文卫生（长时间自动调试不炸的关键）

- **优先 `serial_wait` 而不是定时 `serial_read` 轮询**：wait 命中才返回，天然省上下文。
- **读之前先想清楚要什么**：要设备输出就 `direction:"in"`；要确认命令有没有执行完就 wait 一个 shell 提示符，而不是读一大段回显。
- **被截断就分段读**：`toSeq` 是续读起点。
- **需要回顾"从某时刻起"**：先 `serial_mark`，之后 `sinceSeq` 定位。
- **别把整段内核日志往对话里贴**——那是上下文杀手，用 wait 精确抓你关心的片段。

---

## 5. 和人协作

- 输入权（lease）只显示"最近谁在敲"（Web 面板上蓝点=AI、绿点=人），**不锁写**。正常情况下你在自动调试、人在旁边看；若你判断人可能正在手动操作，先 `serial_status` 看一眼输入权，必要时先问用户。
- 人类在 Web 面板里敲的每一个键、以及你的每一条命令，都在同一个缓冲里——**`serial_read`（direction 含 out）能看到人敲了什么**，这能帮你判断人是不是接管了。

---

## 6. 无硬件自测

没有板子时，用内置虚拟演示板验证整条链路：
```
serial_open {port: "VIRTUAL", baudRate: 115200}
#  它会吐出带 U-Boot 倒计时和登录流程的模拟输出，用来验证面板 + 工具链路是否正常
```

---

## 7. 一句话总结

**用 `serial_expect_send` 抢所有交互式提示，用 `serial_wait` 等稳定提示，用带游标的 `serial_read` 只取新输出，一切默认锁在"当前连接"——这样你就能长时间自主调试而不会被日志淹没、也不会错过转瞬即逝的窗口。**
