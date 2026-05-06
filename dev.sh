#!/usr/bin/env bash
# All-in-one dev launcher for GoDaam + Huawei GoDam (Streamlit).
#
# Usage:
#   ./dev.sh              — backend (:3001) + frontend (:5173) + Streamlit (:8501)
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

case "$ACTION" in
  stop)
    stop_all
    ;;
  web)
    stop_all
    echo "Starting backend (:3001) + frontend (:5173) only (Ctrl+C to stop)."
    npm run dev:web
    ;;
  start|huawei)
    stop_all
    echo ""
    echo "Starting FULL stack (Ctrl+C to stop all):"
    echo "  • API     → http://127.0.0.1:3001"
    echo "  • Web app → http://127.0.0.1:5173"
    echo "  • Huawei GoDam (Streamlit) → http://127.0.0.1:8501"
    echo ""
    if [[ ! -f "$ROOT/plugins/GoDam-1.0/Home.py" ]]; then
      echo "WARN: plugins/GoDam-1.0/Home.py missing — clone GoDam-1.0 into plugins/GoDam-1.0"
      echo ""
    elif [[ ! -x "$ROOT/plugins/GoDam-1.0/.venv/bin/python3" ]]; then
      echo "TIP: Homebrew Python blocks global pip. Create the plugin venv once:"
      echo "     npm run setup:huawei-godam"
      echo ""
    fi
    npm run dev:all
    ;;
  *)
    echo "Usage: $0 [start|web|huawei|stop]"
    echo "  start | huawei | (no args) — backend + Vite + Streamlit on :8501"
    echo "  web                         — backend + Vite only"
    echo "  stop                        — kill listeners on dev ports"
    exit 1
    ;;
esac
