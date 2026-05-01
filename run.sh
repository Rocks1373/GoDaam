#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_DIR="$ROOT_DIR/.godam"
PID_FILE="$PID_DIR/pids"

mkdir -p "$PID_DIR"

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

log "Starting GoDam (backend + web + mobile)…"
log "Repo: $ROOT_DIR"

# Avoid common port conflicts (best-effort).
kill_port 3001   # backend
kill_port 5173   # web (vite)
kill_port 8090   # mobile (expo metro)

# If an older run left PIDs behind, stop them.
if [[ -f "$PID_FILE" ]]; then
  "$ROOT_DIR/stop.sh" || true
fi

rm -f "$PID_FILE"
touch "$PID_FILE"

start_bg() {
  local name="$1"
  shift
  log "→ $name: $*"
  (cd "$ROOT_DIR" && "$@") >"$PID_DIR/$name.log" 2>&1 &
  local pid="$!"
  printf "%s %s\n" "$pid" "$name" >>"$PID_FILE"
  log "  pid=$pid (logs: $PID_DIR/$name.log)"
}

start_bg backend npm run dev --workspace backend
start_bg web npm run dev --workspace frontend
start_bg mobile bash -lc "cd \"$ROOT_DIR/godam-mobile\" && npm run start"

log ""
log "All started."
log "- Backend: http://localhost:3001"
log "- Web:     http://localhost:5173"
log "- Mobile:  Metro on http://localhost:8090"
log ""
log "To stop everything:"
log "  ./stop.sh"

