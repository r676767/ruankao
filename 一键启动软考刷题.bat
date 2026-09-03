@echo off
chcp 65001 >nul 2>&1
title 软考刷题 · 一键启动
color 0A
cls
echo.
echo  ===========================================
echo    🚀  软考系规分章节刷题 · 本地一键启动
echo  ===========================================
echo.
cd /d "%~dp0"

echo  [1/3] 检查 Node.js 是否安装...
where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo  ❌ 未检测到 Node.js！请先安装：
  echo     👉 官网下载：https://nodejs.org/zh-cn/download   （LTS 版，一直下一步即可）
  echo.
  echo     或者用 winget 自动安装：
  echo     管理员打开 PowerShell 执行： winget install OpenJS.NodeJS.LTS
  echo.
  pause
  exit /b 1
)
for /f "tokens=*" %%v in ('node -v') do set NODE_VER=%%v
echo  ✅ Node.js %NODE_VER% 已安装

echo.
echo  [2/3] 启动刷题服务（端口 8080 · 3MB 题库毫秒级加载 · 0 延迟）...
echo        启动后会自动用默认浏览器打开 http://localhost:8080/
echo.
echo        ⚙️ 跨设备同步：页面右上角齿轮填 Token + GistID 或打开书签版 hash 链接
echo        📱 手机同 WiFi 刷题：用手机访问 http://你电脑IP:8080/  （会在下方打印）
echo.
echo  ===========================================
echo   💡 提示：
echo   · 关闭本黑窗 = 停止服务
echo   · 本地进度自动保存到浏览器 localStorage
echo   · 用户数据存在 .data\userdata.json（可随手拷贝备份）
echo  ===========================================
echo.

set PORT=8080

REM === 默认打开首页（无配置，需要手动填）===
start "" "http://localhost:%PORT%/"

REM === 若你想打开就启用跨设备同步：把下面一行 REM 去掉，替换为你自己的 Token+GistID ===
REM start "" "http://localhost:%PORT%/#autoconf=1&gh_token=替换你的GITHUB_TOKEN&gist_id=fca886b3e1393d79eb9b8d4e6afda25f"

node scripts\server.js
pause
