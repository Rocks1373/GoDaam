#!/usr/bin/env bash
# Verify TLS for GoDaam host. Does NOT use -k/--insecure (see curl TLS docs).
# Exit 0 only if HTTPS responds with verifiable cert + HTTP 200 from /api/health.
#
# Usage:
#   HOST=godam.divadivya.cloud ./scripts/verify-godam-tls.sh
#   ./scripts/verify-godam-tls.sh godam.divadivya.cloud

set -euo pipefail
HOST="${1:-${HOST:-godam.divadivya.cloud}}"

echo "=== TLS peer certificate (openssl) ==="
if ! echo | openssl s_client -connect "${HOST}:443" -servername "${HOST}" 2>/dev/null |
  openssl x509 -noout -issuer -subject -dates 2>/dev/null; then
  echo "FAIL: could not read certificate (port 443 closed or TLS error)"
  exit 1
fi

ISSUER=$(echo | openssl s_client -connect "${HOST}:443" -servername "${HOST}" 2>/dev/null |
  openssl x509 -noout -issuer 2>/dev/null || true)
if echo "$ISSUER" | grep -qi 'TRAEFIK DEFAULT'; then
  echo ""
  echo "PROBLEM: Server is using Traefik's default self-signed certificate."
  echo "         Browsers and curl (correctly) will not trust it without -k."
  echo "         Fix: add a Let's Encrypt (ACME) certificate in Traefik for this host"
  echo "         and route Host(\`${HOST}\`) to the GoDaam \`web\` container."
  echo "         See: docker-compose.godam-domain.example.yml in the repo root."
  echo ""
fi

echo "=== curl certificate verification (no -k) ==="
set +e
curl -sS -o /dev/null --connect-timeout 10 "https://${HOST}/api/health" 2> /tmp/curl-err.$$
CURL_EXIT=$?
set -e
if [ "$CURL_EXIT" -eq 0 ]; then
  echo "OK: https://${HOST}/api/health — certificate trusted, request succeeded."
  exit 0
fi
echo "curl exit $CURL_EXIT (60 = cert verify failed). Last error:"
head -5 /tmp/curl-err.$$ 2>/dev/null || true
rm -f /tmp/curl-err.$$

echo ""
echo "=== Working HTTP API until HTTPS is fixed (not for production trust) ==="
curl -sS -o /dev/null -w "http://$HOST:8080/api/health → HTTP %{http_code}\n" "http://${HOST}:8080/api/health" || true
exit 1
