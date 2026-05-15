#!/usr/bin/env bash
# Create GoDam-1.0/.venv and install requirements (avoids Homebrew PEP 668 error).
# Canonical tree: **plugins/GoDam-1.0** (legacy: GoDam/GoDam-1.0).
# Run from repo root: bash scripts/setup-huawei-godam-venv.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [[ -f "$ROOT/plugins/GoDam-1.0/requirements.txt" ]]; then
  GODAM="$ROOT/plugins/GoDam-1.0"
elif [[ -f "$ROOT/GoDam/GoDam-1.0/requirements.txt" ]]; then
  GODAM="$ROOT/GoDam/GoDam-1.0"
else
  echo "Missing GoDam-1.0 requirements.txt — use plugins/GoDam-1.0 (preferred) or GoDam/GoDam-1.0"
  exit 1
fi
REQ="$GODAM/requirements.txt"

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
