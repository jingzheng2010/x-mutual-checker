@echo off
chcp 65001 >nul
title X 互关检测 - 安装助手
set "EXT=%~dp0x-mutual-checker"

if not exist "%EXT%\manifest.json" (
  echo 找不到插件文件夹：%EXT%
  echo 请确认“安装-Windows.bat”和“x-mutual-checker”文件夹放在一起。
  pause
  exit /b 1
)

rem 把插件路径复制到剪贴板，方便在“加载已解压的扩展程序”窗口里粘贴
<nul set /p="%EXT%" | clip

rem 打开浏览器的扩展管理页（优先 Chrome，没有就用 Edge）
reg query "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe" >nul 2>&1
if %errorlevel%==0 (
  start "" chrome "chrome://extensions/"
  set "BROWSER=Chrome"
) else (
  reg query "HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe" >nul 2>&1
  if not errorlevel 1 (
    start "" chrome "chrome://extensions/"
    set "BROWSER=Chrome"
  ) else (
    start "" msedge "edge://extensions/"
    set "BROWSER=Edge"
  )
)

rem 同时打开插件所在位置，方便拖拽
start "" explorer /select,"%EXT%"

echo.
echo  ==========================================================
echo    已为你打开 %BROWSER% 的扩展管理页 和 插件所在文件夹
echo  ==========================================================
echo.
echo   第 1 步：在扩展管理页打开「开发者模式」开关
echo            Chrome 在右上角，Edge 在左侧菜单底部
echo.
echo   第 2 步：把文件夹窗口里选中的「x-mutual-checker」
echo            直接拖进扩展管理页，松开鼠标即可安装
echo.
echo   （拖不进去的话：点「加载已解压的扩展程序」，
echo     在弹出窗口顶部的地址栏按 Ctrl+V 粘贴路径，回车，再点「选择文件夹」）
echo.
echo   第 3 步：点浏览器右上角拼图图标，把「X 互关检测」固定到工具栏
echo            以后点这个图标就能 开启 / 关闭 插件
echo.
echo   注意：安装后不要删除或移动这个文件夹。
echo.
pause
