#!/usr/bin/env bash
# Push local repo to the VPS and apply it (frontend build + API restart).
# Same as: bash deploy/vps/rsync-to-godaam-vps.sh --deploy
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec bash "${SCRIPT_DIR}/rsync-to-godaam-vps.sh" --deploy "$@"
