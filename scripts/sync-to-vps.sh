#!/usr/bin/env bash
# Sync this repository to the production VPS path and optionally deploy there.
# Uses SSH host "godaam-vps" from ~/.ssh/config unless you set SSH_HOST.
# App path on server defaults to /opt/godaam (override with APP=...).
#
# This script is a thin wrapper around deploy/vps/rsync-to-godaam-vps.sh — see
# that file for the full flag list and exclude rules.
#
# Usage (from repo root):
#   bash scripts/sync-to-vps.sh                    # rsync files only
#   bash scripts/sync-to-vps.sh --deploy         # rsync + vite build + restart godaam-backend
#   bash scripts/sync-to-vps.sh --quick          # rsync + restart API (skip frontend build)
#   bash scripts/sync-to-vps.sh --install --deploy   # npm ci on VPS + full deploy
#   SSH_HOST=myhost bash scripts/sync-to-vps.sh --deploy
#
# APK: build locally first (scripts/build-android-apk.sh), then --deploy copies
# backend/uploads/mobile/GoDam.apk to the server.

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec bash "$ROOT/deploy/vps/rsync-to-godaam-vps.sh" "$@"
