#!/usr/bin/env bash
# Streams Huawei GoDam-1.0 Streamlit UI (plugins/GoDam-1.0). Used by npm run dev:web:huawei.
# Prefer Homebrew Python (has pip/user installs); Xcode stub python often lacks streamlit.
# Override with HUAWEI_GODAM_PYTHON=/path/to/python3
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GODAM="$ROOT/plugins/GoDam-1.0"
if [[ ! -f "$GODAM/Home.py" ]]; then
  echo "Missing $GODAM/Home.py — clone GoDam-1.0 into plugins/GoDam-1.0"
  exit 1
fi
cd "$GODAM"

# Point Streamlit at GoDaam Node API (same machine). Override with env if needed.
export API_BASE_URL="${API_BASE_URL:-http://127.0.0.1:3001/api}"
export SOCKET_BASE_URL="${SOCKET_BASE_URL:-http://127.0.0.1:3001}"
export WEB_ADMIN_ORIGIN="${WEB_ADMIN_ORIGIN:-http://127.0.0.1:5173}"
export STREAMLIT_PUBLIC_URL="${STREAMLIT_PUBLIC_URL:-http://127.0.0.1:${HUAWEI_GODAM_STREAMLIT_PORT:-8501}}"

pick_python() {
  if [[ -n "${HUAWEI_GODAM_PYTHON:-}" ]] && [[ -x "${HUAWEI_GODAM_PYTHON}" ]]; then
    echo "${HUAWEI_GODAM_PYTHON}"
    return
  fi
  # Project venv (recommended on macOS Homebrew Python — avoids PEP 668)
  if [[ -x "$GODAM/.venv/bin/python3" ]]; then
    echo "$GODAM/.venv/bin/python3"
    return
  fi
  if [[ -x /opt/homebrew/bin/python3 ]]; then
    echo /opt/homebrew/bin/python3
    return
  fi
  if [[ -x /usr/local/bin/python3 ]]; then
    echo /usr/local/bin/python3
    return
  fi
  command -v python3
}

PY="$(pick_python)"
PORT="${HUAWEI_GODAM_STREAMLIT_PORT:-8501}"

if ! "$PY" -c "import streamlit" 2>/dev/null; then
  echo "[godam] streamlit missing for: $PY"
  echo "[godam] Homebrew blocks global pip (PEP 668). From repo root run:"
  echo "        bash scripts/setup-huawei-godam-venv.sh"
  echo "    Then restart ./dev.sh (uses plugins/GoDam-1.0/.venv automatically)."
  exit 1
fi

exec "$PY" -m streamlit run Home.py --server.port "$PORT" --server.headless true
