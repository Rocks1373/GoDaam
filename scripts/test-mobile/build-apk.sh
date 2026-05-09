#!/usr/bin/env bash
# Build release APK from test/godam-mobile (expects .env with *_B64 from setup-from-vps.sh).

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APP="$ROOT/test/godam-mobile"

if [[ ! -f "$APP/.env" ]]; then
  echo "Missing $APP/.env — run scripts/test-mobile/setup-from-vps.sh first." >&2
  exit 1
fi
if [[ ! -f "$APP/android/gradlew" ]]; then
  echo "Missing android/gradlew under $APP — run expo prebuild in godam-mobile first, then re-run setup." >&2
  exit 1
fi

cd "$APP"
set -a
# shellcheck disable=SC1091
source ./.env
set +a

export NODE_ENV=production
npm install
npm run android:release-apk

OUT="$APP/android/app/build/outputs/apk/release/app-release.apk"
if [[ ! -f "$OUT" ]]; then
  echo "APK not found: $OUT" >&2
  exit 1
fi
echo "Built: $OUT"
cp -f "$OUT" "$ROOT/test/GoDam-test-release.apk" || true
echo "Also copied to: $ROOT/test/GoDam-test-release.apk (if writable)"
