#!/usr/bin/env bash
# Create plugins/GoDam-1.0/.venv and install requirements (avoids Homebrew PEP 668 error).
# Run from repo root: bash scripts/setup-huawei-godam-venv.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GODAM="$ROOT/plugins/GoDam-1.0"
REQ="$GODAM/requirements.txt"

if [[ ! -f "$REQ" ]]; then
  echo "Missing $REQ — ensure GoDam-1.0 is at plugins/GoDam-1.0"
  exit 1
fi

BOOT="${HUAWEI_GODAM_PYTHON_BOOTSTRAP:-}"
if [[ -z "$BOOT" ]] && [[ -x /opt/homebrew/bin/python3 ]]; then
  BOOT=/opt/homebrew/bin/python3
elif [[ -z "$BOOT" ]] && [[ -x /usr/local/bin/python3 ]]; then
  BOOT=/usr/local/bin/python3
elif [[ -z "$BOOT" ]]; then
  BOOT="$(command -v python3)"
fi

echo "Creating venv with: $BOOT"
"$BOOT" -m venv "$GODAM/.venv"
"$GODAM/.venv/bin/python3" -m pip install --upgrade pip
"$GODAM/.venv/bin/pip" install -r "$REQ"
echo ""
echo "Done. Huawei Streamlit uses: $GODAM/.venv/bin/python3"
echo "Then run: ./dev.sh"
