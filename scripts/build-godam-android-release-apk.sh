#!/usr/bin/env bash
# Build GoDam Android release APK with EXPO_PUBLIC_API_URL baked into the JS bundle,
# then copy the artifact next to the Node API for admin download (uploads/mobile/GoDam.apk).
#
# Release output is a standalone phone APK (ARM only: armeabi-v7a + arm64-v8a). For a private release keystore,
# copy godam-mobile/android/keystore.properties.example → keystore.properties and add your .jks (see file comments).
#
# Prefer the entry point: bash scripts/build-android-apk.sh [--prebuild]
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
  echo "android/gradlew missing. Run: bash scripts/build-android-apk.sh --prebuild" >&2
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
if command -v unzip >/dev/null 2>&1; then
  unzip -tqq "$DEST_DIR/GoDam.apk" || {
    echo "APK failed ZIP integrity test (file is not a valid Android package)." >&2
    exit 1
  }
fi
if [[ -n "${ANDROID_HOME:-}" ]]; then
  apksigner_bin="$(find "$ANDROID_HOME/build-tools" -maxdepth 2 -name apksigner -type f 2>/dev/null | sort -V | tail -1)"
  if [[ -n "$apksigner_bin" && -x "$apksigner_bin" ]]; then
    v1_ok="$("$apksigner_bin" verify --verbose "$DEST_DIR/GoDam.apk" 2>&1 | grep -c 'v1 scheme (JAR signing): true' || true)"
    if [[ "${v1_ok:-0}" -lt 1 ]]; then
      echo "APK missing v1 (JAR) signature — re-signing for sideload compatibility..."
      ks="$ROOT/godam-mobile/android/app/debug.keystore"
      "$apksigner_bin" sign \
        --ks "$ks" \
        --ks-pass pass:android \
        --ks-key-alias androiddebugkey \
        --key-pass pass:android \
        --v1-signing-enabled true \
        --v2-signing-enabled true \
        --v3-signing-enabled true \
        "$DEST_DIR/GoDam.apk"
    fi
    "$apksigner_bin" verify "$DEST_DIR/GoDam.apk" || {
      echo "apksigner verify failed." >&2
      exit 1
    }
  fi
fi
apk_bytes="$(wc -c < "$DEST_DIR/GoDam.apk" | tr -d ' ')"
if command -v shasum >/dev/null 2>&1; then
  shasum -a 256 "$DEST_DIR/GoDam.apk" | awk '{print $1}' > "$DEST_DIR/GoDam.apk.sha256"
  echo "SHA256: $(cat "$DEST_DIR/GoDam.apk.sha256")"
fi
echo "OK: $DEST_DIR/GoDam.apk (${apk_bytes} bytes) — on phone, file size must match exactly"
echo "API origin embedded at build time: $API_URL (bundle uses /api paths via app config + client)"
