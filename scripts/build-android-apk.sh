#!/usr/bin/env bash
# Build the production GoDam Android release APK (godam-mobile) and copy it to
# backend/uploads/mobile/GoDam.apk for API download + VPS rsync.
#
# Prerequisites: Node 20+, JDK 17/21, Android SDK (ANDROID_HOME), and either an
# existing godam-mobile/android tree or run once with --prebuild.
#
# Environment:
#   EXPO_PUBLIC_API_URL  API origin baked into the bundle (default: https://godam.divadivya.cloud)
#
# Usage (from repo root):
#   bash scripts/build-android-apk.sh
#   bash scripts/build-android-apk.sh --prebuild
#   EXPO_PUBLIC_API_URL=https://your.domain bash scripts/build-android-apk.sh
#
# Output:
#   godam-mobile/android/app/build/outputs/apk/release/app-release.apk
#   backend/uploads/mobile/GoDam.apk

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

usage() {
  cat <<'EOF'
Build godam-mobile release APK → backend/uploads/mobile/GoDam.apk

Usage:
  bash scripts/build-android-apk.sh [--prebuild] [--help]

  --prebuild   Run `npx expo prebuild --platform android` first if android/ is missing or stale.

Environment:
  EXPO_PUBLIC_API_URL   API origin in bundle (default: https://godam.divadivya.cloud)

See also: bash scripts/sync-to-vps.sh --deploy
EOF
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h | --help) usage ;;
    --prebuild)
      shift
      echo "Running expo prebuild (android) in godam-mobile..."
      (cd "$ROOT/godam-mobile" && npx expo prebuild --platform android --no-install)
      ;;
    *)
      echo "Unknown option: $1 (use --help)" >&2
      exit 1
      ;;
  esac
done

exec bash "$ROOT/scripts/build-godam-android-release-apk.sh"
