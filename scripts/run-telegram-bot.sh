#!/usr/bin/env bash
set -euo pipefail

ROOT="/Users/shenqingci/memory-system"
PROXY_HOST="127.0.0.1"
PROXY_PORT="1082"

cd "$ROOT"

mkdir -p logs

# Shadowrocket 通常随登录启动；如果代理端口还没起来，尝试静默启动并等待。
if ! /usr/bin/nc -z "$PROXY_HOST" "$PROXY_PORT" 2>/dev/null; then
  /usr/bin/open -gja /Applications/Shadowrocket.app 2>/dev/null || true
  for _ in {1..30}; do
    /usr/bin/nc -z "$PROXY_HOST" "$PROXY_PORT" 2>/dev/null && break
    /bin/sleep 2
  done
fi

if ! /usr/bin/nc -z "$PROXY_HOST" "$PROXY_PORT" 2>/dev/null; then
  echo "[launchd] proxy $PROXY_HOST:$PROXY_PORT unavailable; launchd will retry"
  exit 1
fi

echo "[launchd] starting telegram bot at $(date '+%Y-%m-%d %H:%M:%S')"
exec /opt/homebrew/bin/node src/telegram/bot.js
