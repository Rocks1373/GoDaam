#!/usr/bin/env bash
# Run on the VPS (usually as root, same as install-on-vps.sh) after cloning to /opt/godaam.
# Pulls latest code, rebuilds frontend, restarts API. Optionally refreshes Huawei GoDam venv.
set -euo pipefail

APP="${APP:-/opt/godaam}"
BRANCH="${BRANCH:-main}"
REMOTE="${REMOTE:-origin}"

if [[ ! -f "$APP/backend/server.js" ]]; then
  echo "Missing $APP/backend/server.js — clone or sync the repo to $APP first." >&2
  exit 1
fi

cd "$APP"
chmod 755 "$APP" "$APP/frontend" "$APP/frontend/dist"

git fetch "$REMOTE"
git checkout "$BRANCH"
git pull --ff-only "${REMOTE}" "$BRANCH"

# Refresh Huawei Streamlit/Python venv when GoDam-1.0 is present (copy or submodule).
if [[ -f "$APP/GoDam/GoDam-1.0/requirements.txt" ]] || [[ -f "$APP/plugins/GoDam-1.0/requirements.txt" ]]; then
  npm run setup:huawei-godam
else
  echo "No GoDam-1.0 requirements.txt — skipping npm run setup:huawei-godam (matcher may still fail until you add it)."
fi

rm -rf node_modules frontend/node_modules backend/node_modules
npm ci
( cd "$APP/frontend" && npm install @rollup/rollup-linux-x64-gnu --no-save ) || true
npm run build

chown -R www-data:www-data "$APP/backend" "$APP/frontend/dist"
chmod 755 "$APP" "$APP/frontend" "$APP/frontend/dist"

systemctl daemon-reload
systemctl restart godaam-backend.service || {
  echo "systemctl restart failed — ensure godaam-backend.service is installed." >&2
  exit 1
}

nginx -t && systemctl reload nginx || true

echo ""
echo "Sync done. Backend: journalctl -u godaam-backend -n 80 -f"
echo "Health: curl -sf https://\$DOMAIN/api/health"
echo "Huawei API example: authenticated GET /api/huawei-godam/health"
