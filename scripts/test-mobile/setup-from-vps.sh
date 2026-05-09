#!/usr/bin/env bash
# Create test/godam-mobile: mirror of godam-mobile + .env from VPS backend env (base64 on disk).
#
# Pull (one of):
#   VPS_SSH=user@host  — scp REMOTE_ENV_PATH (default /etc/godaam/backend.env) to test/.pulled-backend.env
#   VPS_ENV_FILE=/path/to/backend.env  — use local file (no SSH)
#   SKIP_PULL=1  — reuse existing test/.pulled-backend.env
#
# Then: rsync godam-mobile → test/godam-mobile (excludes heavy dirs), run write-encoded-env.mjs

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC_MOBILE="$ROOT/godam-mobile"
DEST_MOBILE="$ROOT/test/godam-mobile"
PULL="$ROOT/test/.pulled-backend.env"
REMOTE_ENV="${REMOTE_ENV_PATH:-/etc/godaam/backend.env}"

mkdir -p "$ROOT/test"

if [[ -n "${VPS_ENV_FILE:-}" ]]; then
  echo "Using local env file: $VPS_ENV_FILE"
  cp -f "$VPS_ENV_FILE" "$PULL"
elif [[ -n "${VPS_SSH:-}" ]]; then
  echo "Pulling $REMOTE_ENV from $VPS_SSH ..."
  scp -o BatchMode=yes "${VPS_SSH}:${REMOTE_ENV}" "$PULL"
elif [[ "${SKIP_PULL:-0}" == "1" ]] && [[ -f "$PULL" ]]; then
  echo "SKIP_PULL=1 — using existing $PULL"
else
  echo "Provide one of:" >&2
  echo "  VPS_SSH=user@host   (optional REMOTE_ENV_PATH=/path on server)" >&2
  echo "  VPS_ENV_FILE=/local/copy/of/backend.env" >&2
  echo "  SKIP_PULL=1 with existing test/.pulled-backend.env" >&2
  exit 1
fi

if [[ ! -f "$PULL" ]]; then
  echo "Missing pulled env: $PULL" >&2
  exit 1
fi

if [[ ! -d "$SRC_MOBILE" ]]; then
  echo "Missing $SRC_MOBILE" >&2
  exit 1
fi

echo "Syncing $SRC_MOBILE → $DEST_MOBILE ..."
mkdir -p "$DEST_MOBILE"
rsync -a \
  --delete \
  --exclude node_modules \
  --exclude android/app/build \
  --exclude android/.gradle \
  --exclude android/build \
  --exclude ios/build \
  --exclude ios/Pods \
  --exclude .expo \
  --exclude .git \
  --exclude '.env' \
  --exclude '.env.*' \
  --exclude '*.apk' \
  "$SRC_MOBILE/" "$DEST_MOBILE/"

node "$ROOT/scripts/test-mobile/write-encoded-env.mjs" "$PULL" "$DEST_MOBILE/.env"

echo ""
echo "Done. Test app tree: $DEST_MOBILE"
if [[ "${BUILD_APK:-0}" == "1" ]]; then
  echo "BUILD_APK=1 — running Gradle release..."
  "$ROOT/scripts/test-mobile/build-apk.sh"
else
  echo "Build APK:  BUILD_APK=1 $0  (same pull env vars)"
  echo "Or manual:  cd test/godam-mobile && npm install && npm run android:release-apk"
fi
