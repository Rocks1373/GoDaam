#!/usr/bin/env bash
# Reset databases to empty data (schema kept). Use on VPS or locally after stopping the API.
#
# Main warehouse: uses PostgreSQL when backend/.env sets DATABASE_URL (same as backend/db.js);
# otherwise falls back to SQLite at DB_PATH for legacy tooling.
#
# Usage (from repo root):
#   bash scripts/fresh-databases.sh                 # wipe warehouse data, keep admin users; wipe Huawei DB; reset admin password from .env
#   bash scripts/fresh-databases.sh --full        # wipe everything including all users, then ensure-admin
#
# Env (optional):
#   DATABASE_URL         — main warehouse Postgres (preferred)
#   DB_PATH              — main warehouse SQLite file when DATABASE_URL is unset (default: backend/warehouse.db)
#   HUAWEI_GODAM_DB_PATH — Huawei batch SQLite (default: backend/huawei_godam.db)
#   ADMIN_USERNAME / ADMIN_PASSWORD — passed via ensure-admin (defaults admin / admin123)
#
# Stop godaam-backend / dev.sh first to avoid locks / connection errors.

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKEND="$ROOT/backend"
cd "$BACKEND"

FULL=0
if [[ "${1:-}" == "--full" ]]; then FULL=1; fi

if [[ "$FULL" == "1" ]]; then
  echo ">>> Wiping main warehouse (ALL users and data)…"
  node scripts/wipe-all-data.js --yes
  echo ">>> Creating admin from ADMIN_USERNAME / ADMIN_PASSWORD (see ensure-admin.js)…"
  node scripts/ensure-admin.js
else
  echo ">>> Wiping main warehouse (all tables, keeping admin user rows)…"
  node scripts/wipe-all-data.js --yes --keep-admin
  echo ">>> Resetting admin password from .env (ADMIN_USERNAME / ADMIN_PASSWORD)…"
  node scripts/ensure-admin.js
fi

echo ">>> Wiping huawei_godam.db…"
node scripts/wipe-huawei-godam-data.js --yes

echo ""
if [[ -n "${DATABASE_URL:-}" ]]; then
  echo "Done. Restart the backend. Main DB: PostgreSQL (DATABASE_URL)."
else
  echo "Done. Restart the backend. Main DB (SQLite): ${DB_PATH:-$BACKEND/warehouse.db}"
fi
echo "Huawei DB: ${HUAWEI_GODAM_DB_PATH:-$BACKEND/huawei_godam.db}"
echo "Optional demo seed: set GODAM_SEED_DEMO_DATA=1 before start (see backend/db.js)."
