#!/bin/bash
#
# 近邻 · 局域网工具箱 — macOS 启动脚本
#
# 用法（任选一种）：
#   1. 在「访达」里双击本文件
#   2. 终端执行：./start-mac.command
#
# 首次双击若提示「无法打开，因为来自身份不明的开发者」：
#   在文件上右键 → 打开 → 在弹窗里再点「打开」。只需一次。

set -u

cd "$(dirname "$0")" || {
  echo "无法进入脚本所在目录。"
  exit 1
}

echo ""
echo "  近邻 · 局域网工具箱"
echo "  ─────────────────────────────"
echo ""

# ---------- 检查 Node.js ----------

if ! command -v node >/dev/null 2>&1; then
  echo "  未检测到 Node.js。"
  echo ""
  echo "  这个工具需要 Node.js 18 或更高版本（只需安装一次）。"
  echo ""
  echo "  安装方式任选其一："
  echo "    1. 打开 https://nodejs.org  下载 macOS 安装包，双击安装"
  echo "    2. 已装 Homebrew：在终端执行  brew install node"
  echo ""
  echo "  装好后重新双击本文件即可。"
  echo ""
  read -n 1 -s -r -p "  按任意键关闭…"
  exit 1
fi

echo "  Node.js: $(node -v)"

NODE_MAJOR="$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 18 ] 2>/dev/null; then
  echo ""
  echo "  提示：Node.js 版本偏低（建议 18 或更高）。服务仍可启动，"
  echo "        但「按接收盘剩余空间校验」会退化为不拦截。"
fi

if [ ! -f server.js ]; then
  echo ""
  echo "  当前目录下找不到 server.js。"
  echo "  请确认本文件与 server.js 在同一个目录里。"
  echo ""
  read -n 1 -s -r -p "  按任意键关闭…"
  exit 1
fi

echo ""
echo "  启动中…（保持本窗口开着；按 Control + C 停止）"
echo ""

# ---------- 启动服务 ----------

node server.js
STATUS=$?

echo ""
if [ "$STATUS" -eq 0 ]; then
  echo "  服务已停止。"
else
  echo "  服务已退出（退出码 $STATUS）。"
  echo "  若提示端口被占用，可以换个端口启动："
  echo "      node server.js --port 8888"
fi
echo ""
read -n 1 -s -r -p "  按任意键关闭…"
echo ""
