#!/usr/bin/env bash
# Build GoDam Android release APK with EXPO_PUBLIC_API_URL baked into the JS bundle,
# then copy the artifact next to the Node API for admin download (uploads/mobile/GoDam.apk).
#
# Prerequisites (local or VPS):
#   - Node 20+ and npm
#   - JDK 17 or 21 (ANDROID_HOME build uses Gradle's toolchain if configured)
#   - Android SDK: set ANDROID_HOME, install platform-android-35 (or whatever android/build.gradle expects)
#
# Usage:
#   EXPO_PUBLIC_API_URL=https://your.domain ./scripts/build-godam-android-release-apk.sh

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API_URL="${EXPO_PUBLIC_API_URL:-https://godam.divadivya.cloud}"

cd "$ROOT/godam-mobile"
export NODE_ENV=production
export EXPO_PUBLIC_API_URL="$API_URL"

if [[ ! -f android/gradlew ]]; then
  echo "android/gradlew missing. Run: cd godam-mobile && npx expo prebuild --platform android" >&2
  exit 1
fi

npm install
npm run android:release-apk

SRC="$ROOT/godam-mobile/android/app/build/outputs/apk/release/app-release.apk"
if [[ ! -f "$SRC" ]]; then
  echo "Expected APK not found: $SRC" >&2
  exit 1
fi

DEST_DIR="$ROOT/backend/uploads/mobile"
mkdir -p "$DEST_DIR"
cp -f "$SRC" "$DEST_DIR/GoDam.apk"
echo "OK: $DEST_DIR/GoDam.apk ($(wc -c < "$DEST_DIR/GoDam.apk" | tr -d ' ') bytes)"
echo "API origin embedded at build time: $API_URL (bundle uses /api paths via app config + client)"
