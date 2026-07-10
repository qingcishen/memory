#!/usr/bin/env bash
set -euo pipefail

cd /Users/hk/memory-system

mkdir -p logs

echo "[launchd] starting telegram bot at $(date '+%Y-%m-%d %H:%M:%S')"
exec /opt/homebrew/bin/node src/telegram/bot.js
