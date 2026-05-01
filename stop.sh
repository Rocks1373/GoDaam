#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_DIR="$ROOT_DIR/.godam"
PID_FILE="$PID_DIR/pids"

log() { printf "%s\n" "$*"; }

kill_port() {
  local port="$1"
  local pids=""
  pids="$(lsof -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    log "Stopping processes on port $port: $pids"
    kill $pids 2>/dev/null || true
  fi
}

log "Stopping GoDam…"

if [[ -f "$PID_FILE" ]]; then
  while read -r pid name; do
    [[ -z "${pid:-}" ]] && continue
    if kill -0 "$pid" 2>/dev/null; then
      log "→ stopping $name (pid=$pid)"
      kill "$pid" 2>/dev/null || true
    fi
  done <"$PID_FILE"
  rm -f "$PID_FILE"
fi

# Safety net: ensure the common ports are free.
kill_port 3001
kill_port 5173
kill_port 8090

log "Stopped."

