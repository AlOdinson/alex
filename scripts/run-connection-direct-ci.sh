#!/usr/bin/env bash
set -euo pipefail
mkdir -p connection-direct-results
npm run dev -- --host 127.0.0.1 > connection-direct-results/vite.log 2>&1 &
connection_vite_pid=$!
trap 'kill "$connection_vite_pid" 2>/dev/null || true' EXIT
for i in $(seq 1 30); do
  if curl -fsS "${VERIFICATION_TEST_URL:-http://127.0.0.1:5173/alex/}" >/dev/null; then break; fi
  sleep 1
done
curl -fsS "${VERIFICATION_TEST_URL:-http://127.0.0.1:5173/alex/}" >/dev/null
node scripts/test-connection-direct-browser.mjs
