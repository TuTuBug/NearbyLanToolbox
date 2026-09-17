#!/bin/bash
#
# 近邻 · 局域网工具箱 — macOS 启动脚本
#
# 用法（任选一种）：
#   1. 在「访达」里双击本文件          ← 推荐
#   2. 终端执行：./start-mac.command
#
# 首次双击若提示「无法打开，因为来自身份不明的开发者」：
#   在文件上右键 → 打开 → 在弹窗里再点「打开」。只需一次。
#
# 这个脚本会自动完成：
#   · 检查 Node.js（没装会打开官网下载页，装完按回车继续）
#   · 检查端口是否被占用，被占用会自动换端口
#   · 服务就绪后自动用默认浏览器打开工具箱

set -u

cd "$(dirname "$0")" || {
  echo "无法进入脚本所在目录。"
  exit 1
}

# 双击 .command 时的 PATH 比终端里窄（通常只有 /usr/bin:/bin），
# 补上 Homebrew 与 Node 官方安装包的常见位置，否则容易「明明装了却找不到」。
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/local/opt/node/bin:$PATH"

DEFAULT_PORT="${PORT:-8787}"

echo ""
echo "  近邻 · 局域网工具箱"
echo "  ─────────────────────────────"
echo ""

# ---------- 查找 Node.js ----------

find_node() {
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  local candidate
  for candidate in \
    /usr/local/bin/node \
    /opt/homebrew/bin/node \
    /usr/bin/node \
    "$HOME/.nvm/versions/node"/*/bin/node \
    "$HOME/.volta/bin/node"
  do
    if [ -x "$candidate" ]; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

NODE_BIN="$(find_node || true)"

while [ -z "$NODE_BIN" ]; do
  echo "  未检测到 Node.js。"
  echo ""
  echo "  这个工具需要 Node.js 18 或更高版本（只需安装一次，装完永久可用）。"
  echo ""
  echo "  推荐步骤："
  echo "    1. 在弹出的浏览器页面下载 macOS 安装包（.pkg），双击一路下一步"
  echo "    2. 装完后回到这个窗口，按回车继续"
  echo ""
  echo "  也可以选择：已装 Homebrew 的话，在终端执行  brew install node"
  echo ""

  if command -v open >/dev/null 2>&1; then
    echo "  正在为你打开 Node.js 官方下载页…"
    open "https://nodejs.org/zh-cn/download" 2>/dev/null || true
  else
    echo "  请手动访问：https://nodejs.org/zh-cn/download"
  fi

  echo ""
  read -r -p "  装好后按回车继续（输入 q 退出）：" ANSWER
  if [ "$ANSWER" = "q" ] || [ "$ANSWER" = "Q" ]; then
    echo ""
    echo "  已退出。装好 Node.js 后重新双击本文件即可。"
    echo ""
    exit 0
  fi

  NODE_BIN="$(find_node || true)"
  echo ""
done

echo "  Node.js: $("$NODE_BIN" -v)"

NODE_MAJOR="$("$NODE_BIN" -e 'process.stdout.write(String(process.versions.node.split(".")[0]))' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 18 ] 2>/dev/null; then
  echo ""
  echo "  提示：Node.js 版本偏低（建议 18 或更高）。服务仍可启动，"
  echo "        但「按接收盘剩余空间校验」会退化为不拦截。"
fi

if [ ! -f server.js ]; then
  echo ""
  echo "  当前目录下找不到 server.js。"
  echo "  请确认本文件与 server.js 在同一个目录里（压缩包要完整解压后再运行）。"
  echo ""
  read -n 1 -s -r -p "  按任意键关闭…"
  exit 1
fi

# ---------- 选一个没被占用的端口 ----------

port_in_use() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 && return 0
  fi
  # lsof 不可用时的兜底：用 /dev/tcp（bash 内建）
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
    echo ""
    echo "  端口 $DEFAULT_PORT ~ $((DEFAULT_PORT + 20)) 都被占用了。"
    echo "  请先关闭占用程序，或手动指定端口："
    echo "      PORT=9000 ./start-mac.command"
    echo ""
    read -n 1 -s -r -p "  按任意键关闭…"
    exit 1
  fi
  echo "  改用端口 $PORT"
fi

# ---------- 启动服务 ----------

URL="http://127.0.0.1:$PORT"

echo ""
echo "  启动中…（保持本窗口开着；按 Control + C 停止）"
echo ""

"$NODE_BIN" server.js --port "$PORT" &
SERVER_PID=$!

cleanup() {
  if kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  echo ""
  echo "  服务已停止。"
  echo ""
  read -n 1 -s -r -p "  按任意键关闭…"
  echo ""
}
trap cleanup INT TERM

# 等服务端口就绪后再打开浏览器（最多等 10 秒）
READY=0
for _ in $(seq 1 40); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    break
  fi
  if port_in_use "$PORT"; then
    READY=1
    break
  fi
  sleep 0.25
done

if [ "$READY" -eq 1 ]; then
  echo "  已在浏览器中打开：$URL"
  echo "  （没自动打开的话，手动把上面的地址粘进浏览器）"
  if command -v open >/dev/null 2>&1; then
    open "$URL" 2>/dev/null || true
  fi
  echo ""
  echo "  手机要访问时，用工具箱页面上显示的局域网地址，"
  echo "  或在同一 Wi-Fi 下扫页面里的二维码。"
  echo ""
fi

wait "$SERVER_PID"
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
