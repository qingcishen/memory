#!/usr/bin/env bash
set -euo pipefail

ROOT="/Users/shenqingci/memory-system"

cd "$ROOT"
mkdir -p logs

echo "[launchd] starting UI at $(date '+%Y-%m-%d %H:%M:%S')"
exec /opt/homebrew/bin/npm run ui
