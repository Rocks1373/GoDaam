#!/usr/bin/env bash
# Start Expo Metro for godam-mobile and open the project in Expo Go on a connected Android
# emulator without using `expo start --android`.
#
# Why: Expo CLI opens Expo Go via `adb shell monkey`, which often exits 251 on newer
# emulators (e.g. API 35) with: "SYS_KEYS has no physical keys but with factor 2.0%."
# Opening exp://… with `am start` avoids monkey entirely.
#
# Usage (from repo root):
#   bash scripts/expo-start-android-emulator.sh
# From godam-mobile:
#   bash ../scripts/expo-start-android-emulator.sh
#
# Env:
#   GODAM_EXPO_PORT   Metro port (default: 8090)
#   GODAM_ANDROID_SERIAL  Optional `adb -s` serial (default: first emulator-* line)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PORT="${GODAM_EXPO_PORT:-8090}"

export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}"
if [[ -z "${ANDROID_SDK_ROOT:-}" ]]; then
  if [[ -d "$HOME/Library/Android/sdk" ]]; then
    export ANDROID_SDK_ROOT="$HOME/Library/Android/sdk"
  elif [[ -d "$HOME/Android/Sdk" ]]; then
    export ANDROID_SDK_ROOT="$HOME/Android/Sdk"
  fi
fi
export ANDROID_HOME="${ANDROID_HOME:-$ANDROID_SDK_ROOT}"
ADB="${ANDROID_SDK_ROOT}/platform-tools/adb"
if [[ ! -x "$ADB" ]]; then
  printf '%s\n' "adb not found at $ADB — set ANDROID_HOME / ANDROID_SDK_ROOT." >&2
  exit 1
fi

"$ADB" start-server >/dev/null 2>&1 || true

if [[ -n "${GODAM_ANDROID_SERIAL:-}" ]]; then
  SERIAL="$GODAM_ANDROID_SERIAL"
else
  SERIAL="$("$ADB" devices 2>/dev/null | awk '/^emulator-[^[:space:]]+[[:space:]]+device$/ { print $1; exit }')"
fi
if [[ -z "$SERIAL" ]]; then
  printf '%s\n' "No booted Android emulator in adb (need emulator-* with state 'device')." >&2
  printf '%s\n' "Start an AVD first, or set GODAM_ANDROID_SERIAL." >&2
  exit 1
fi

ADB_S=("$ADB" -s "$SERIAL")

wait_for_metro() {
  local p="$1" i
  for i in $(seq 1 90); do
    if command -v lsof >/dev/null 2>&1; then
      if lsof -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
        return 0
      fi
    elif command -v curl >/dev/null 2>&1; then
      if curl -sf "http://127.0.0.1:${p}/" >/dev/null 2>&1; then
        return 0
      fi
    else
      : # no lsof/curl; rely on outer sleep only
    fi
    sleep 1
  done
  printf '%s\n' "Timed out waiting for Metro on port $p" >&2
  return 1
}

cd "$ROOT_DIR/godam-mobile"

expo_pid=""
on_int() {
  if [[ -n "${expo_pid}" ]] && kill -0 "$expo_pid" 2>/dev/null; then
    kill "$expo_pid" 2>/dev/null || true
    wait "$expo_pid" 2>/dev/null || true
  fi
  exit 130
}
trap on_int INT
trap 'on_int' TERM

printf '%s\n' "Starting Metro (port $PORT). Expo Go will open via adb intent (no monkey)."
npx expo start --port "$PORT" &
expo_pid=$!

if ! wait_for_metro "$PORT"; then
  kill "$expo_pid" 2>/dev/null || true
  wait "$expo_pid" 2>/dev/null || true
  exit 1
fi

# Extra beat so the dev server is ready to answer the manifest request.
sleep 2

# 10.0.2.2 is the emulator's alias for the host machine (stable vs LAN IP).
printf '%s\n' "Opening exp://10.0.2.2:${PORT} in Expo Go${SERIAL:+ on $SERIAL}…"
"${ADB_S[@]}" shell am start -a android.intent.action.VIEW \
  -d "exp://10.0.2.2:${PORT}" host.exp.exponent >/dev/null

wait "$expo_pid"
