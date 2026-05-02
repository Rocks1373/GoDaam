#!/usr/bin/env bash
set -euo pipefail

# Non-interactive shells (and ./dev.sh) do not load ~/.zshrc; put Homebrew on PATH.
if [[ -x /opt/homebrew/bin/brew ]]; then
  eval "$(/opt/homebrew/bin/brew shellenv)"
elif [[ -x /usr/local/bin/brew ]]; then
  eval "$(/usr/local/bin/brew shellenv)"
fi

# Kill anything already on the expected ports (best-effort).
kill_port() {
  local port="$1"
  local pids
  pids="$(lsof -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    echo "Stopping processes on port $port: $pids"
    kill $pids 2>/dev/null || true
  fi
}

kill_port 3001
kill_port 5173

npm run dev

