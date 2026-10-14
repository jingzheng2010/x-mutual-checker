#!/bin/bash
# X 互关检测 - Mac 安装助手（双击运行；如提示无法打开，右键 → 打开）
DIR="$(cd "$(dirname "$0")" && pwd)/x-mutual-checker"

if [ ! -f "$DIR/manifest.json" ]; then
  echo "找不到插件文件夹：$DIR"
  echo "请确认本文件和 x-mutual-checker 文件夹放在一起。"
  read -n 1 -s -r -p "按任意键关闭"
  exit 1
fi

# 插件路径复制到剪贴板
printf '%s' "$DIR" | pbcopy

BROWSER=""
for app in "Google Chrome" "Microsoft Edge" "Brave Browser" "Chromium"; do
  if [ -d "/Applications/$app.app" ] || [ -d "$HOME/Applications/$app.app" ]; then
    open -a "$app" "chrome://extensions/"
    BROWSER="$app"
    break
  fi
done

# 在访达里选中插件文件夹，方便拖拽
open -R "$DIR"

echo
echo " =========================================================="
if [ -n "$BROWSER" ]; then
  echo "   已为你打开 $BROWSER 的扩展管理页 和 插件所在文件夹"
else
  echo "   没找到 Chrome / Edge，请先安装 Chrome，然后在地址栏输入 chrome://extensions"
fi
echo " =========================================================="
echo
echo "  第 1 步：在扩展管理页右上角打开「开发者模式」"
echo "  第 2 步：把访达里选中的「x-mutual-checker」文件夹拖进扩展管理页"
echo "          （拖不进去：点「加载已解压的扩展程序」，按 Cmd+Shift+G，"
echo "            Cmd+V 粘贴路径，回车，再点「选择」）"
echo "  第 3 步：点浏览器右上角拼图图标，把「X 互关检测」固定到工具栏"
echo "          以后点这个图标就能 开启 / 关闭 插件"
echo
echo "  注意：安装后不要删除或移动这个文件夹。"
echo
read -n 1 -s -r -p "按任意键关闭"
