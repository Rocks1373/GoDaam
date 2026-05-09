#!/usr/bin/env bash
# Convenience wrapper: same as scripts/test-mobile/setup-from-vps.sh
exec "$(cd "$(dirname "$0")" && pwd)/test-mobile/setup-from-vps.sh" "$@"
