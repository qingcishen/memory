#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/root/memory-system}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-grok/work-20260713}"
STATE_DIR="${STATE_DIR:-/var/lib/memory-system-deploy}"

exec 9>/run/lock/memory-system-deploy.lock
flock -n 9 || exit 0

cd "$APP_DIR"
git fetch --quiet origin "$DEPLOY_BRANCH"

remote_sha="$(git rev-parse "origin/$DEPLOY_BRANCH")"
deployed_sha="$(cat "$STATE_DIR/deployed-sha" 2>/dev/null || true)"
if [[ "$remote_sha" == "$deployed_sha" ]]; then
  exit 0
fi

echo "[deploy] updating $DEPLOY_BRANCH to $remote_sha"
git checkout --quiet "$DEPLOY_BRANCH"
git merge --ff-only "origin/$DEPLOY_BRANCH"

npm ci --no-audit --no-fund
npm run test:company
npm run test:story
npm run test:orchestrator
npm run test:telegram
npm run test:ui
npm run ui:build

install -m 0755 deploy/vps/deploy-if-changed.sh /usr/local/sbin/memory-system-deploy-if-changed
install -m 0644 deploy/systemd/memory-system-ui.service /etc/systemd/system/memory-system-ui.service
install -m 0644 deploy/systemd/memory-system-telegram.service /etc/systemd/system/memory-system-telegram.service
install -m 0644 deploy/systemd/memory-system-feishu.service /etc/systemd/system/memory-system-feishu.service
systemctl daemon-reload
systemctl restart memory-system-ui.service memory-system-telegram.service memory-system-feishu.service
systemctl is-active --quiet memory-system-ui.service
systemctl is-active --quiet memory-system-telegram.service
systemctl is-active --quiet memory-system-feishu.service

healthy=false
for _ in {1..10}; do
  if curl -fsS --max-time 3 http://127.0.0.1:8787/api/health >/dev/null; then
    healthy=true
    break
  fi
  sleep 2
done
if [[ "$healthy" != true ]]; then
  echo "[deploy] UI health check failed after restart" >&2
  exit 1
fi

install -d -m 0755 "$STATE_DIR"
printf '%s\n' "$remote_sha" > "$STATE_DIR/deployed-sha"
echo "[deploy] complete $remote_sha"
