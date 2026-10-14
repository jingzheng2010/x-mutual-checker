#!/bin/bash
# X 互关检测 - Linux 安装助手（终端运行：bash 安装-Linux.sh）
DIR="$(cd "$(dirname "$0")" && pwd)/x-mutual-checker"

if [ ! -f "$DIR/manifest.json" ]; then
  echo "找不到插件文件夹：$DIR"
  echo "请确认本文件和 x-mutual-checker 文件夹放在一起。"
  exit 1
fi

# 插件路径复制到剪贴板（有工具才复制）
if command -v wl-copy >/dev/null 2>&1; then printf '%s' "$DIR" | wl-copy
elif command -v xclip >/dev/null 2>&1; then printf '%s' "$DIR" | xclip -selection clipboard
elif command -v xsel >/dev/null 2>&1; then printf '%s' "$DIR" | xsel --clipboard --input
fi

BROWSER=""
for b in google-chrome google-chrome-stable chromium chromium-browser microsoft-edge microsoft-edge-stable brave-browser; do
  if command -v "$b" >/dev/null 2>&1; then
    nohup "$b" "chrome://extensions/" >/dev/null 2>&1 &
    BROWSER="$b"
    break
  fi
done

# 打开插件所在文件夹，方便拖拽
command -v xdg-open >/dev/null 2>&1 && nohup xdg-open "$(dirname "$DIR")" >/dev/null 2>&1 &

echo
echo " =========================================================="
if [ -n "$BROWSER" ]; then
  echo "   已为你打开 $BROWSER 的扩展管理页 和 插件所在文件夹"
else
  echo "   没找到 Chrome / Chromium / Edge，请先安装，然后在地址栏输入 chrome://extensions"
fi
echo " =========================================================="
echo
echo "  插件路径：$DIR"
echo
echo "  第 1 步：在扩展管理页右上角打开「开发者模式」"
echo "  第 2 步：把「x-mutual-checker」文件夹拖进扩展管理页"
echo "          （或点「加载已解压的扩展程序」，选择上面这个路径）"
echo "  第 3 步：点浏览器右上角拼图图标，把「X 互关检测」固定到工具栏"
echo "          以后点这个图标就能 开启 / 关闭 插件"
echo
echo "  注意：安装后不要删除或移动这个文件夹。"
echo
