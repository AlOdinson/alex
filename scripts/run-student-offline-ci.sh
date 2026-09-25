#!/usr/bin/env bash
# Test infrastructure only. Never source this from the application or deployment.
set -euo pipefail
mkdir -p verification-evidence bounded-browser-results
server_pid=''
turn_pid=''
cleanup() {
  if [ -n "$server_pid" ]; then kill "$server_pid" 2>/dev/null || true; fi
  if [ -n "$turn_pid" ]; then kill "$turn_pid" 2>/dev/null || true; fi
}
trap cleanup EXIT
if [ "${VERIFICATION_BROWSER:-chromium}" = webkit ]; then
  # Hosted macOS browser processes may not establish a direct local ICE path.
  # A loopback-only, authenticated relay tests the native encrypted DataChannel
  # without making CI dependent on its external NAT. Production ICE is unchanged.
  if ! command -v turnserver >/dev/null; then
    HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1 brew install coturn
  fi
  turnserver -n --listening-ip=127.0.0.1 --relay-ip=127.0.0.1 \
    --listening-port=3478 --realm=bounded-ci --lt-cred-mech \
    --user=bounded-ci:bounded-ci-loopback-only-20260925 \
    --allow-loopback-peers --no-cli --cli-password=bounded-ci-control-only \
    --no-tls --no-dtls --no-multicast-peers --min-port=49160 --max-port=49260 \
    --pidfile=/tmp/bounded-turn.pid --log-file=stdout \
    > verification-evidence/test-relay.txt 2>&1 &
  turn_pid=$!
  sleep 1
  kill -0 "$turn_pid"
  export VERIFICATION_TEST_TURN=1
fi
npm run dev -- --host 127.0.0.1 > verification-evidence/vite.txt 2>&1 &
server_pid=$!
for i in $(seq 1 30); do
  if curl -fsS "${VERIFICATION_TEST_URL:-http://127.0.0.1:5173/alex/}" >/dev/null; then break; fi
  sleep 1
done
curl -fsS "${VERIFICATION_TEST_URL:-http://127.0.0.1:5173/alex/}" >/dev/null
node scripts/test-student-offline-e2e.mjs 2>&1 | tee verification-evidence/browser.txt
