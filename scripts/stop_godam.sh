#!/usr/bin/env bash
# Stop the GoDam-1.0 Streamlit listener only (default port 8501).
#
# From repo root:
#   bash scripts/stop_godam.sh
#   HUAWEI_GODAM_STREAMLIT_PORT=8502 bash scripts/stop_godam.sh
set -euo pipefail

PORT="${HUAWEI_GODAM_STREAMLIT_PORT:-8501}"

kill_port() {
  local port="$1"
  local pids
  pids="$(lsof -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -z "$pids" ]]; then
    echo "Nothing listening on port $port (GoDam Streamlit already stopped)."
    return 0
  fi
  echo "Stopping processes on port $port: $pids"
  kill $pids 2>/dev/null || true
  sleep 0.3
  pids="$(lsof -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    kill -9 $pids 2>/dev/null || true
  fi
  echo "Done."
}

kill_port "$PORT"
