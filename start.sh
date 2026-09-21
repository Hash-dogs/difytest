#!/usr/bin/env bash
#
# 评委匿名打分系统 —— Linux / macOS 启动脚本
# 等价于 Windows 上的 start.bat
#
# 用法：
#   ./start.sh                          默认 3001 端口 + 内置请求头令牌
#   PORT=8080 ./start.sh                换端口
#   PFXT_TOKEN= ./start.sh              关掉请求头令牌（仅本机开发用）
#   PFXT_BASE_PATH=/xxxx ./start.sh     改用路径前缀承载暗号（URL 变成 /xxxx/v）
#   PFXT_PUBLIC_URL=http://1.2.3.4:3001 ./start.sh   公网地址（二维码指向它）
#
# ⚠️ 请求头令牌只拦 GET/HEAD，且**浏览器地址栏发不出自定义请求头** ——
#    必须由公网映射/网关在转发时代加 `token: <口令>`，否则页面一律 404。
#    自测：curl -H "token: <口令>" http://127.0.0.1:3001/v
#
set -euo pipefail

cd "$(dirname "$0")"

echo
echo " ============================================"
echo "   PFXT  -  Anonymous Judge Scoring System"
echo " ============================================"
echo

if ! command -v node >/dev/null 2>&1; then
  echo " [ERROR] Node.js was not found on PATH."
  echo "         Install Node.js 20 or newer, e.g.:"
  echo "           curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -"
  echo "           sudo apt-get install -y nodejs"
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo " [ERROR] Node.js 20+ required, found $(node -v)."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo " First run detected: installing dependencies, please wait..."
  echo
  if ! npm install; then
    echo
    echo " [ERROR] Dependency installation failed."
    echo "         better-sqlite3 needs a native build. If no prebuilt binary"
    echo "         matches your Node version, install build tools first:"
    echo "           Debian/Ubuntu : sudo apt-get install -y build-essential python3"
    echo "           RHEL/CentOS   : sudo yum groupinstall -y 'Development Tools'"
    echo "         then run this script again."
    exit 1
  fi
  echo
fi

# 提示防火墙：Linux 上默认多半是开着的，手机连不上通常卡在这里
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -qi '^Status: active'; then
  PORT_TO_CHECK="${PORT:-3001}"
  if ! ufw status 2>/dev/null | grep -q "^${PORT_TO_CHECK}"; then
    echo " [!] ufw is active but port ${PORT_TO_CHECK} does not appear to be allowed."
    echo "     If phones cannot reach this machine, run:"
    echo "       sudo ufw allow ${PORT_TO_CHECK}/tcp"
    echo
  fi
fi

echo " Starting server..."
echo
exec node src/server.js
