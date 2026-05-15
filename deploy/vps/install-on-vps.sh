#!/usr/bin/env bash
# Run on the VPS as root after the repo is synced to /opt/godaam.
# Installs certbot, obtains Let's Encrypt cert (webroot), nginx TLS site, systemd API service.
set -euo pipefail

APP="${APP:-/opt/godaam}"
DOMAIN="${DOMAIN:-godam.divadivya.cloud}"
CERTBOT_EMAIL="${CERTBOT_EMAIL:-}"

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq certbot nginx python3 python3-venv python3-pip

mkdir -p /var/www/certbot/.well-known/acme-challenge /etc/godaam

if [[ ! -f "$APP/backend/server.js" ]]; then
  echo "Missing $APP/backend/server.js — sync the repo to $APP first." >&2
  exit 1
fi

if [[ ! -f /etc/godaam/backend.env ]]; then
  JWT="$(openssl rand -hex 32)"
  umask 077
  cat >/etc/godaam/backend.env <<EOF
NODE_ENV=production
PORT=3001
JWT_SECRET=${JWT}
CORS_ORIGIN=https://${DOMAIN},http://${DOMAIN}

# Huawei module (optional Streamlit iframe at https://${DOMAIN}/huawei-godam-app → Node proxy → :8501)
# Uncomment after copying **plugins/GoDam-1.0** (canonical) or legacy GoDam/GoDam-1.0 and running: npm run setup:huawei-godam
# HUAWEI_GODAM_STREAMLIT_AUTOSTART=1
# HUAWEI_GODAM_STREAMLIT_BASE_PATH=huawei-godam-app
# HUAWEI_GODAM_STREAMLIT_PORT=8501
# Do not set HUAWEI_GODAM_STREAMLIT_DISABLE_PRODUCTION=1 when autostart is enabled.
EOF
  chmod 600 /etc/godaam/backend.env
  echo "Created /etc/godaam/backend.env (JWT_SECRET set). Edit if you need MOBILE_APP_API_KEY etc."
else
  echo "Keeping existing /etc/godaam/backend.env"
fi

cd "$APP"
# Huawei GoDam Python/Streamlit (skip if folder not present yet).
if [[ -f "$APP/plugins/GoDam-1.0/requirements.txt" ]] || [[ -f "$APP/GoDam/GoDam-1.0/requirements.txt" ]]; then
  npm run setup:huawei-godam
else
  echo "No GoDam-1.0 on disk — install later, then: npm run setup:huawei-godam and enable HUAWEI_GODAM_STREAMLIT_AUTOSTART in /etc/godaam/backend.env"
fi
# Fresh install on Linux (lockfile may have been generated on macOS — optional Rollup binaries differ).
rm -rf node_modules frontend/node_modules backend/node_modules
npm ci
# Rollup Linux native optional (lockfile from macOS can omit it; npm ci bug #4828).
( cd "$APP/frontend" && npm install @rollup/rollup-linux-x64-gnu --no-save )
npm run build

chown -R www-data:www-data "$APP/backend" "$APP/frontend/dist"
chmod 755 "$APP" "$APP/frontend" "$APP/frontend/dist"

install -m0644 "$APP/deploy/nginx/godam.divadivya.cloud.http-acme.conf" /etc/nginx/sites-available/godam.divadivya.cloud
ln -sf /etc/nginx/sites-available/godam.divadivya.cloud /etc/nginx/sites-enabled/godam.divadivya.cloud
if [[ -L /etc/nginx/sites-enabled/default ]]; then
  rm -f /etc/nginx/sites-enabled/default
fi
nginx -t
systemctl reload nginx

CERT_FLAGS=(certonly --webroot -w /var/www/certbot -d "$DOMAIN" --non-interactive --agree-tos)
if [[ -n "$CERTBOT_EMAIL" ]]; then
  CERT_FLAGS+=(-m "$CERTBOT_EMAIL")
else
  CERT_FLAGS+=(--register-unsafely-without-email)
fi
certbot "${CERT_FLAGS[@]}" || {
  echo "Certbot failed. Fix DNS A/AAAA for $DOMAIN to this host, then re-run:" >&2
  echo "  certbot certonly --webroot -w /var/www/certbot -d $DOMAIN" >&2
  exit 1
}

install -m0644 "$APP/deploy/nginx/godam.divadivya.cloud.ssl.conf" /etc/nginx/sites-available/godam.divadivya.cloud
nginx -t
systemctl reload nginx

install -m0644 "$APP/deploy/systemd/godaam-backend.service" /etc/systemd/system/godaam-backend.service
systemctl daemon-reload
systemctl enable godaam-backend.service
systemctl restart godaam-backend.service

echo ""
echo "Done. API: https://${DOMAIN}/api/health  Web: https://${DOMAIN}/"
systemctl --no-pager -l status godaam-backend.service | head -n 15 || true
