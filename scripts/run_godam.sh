#!/usr/bin/env bash
# Run only Huawei GoDam-1.0 (Python Streamlit under plugins/GoDam-1.0).
# Does not start the Node API or Vite — use for UI-only smoke tests or when API runs elsewhere.
#
# From repo root:
#   bash scripts/run_godam.sh
#   HUAWEI_GODAM_STREAMLIT_PORT=8502 bash scripts/run_godam.sh
#
# One-shot venv (first time): npm run setup:huawei-godam
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ -x /opt/homebrew/bin/brew ]]; then
  eval "$(/opt/homebrew/bin/brew shellenv)"
elif [[ -x /usr/local/bin/brew ]]; then
  eval "$(/usr/local/bin/brew shellenv)"
fi

exec bash "$ROOT/scripts/run-huawei-godam-streamlit.sh"
