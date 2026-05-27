#!/usr/bin/env bash
# All-in-one dev launcher for GoDaam + Huawei GoDam (Streamlit).
#
# Usage:
#   ./dev.sh              — backend (:3001) + frontend (:5173); DN matching at /huawei
#   ./dev.sh start        — same as above (default “everything”)
#   ./dev.sh web          — backend + frontend only (no Streamlit)
#   ./dev.sh huawei       — same as start (alias)
#   ./dev.sh stop         — free dev ports
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

# Non-interactive shells do not load ~/.zshrc; put Homebrew on PATH.
if [[ -x /opt/homebrew/bin/brew ]]; then
  eval "$(/opt/homebrew/bin/brew shellenv)"
elif [[ -x /usr/local/bin/brew ]]; then
  eval "$(/usr/local/bin/brew shellenv)"
fi

kill_port() {
  local port="$1"
  local pids
  pids="$(lsof -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    echo "Stopping processes on port $port: $pids"
    kill $pids 2>/dev/null || true
    sleep 0.3
    pids="$(lsof -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
    if [[ -n "$pids" ]]; then
      kill -9 $pids 2>/dev/null || true
    fi
  fi
}

stop_all() {
  echo "Freeing dev ports…"
  for port in 3001 5173 5174 8501 8090 8081 19006; do
    kill_port "$port"
  done
  echo "Done."
}

ACTION="${1:-start}"

# --- GoDam main DB: PostgreSQL only (backend/db.js). Local default URL matches docker-compose.godam-postgres.yml. ---
ensure_godam_postgres() {
  if [[ "${GODAM_USE_SQLITE:-}" == "1" ]] || [[ "${DB_TYPE:-}" == "sqlite" ]] || [[ "${GODAM_DB_TYPE:-}" == "sqlite" ]]; then
    echo "WARN: SQLite is no longer supported for the main warehouse (backend/db.js is Postgres-only)."
    echo "      Unset GODAM_USE_SQLITE / DB_TYPE=sqlite and use DATABASE_URL + Docker Postgres (see docker-compose.godam-postgres.yml)."
  fi
  export DB_TYPE="${DB_TYPE:-postgres}"
  export DATABASE_URL="${DATABASE_URL:-postgresql://godam_user:godam_dev_local@127.0.0.1:5432/godam_db}"
  echo "GoDam DB: PostgreSQL (default URL user=godam_user db=godam_db host=127.0.0.1:5432)"
  if [[ "${GODAM_SKIP_DOCKER_PG:-}" == "1" ]]; then
    echo "  (GODAM_SKIP_DOCKER_PG=1: not starting Docker; ensure DATABASE_URL is reachable.)"
    ( cd "$ROOT/backend" && node scripts/pg-bootstrap-if-empty.js ) || true
    return 0
  fi
  if command -v docker >/dev/null 2>&1 && [[ -f "$ROOT/docker-compose.godam-postgres.yml" ]]; then
    echo "Starting Docker service godam-postgres…"
    docker compose -f "$ROOT/docker-compose.godam-postgres.yml" up -d
    echo "Waiting for Postgres (godam_user @ godam_db)…"
    local ok=0
    local i
    for i in $(seq 1 45); do
      if docker compose -f "$ROOT/docker-compose.godam-postgres.yml" exec -T godam-postgres \
        pg_isready -U godam_user -d godam_db >/dev/null 2>&1; then
        ok=1
        break
      fi
      sleep 1
    done
    if [[ "$ok" != "1" ]]; then
      echo "WARN: Postgres not ready. Try: docker compose -f docker-compose.godam-postgres.yml logs"
    fi
  else
    echo "WARN: Docker not found. Start Postgres yourself or set GODAM_SKIP_DOCKER_PG=1 with a reachable DATABASE_URL."
  fi
  ( cd "$ROOT/backend" && node scripts/pg-bootstrap-if-empty.js ) || true
  # Fresh Docker PG has schema from backend startup migrate, but often zero users when SQLite is not present.
  ( cd "$ROOT/backend" && node scripts/ensure-admin.js ) || {
    echo "WARN: ensure-admin.js failed — create a user with: cd backend && node scripts/ensure-admin.js"
  }
}

# Backend refuses to boot without JWT_SECRET (see backend/middleware/auth.js). npm workspace cwd
# loads backend/.env via dotenv, but many clones only have a repo-root .env — source both here.
ensure_jwt_secret_for_local_dev() {
  if [[ -n "${JWT_SECRET:-}" ]]; then
    return 0
  fi
  if [[ -f "$ROOT/backend/.env" ]]; then
    set -a
    # shellcheck disable=SC1091
    source "$ROOT/backend/.env"
    set +a
  fi
  if [[ -n "${JWT_SECRET:-}" ]]; then
    return 0
  fi
  if [[ -f "$ROOT/.env" ]]; then
    set -a
    # shellcheck disable=SC1091
    source "$ROOT/.env"
    set +a
  fi
  if [[ -n "${JWT_SECRET:-}" ]]; then
    return 0
  fi
  export JWT_SECRET="$(openssl rand -hex 64)"
  echo "NOTE: JWT_SECRET was unset; using an ephemeral dev secret for this shell. For a stable token across restarts, add JWT_SECRET (openssl rand -hex 64) to backend/.env."
}

case "$ACTION" in
  stop)
    stop_all
    ;;
  web)
    stop_all
    ensure_godam_postgres
    ensure_jwt_secret_for_local_dev
    echo "Starting backend (:3001) + frontend (:5173) only (Ctrl+C to stop)."
    npm run dev:web
    ;;
  start|huawei)
    stop_all
    ensure_godam_postgres
    ensure_jwt_secret_for_local_dev
    export HUAWEI_GODAM_STREAMLIT_AUTOSTART="${HUAWEI_GODAM_STREAMLIT_AUTOSTART:-0}"
    echo ""
    echo "Starting FULL stack (Ctrl+C to stop all):"
    echo "  • API     → http://127.0.0.1:3001"
    echo "  • Web app → http://127.0.0.1:5173"
    echo "  • Huawei DN Matching → http://127.0.0.1:5173/huawei"
    if [[ "${HUAWEI_GODAM_STREAMLIT_AUTOSTART}" == "1" ]]; then
      echo "  • Streamlit plugin (optional) → http://127.0.0.1:8501"
    fi
    echo ""
    if [[ ! -f "$ROOT/plugins/GoDam-1.0/Home.py" ]] && [[ ! -f "$ROOT/GoDam/GoDam-1.0/Home.py" ]]; then
      echo "WARN: GoDam-1.0/Home.py missing — add plugins/GoDam-1.0 (canonical) or legacy GoDam/GoDam-1.0"
      echo ""
    elif [[ ! -x "$ROOT/plugins/GoDam-1.0/.venv/bin/python3" ]] && [[ ! -x "$ROOT/GoDam/GoDam-1.0/.venv/bin/python3" ]]; then
      echo "TIP: Homebrew Python blocks global pip. Create the plugin venv once:"
      echo "     npm run setup:huawei-godam"
      echo ""
    fi
    npm run dev:all
    ;;
  *)
    echo "Usage: $0 [start|web|huawei|stop]"
    echo "  start | huawei | (no args) — backend + Vite; optional Streamlit if HUAWEI_GODAM_STREAMLIT_AUTOSTART=1"
    echo "  web                         — backend + Vite only"
    echo "  stop                        — kill listeners on dev ports"
    echo ""
    echo "Database: ./dev.sh defaults to PostgreSQL (Docker: docker-compose.godam-postgres.yml)."
    echo "  Skip Docker: GODAM_SKIP_DOCKER_PG=1 with DATABASE_URL set to your Postgres."
    echo "Auth: JWT_SECRET is read from backend/.env or repo-root .env if present; otherwise a dev-only secret is generated for this shell (set JWT_SECRET for stable sessions)."
    exit 1
    ;;
esac
