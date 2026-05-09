#!/usr/bin/env bash
# One-shot: ensure an Android emulator is running, then start Metro and open the app on it.
# Requires: Android SDK (Android Studio), backend API on port 3001 for full functionality.
#
# Usage:
#   ./scripts/run-android-emulator.sh
#   GODAM_AVD=Pixel_8_API_35 ./scripts/run-android-emulator.sh   # pick AVD by name
#
# From repo root with npm:
#   npm run android:emu
#
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Non-interactive shells do not load ~/.zshrc; put Homebrew / common paths on PATH.
if [[ -x /opt/homebrew/bin/brew ]]; then
  eval "$(/opt/homebrew/bin/brew shellenv)"
elif [[ -x /usr/local/bin/brew ]]; then
  eval "$(/usr/local/bin/brew shellenv)"
fi

export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}"
if [[ -z "${ANDROID_SDK_ROOT:-}" ]]; then
  if [[ -d "$HOME/Library/Android/sdk" ]]; then
    export ANDROID_SDK_ROOT="$HOME/Library/Android/sdk"
  elif [[ -d "$HOME/Android/Sdk" ]]; then
    export ANDROID_SDK_ROOT="$HOME/Android/Sdk"
  fi
fi
export ANDROID_HOME="${ANDROID_HOME:-$ANDROID_SDK_ROOT}"

if [[ -z "${ANDROID_SDK_ROOT:-}" || ! -d "$ANDROID_SDK_ROOT" ]]; then
  printf '%s\n' "Set ANDROID_HOME / ANDROID_SDK_ROOT to your Android SDK (e.g. ~/Library/Android/sdk on macOS)." >&2
  exit 1
fi

EMULATOR="$ANDROID_SDK_ROOT/emulator/emulator"
ADB="$ANDROID_SDK_ROOT/platform-tools/adb"

if [[ ! -x "$ADB" ]]; then
  printf '%s\n' "adb not found at $ADB — install Android SDK platform-tools." >&2
  exit 1
fi

"$ADB" start-server >/dev/null 2>&1 || true

port_listening() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
  else
    # Linux fallback
    ss -tuln 2>/dev/null | grep -q ":${port} " || netstat -tuln 2>/dev/null | grep -q ":${port} "
  fi
}

if ! port_listening 3001; then
  printf '%s\n' "Warning: nothing is listening on port 3001. Start the API first, e.g.:" >&2
  printf '%s\n' "  cd \"$ROOT_DIR\" && npm run start --workspace backend" >&2
  printf '%s\n' "  # or: ./dev.sh   (backend + web)" >&2
  printf '%s\n' "" >&2
fi

# Is an emulator already connected and ready?
emu_ready() {
  "$ADB" devices 2>/dev/null | awk '/^emulator-[0-9]+/ && $2 == "device" { found=1 } END { exit !found }'
}

if emu_ready; then
  echo "Android emulator already running."
else
  if [[ ! -x "$EMULATOR" ]]; then
    printf '%s\n' "emulator binary not found at $EMULATOR" >&2
    exit 1
  fi

  AVD="${GODAM_AVD:-}"
  if [[ -z "$AVD" ]]; then
    AVD="$("$EMULATOR" -list-avds 2>/dev/null | head -1 | tr -d '\r')"
  fi
  if [[ -z "$AVD" ]]; then
    printf '%s\n' "No AVDs found. Create a virtual device in Android Studio → Device Manager," >&2
    printf '%s\n' "or set GODAM_AVD to an existing name (see: $EMULATOR -list-avds)." >&2
    exit 1
  fi

  echo "Starting AVD: $AVD"
  # Run in background; user keeps this terminal for Metro.
  nohup "$EMULATOR" -avd "$AVD" -netdelay none -netspeed full >>"${TMPDIR:-/tmp}/godam-android-emulator.log" 2>&1 &
  echo "Emulator log: ${TMPDIR:-/tmp}/godam-android-emulator.log"

  echo -n "Waiting for adb device..."
  "$ADB" wait-for-device
  echo " OK"

  echo -n "Waiting for Android boot..."
  for _ in $(seq 1 90); do
    done="$("$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)"
    if [[ "$done" == "1" ]]; then
      echo " OK"
      break
    fi
    sleep 2
  done
fi

# Do not use `expo start --android`: it launches Expo Go via `adb monkey`, which often
# fails on API 35+ with exit 251. Use scripts/expo-start-android-emulator.sh instead.
exec bash "$ROOT_DIR/scripts/expo-start-android-emulator.sh"
