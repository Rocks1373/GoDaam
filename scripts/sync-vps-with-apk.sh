#!/usr/bin/env bash
# Build Android release APK (EXPO_PUBLIC_API_URL embedded), then sync repo to VPS and deploy web + API.
#
# Prerequisites:
#   - SSH: host "godaam-vps" in ~/.ssh/config (or set SSH_HOST)
#   - Local: Android SDK + godam-mobile/android from `npx expo prebuild --platform android` if missing
#
# Usage (from repo root):
#   bash scripts/sync-vps-with-apk.sh
#   EXPO_PUBLIC_API_URL=https://your.domain bash scripts/sync-vps-with-apk.sh
#   SSH_HOST=my-vps EXPO_PUBLIC_API_URL=https://your.domain bash scripts/sync-vps-with-apk.sh
#
# Same as: bash scripts/build-android-apk.sh && bash scripts/sync-to-vps.sh --deploy

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

bash "$ROOT/scripts/build-android-apk.sh"
bash "$ROOT/scripts/sync-to-vps.sh" --deploy

echo ""
echo "Next steps:"
echo "  • Public APK URL: …/api/mobile-app/apk  (no login; also linked from login page)"
echo "  • Admins: …/mobile-apps (metadata + download with Bearer + admin)"
echo "  • APK path on server: backend/uploads/mobile/GoDam.apk (rsynced with this run if file existed locally)"
