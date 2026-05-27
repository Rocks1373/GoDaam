#!/usr/bin/env bash
# Sync local repo to production path on the VPS (SSH host from ~/.ssh/config).
# CODE ONLY — does NOT touch production PostgreSQL:
#   • Excludes .env, backend/warehouse.db (server uses /etc/godaam/backend.env + DATABASE_URL)
#   • --deploy = rsync + frontend build + systemctl restart godaam-backend
#   • Restart runs additive schema-migrate only (new columns/tables), never wipes rows
# Never run on the VPS: npm run fresh-db, wipe-db, migrate:sqlite-to-pg, or seed:* against production DATABASE_URL
#
# Usage (from repo root):
#   bash deploy/vps/rsync-to-godaam-vps.sh              # copy files only
#   bash deploy/vps/rsync-to-godaam-vps.sh --deploy     # copy + vite build + restart API (recommended after local edits)
#   bash deploy/vps/deploy-to-vps.sh                    # same as --deploy
#   bash deploy/vps/rsync-to-godaam-vps.sh --quick      # copy + restart API only (skip vite build)
#   bash deploy/vps/rsync-to-godaam-vps.sh --install --deploy   # also npm ci (deps / lockfile changed)
#   bash deploy/vps/rsync-to-godaam-vps.sh --venv --deploy      # refresh Huawei GoDam Python venv on VPS
#   bash deploy/vps/rsync-to-godaam-vps.sh --ai --deploy        # AI microservice (Gemini + Ollama qwen2.5:1.5b)
#   bash deploy/vps/rsync-to-godaam-vps.sh --nginx              # refresh nginx TLS site (includes /huawei-godam-app proxy)
#
# Android APK: bash scripts/build-android-apk.sh (writes backend/uploads/mobile/GoDam.apk),
# then rsync --deploy copies it to the VPS. One-shot: bash scripts/sync-vps-with-apk.sh
#
# Override: SSH_HOST=myhost APP=/opt/godaam bash deploy/vps/rsync-to-godaam-vps.sh --deploy
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SSH_HOST="${SSH_HOST:-godaam-vps}"
APP="${APP:-/opt/godaam}"

DO_DEPLOY=0
DO_QUICK=0
DO_INSTALL=0
DO_VENV=0
DO_NGINX=0
DO_AI=0

usage() {
  sed -n '1,18p' "$0" | tail -n +2
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --deploy) DO_DEPLOY=1; shift ;;
    --quick) DO_QUICK=1; DO_DEPLOY=1; shift ;;
    --install) DO_INSTALL=1; shift ;;
    --venv) DO_VENV=1; shift ;;
    --nginx) DO_NGINX=1; shift ;;
    --ai) DO_AI=1; shift ;;
    -h | --help) usage ;;
    *)
      echo "Unknown option: $1 (try --help)" >&2
      exit 1
      ;;
  esac
done

rsync -avz \
  --exclude '.claude/' \
  --exclude 'delete/' \
  --exclude '.codex-tmp/' \
  --exclude 'openclaw-videos/' \
  --exclude '.git/' \
  --exclude 'node_modules/' \
  --exclude 'frontend/node_modules/' \
  --exclude 'backend/node_modules/' \
  --exclude 'godam-mobile/node_modules/' \
  --exclude 'godam-mobile/android/build/' \
  --exclude 'godam-mobile/android/app/build/' \
  --exclude 'godam-mobile/ios/Pods/' \
  --exclude '.venv/' \
  --exclude 'plugins/GoDam-1.0/.venv/' \
  --exclude 'GoDam/GoDam-1.0/.venv/' \
  --exclude 'backend/warehouse.db' \
  --exclude 'backend/huawei_godam.db' \
  --exclude 'warehouse.db' \
  --exclude '.env' \
  --exclude 'frontend/.env' \
  "$ROOT/" "${SSH_HOST}:${APP}/"

# Rsync can leave /opt/godaam as mode 700; www-data must traverse into backend/.
ssh -o BatchMode=yes "${SSH_HOST}" "chmod 755 '${APP}' '${APP}/frontend' '${APP}/frontend/dist' 2>/dev/null || true"

echo "Rsync done → ${SSH_HOST}:${APP}/"

if [[ "$DO_NGINX" == "1" ]]; then
  NGINX_SITE="${ROOT}/deploy/nginx/godam.divadivya.cloud.ssl.conf"
  if [[ ! -f "$NGINX_SITE" ]]; then
    echo "Missing $NGINX_SITE" >&2
    exit 1
  fi
  echo "Installing nginx site from repo → ${SSH_HOST}:/etc/nginx/sites-available/godam.divadivya.cloud"
  scp -o BatchMode=yes "$NGINX_SITE" "${SSH_HOST}:/tmp/godam.divadivya.cloud.ssl.conf"
  ssh -o BatchMode=yes "${SSH_HOST}" 'install -m0644 /tmp/godam.divadivya.cloud.ssl.conf /etc/nginx/sites-available/godam.divadivya.cloud && nginx -t && systemctl reload nginx'
  echo "Nginx reloaded."
fi

if [[ "$DO_DEPLOY" -ne 1 ]]; then
  echo "Tip: run with --deploy (or deploy/vps/deploy-to-vps.sh) to rebuild frontend and restart godaam-backend on the VPS."
  exit 0
fi

echo "Deploying on ${SSH_HOST} (MODE=$([[ "$DO_QUICK" -eq 1 ]] && echo quick || echo full))..."

ssh -o BatchMode=yes "${SSH_HOST}" bash -s "$APP" "$DO_INSTALL" "$DO_VENV" "$DO_QUICK" "$DO_AI" <<'REMOTE_EOF'
set -euo pipefail
APP_PATH="$1"
DO_INSTALL="$2"
DO_VENV="$3"
DO_QUICK="$4"
DO_AI="$5"
cd "$APP_PATH"
chmod 755 "$APP_PATH" "$APP_PATH/frontend" "$APP_PATH/frontend/dist" 2>/dev/null || true

if [[ "$DO_VENV" == "1" ]] && { [[ -f "$APP_PATH/plugins/GoDam-1.0/requirements.txt" ]] || [[ -f "$APP_PATH/GoDam/GoDam-1.0/requirements.txt" ]]; }; then
  npm run setup:huawei-godam
fi

if [[ "$DO_INSTALL" == "1" ]]; then
  rm -rf node_modules frontend/node_modules backend/node_modules
  npm ci
  ( cd "$APP_PATH/frontend" && npm install @rollup/rollup-linux-x64-gnu --no-save )
fi

if [[ "$DO_QUICK" != "1" ]]; then
  npm run build
fi

chown -R www-data:www-data "$APP_PATH/backend" "$APP_PATH/frontend/dist" 2>/dev/null || true
chmod 755 "$APP_PATH" "$APP_PATH/frontend" "$APP_PATH/frontend/dist" 2>/dev/null || true

if [[ "$DO_AI" == "1" ]] && [[ -f "$APP_PATH/deploy/vps/setup-ai-service-vps.sh" ]]; then
  echo "Setting up AI microservice on VPS…"
  bash "$APP_PATH/deploy/vps/setup-ai-service-vps.sh"
else
  systemctl restart godaam-backend
fi
sleep 1
systemctl is-active godaam-backend
if [[ "$DO_AI" == "1" ]]; then
  systemctl is-active godaam-ai-service 2>/dev/null || echo "WARN: godaam-ai-service not active"
fi

echo ""
echo "PostgreSQL check (same DATABASE_URL as production API — password masked):"
node -e "
require('dotenv').config({ path: '/etc/godaam/backend.env' });
const url = String(process.env.DATABASE_URL || '').trim();
if (!url) {
  console.log('  WARNING: DATABASE_URL missing in /etc/godaam/backend.env');
  process.exit(0);
}
const masked = url.replace(/:([^:@/]+)@/, ':***@');
const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: url });
  await c.connect();
  let users = '?';
  try {
    const r = await c.query('SELECT COUNT(*)::int AS c FROM users');
    users = r.rows[0].c;
  } catch (e) {
    users = 'table missing?';
  }
  const db = await c.query('SELECT current_database() AS db');
  console.log('  DB:', db.rows[0].db, '| users:', users, '|', masked);
  await c.end();
})().catch((e) => {
  console.log('  DB check failed:', e.message);
});
" 2>/dev/null || echo "  (skip: run from $APP_PATH/backend if pg module path differs)"
REMOTE_EOF

echo "Deploy finished on ${SSH_HOST}:${APP} (godaam-backend restarted)."
