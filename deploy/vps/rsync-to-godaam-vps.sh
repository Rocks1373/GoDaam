#!/usr/bin/env bash
# Sync local repo to production path on the VPS (SSH host from ~/.ssh/config).
# Preserves server DBs and uploads; skips huge dev-only trees.
#
# Usage (from repo root):
#   bash deploy/vps/rsync-to-godaam-vps.sh              # copy files only
#   bash deploy/vps/rsync-to-godaam-vps.sh --deploy     # copy + vite build + restart API (recommended after local edits)
#   bash deploy/vps/deploy-to-vps.sh                    # same as --deploy
#   bash deploy/vps/rsync-to-godaam-vps.sh --quick      # copy + restart API only (skip vite build)
#   bash deploy/vps/rsync-to-godaam-vps.sh --install --deploy   # also npm ci (deps / lockfile changed)
#   bash deploy/vps/rsync-to-godaam-vps.sh --venv --deploy      # refresh Huawei GoDam Python venv on VPS
#   bash deploy/vps/rsync-to-godaam-vps.sh --nginx              # refresh nginx TLS site (includes /huawei-godam-app proxy)
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
    -h | --help) usage ;;
    *)
      echo "Unknown option: $1 (try --help)" >&2
      exit 1
      ;;
  esac
done

rsync -avz \
  --exclude '.claude/' \
  --exclude 'Deepak_test_1/' \
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

ssh -o BatchMode=yes "${SSH_HOST}" bash -s "$APP" "$DO_INSTALL" "$DO_VENV" "$DO_QUICK" <<'REMOTE_EOF'
set -euo pipefail
APP_PATH="$1"
DO_INSTALL="$2"
DO_VENV="$3"
DO_QUICK="$4"
cd "$APP_PATH"
chmod 755 "$APP_PATH" "$APP_PATH/frontend" "$APP_PATH/frontend/dist" 2>/dev/null || true

if [[ "$DO_VENV" == "1" ]] && { [[ -f "$APP_PATH/GoDam/GoDam-1.0/requirements.txt" ]] || [[ -f "$APP_PATH/plugins/GoDam-1.0/requirements.txt" ]]; }; then
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

systemctl restart godaam-backend
sleep 1
systemctl is-active godaam-backend
REMOTE_EOF

echo "Deploy finished on ${SSH_HOST}:${APP} (godaam-backend restarted)."
