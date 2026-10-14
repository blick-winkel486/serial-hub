@echo off
setlocal
rem ============================================================
rem  serial-hub 一键启动
rem  作用: 检查环境 -> 装依赖 -> 启动守护进程 -> 确认端口就绪 -> 打开面板
rem  本窗口保持打开 = 服务运行中；关闭窗口 / Ctrl+C = 停止
rem  只有端口真正监听成功才会打开浏览器，避免"拒绝连接"
rem ============================================================
cd /d "%~dp0"

echo ============================================
echo    serial-hub 一键启动
echo ============================================
echo.

rem ---- 1. 检查 Node.js ----
where node >nul 2>nul
if errorlevel 1 (
    echo [错误] 未检测到 Node.js。
    echo        请到 https://nodejs.org/ 安装 Node.js 20 或更高版本，
    echo        安装时勾选 "Add to PATH"，然后重新双击本脚本。
    echo.
    pause
    exit /b 1
)
echo [1/4] Node.js:
node --version
echo.

rem ---- 2. 已在运行则直接打开面板 ----
netstat -ano | findstr ":48080" | findstr "LISTENING" >nul
if not errorlevel 1 (
    echo [提示] serial-hub 似乎已在运行，直接打开控制台面板...
    start "" http://127.0.0.1:48080/serial/
    echo.
    pause
    exit /b 0
)

rem ---- 3. 首次运行安装依赖 ----
if not exist "node_modules" (
    echo [2/4] 首次运行，正在安装依赖（可能需要几分钟）...
    call npm install
    if errorlevel 1 (
        echo.
        echo [错误] npm install 失败。请检查网络后重试，或手动执行:
        echo        cd /d "%~dp0"
        echo        npm install
        echo        把上面的报错贴出来排查。
        echo.
        pause
        exit /b 1
    )
) else (
    echo [2/4] 依赖已就绪。
)
echo.

rem ---- 4. 启动守护进程（后台运行，日志打在本窗口）----
echo [3/4] 正在启动 serial-hub 守护进程...
start "" /b cmd /c "node bin\serial-hub.js"

rem 轮询等待 Web 端口 48080 真正监听（最多 30 秒），就绪前绝不开浏览器
set /a _tries=0
:wait_ready
timeout /t 1 /nobreak >nul
netstat -ano | findstr ":48080" | findstr "LISTENING" >nul
if not errorlevel 1 goto ready
set /a _tries+=1
if %_tries% lss 30 goto wait_ready

echo.
echo [错误] 守护进程 30 秒内没有监听 48080，启动失败。
echo.
echo  常见原因与排查方法:
echo    1^) 上面若已打印 Node 报错，按其提示处理（多半是依赖或语法问题）。
echo    2^) 端口被占用: 执行 netstat -ano ^| findstr 48080 查看，
echo        用 set SERIAL_HUB_WEB_PORT=48081 换端口后重试。
echo    3^) 手动在本目录执行 node bin\serial-hub.js 看完整报错。
echo.
pause
exit /b 1

:ready
echo [4/4] 启动成功！打开控制台面板...
echo.
echo    地址: http://127.0.0.1:48080/serial/
echo    （无硬件可先选 VIRTUAL 虚拟开发板点"连接"试玩）
echo.
start "" http://127.0.0.1:48080/serial/

echo    本窗口保持打开 = 服务运行中；关闭本窗口或 Ctrl+C = 停止服务。
echo    守护进程日志如下:
echo -------------------------------------------
rem ---- 保活：守护进程退出则本脚本结束、窗口关闭 ----
:keepalive
timeout /t 5 /nobreak >nul
netstat -ano | findstr ":48080" | findstr "LISTENING" >nul
if errorlevel 1 (
    echo.
    echo [提示] serial-hub 守护进程已退出，窗口即将关闭。
    timeout /t 3 /nobreak >nul
    exit /b 0
)
goto keepalive
