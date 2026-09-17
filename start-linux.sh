#!/bin/bash
#
# 近邻 · 局域网工具箱 — Linux 启动脚本
#
# 用法：
#   ./start-linux.sh
#
# 自动完成：检查 Node.js → 检查端口占用 → 启动服务 → 提示局域网地址

set -u

cd "$(dirname "$0")" || {
  echo "无法进入脚本所在目录。"
  exit 1
}

DEFAULT_PORT="${PORT:-8787}"

echo ""
echo "  近邻 · 局域网工具箱"
echo "  ─────────────────────────────"
echo ""

if ! command -v node >/dev/null 2>&1; then
  echo "  未检测到 Node.js（需要 18 或更高版本，只需安装一次）。"
  echo ""
  echo "  安装方式任选其一："
  echo "    Debian / Ubuntu   sudo apt install nodejs"
  echo "    Fedora            sudo dnf install nodejs"
  echo "    通用（推荐）      打开 https://nodejs.org 下载，或用 nvm 安装"
  echo ""
  echo "  装好后重新执行本脚本即可。"
  echo ""
  exit 1
fi

echo "  Node.js: $(node -v)"

if [ ! -f server.js ]; then
  echo ""
  echo "  当前目录下找不到 server.js，请确认压缩包已完整解压。"
  echo ""
  exit 1
fi

port_in_use() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | grep -q ":$port " && return 0
  elif command -v netstat >/dev/null 2>&1; then
    netstat -ltn 2>/dev/null | grep -q ":$port " && return 0
  fi
  (exec 3<>"/dev/tcp/127.0.0.1/$port") >/dev/null 2>&1 && return 0
  return 1
}

PORT="$DEFAULT_PORT"
if port_in_use "$PORT"; then
  echo ""
  echo "  端口 $PORT 已被占用，正在寻找可用端口…"
  PORT=""
  for candidate in $(seq $((DEFAULT_PORT + 1)) $((DEFAULT_PORT + 20))); do
    if ! port_in_use "$candidate"; then
      PORT="$candidate"
      break
    fi
  done
  if [ -z "$PORT" ]; then
    echo "  端口 $DEFAULT_PORT ~ $((DEFAULT_PORT + 20)) 都被占用，"
    echo "  可手动指定：PORT=9000 ./start-linux.sh"
    exit 1
  fi
  echo "  改用端口 $PORT"
fi

echo ""
echo "  启动中…（保持本窗口开着；按 Control + C 停止）"
echo ""

exec node server.js --port "$PORT"
