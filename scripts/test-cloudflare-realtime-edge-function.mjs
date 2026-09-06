import assert from 'node:assert/strict';
import fs from 'node:fs';

const functionPath = new URL('../supabase/functions/cloudflare-realtime/index.ts', import.meta.url);
assert.equal(
  fs.existsSync(functionPath),
  true,
  'cloudflare-realtime Edge Function source must exist',
);

const source = fs.readFileSync(functionPath, 'utf8');
assert.match(source, /CLOUDFLARE_REALTIME_APP_ID/);
assert.match(source, /CLOUDFLARE_REALTIME_APP_SECRET/);
assert.match(source, /get_board_access_v4/);
assert.match(source, /https:\/\/rtc\.live\.cloudflare\.com\/v1/);
assert.match(source, /Authorization/);
assert.match(source, /Bearer/);
assert.match(source, /HMAC/);
assert.match(source, /sessionLease/);
assert.match(source, /crypto\.subtle\.verify/);
assert.doesNotMatch(source, /VITE_.*CLOUDFLARE/i);

for (const operation of [
  'create-publisher-session',
  'publish-track',
  'create-viewer-session',
  'subscribe-track',
  'renegotiate-viewer',
  'close-track',
]) {
  assert.match(source, new RegExp(operation), `${operation} must be a fixed server operation`);
}

assert.match(
  source,
  /permission === "owner" \|\| permission === "edit"/,
  'publisher mutations must require owner or edit permission',
);
assert.match(source, /force:\s*true/, 'track close should use forced teardown without final renegotiation');
assert.match(source, /tracks:\s*\[\{\s*mid\s*\}\]/, 'close-track must target only a validated mid');

assert.match(
  source,
  /callCloudflare\(appId, appSecret, "\/sessions\/new", "POST"\)/,
  'Cloudflare sessions/new must be called without a JSON request body',
);
assert.doesNotMatch(
  source,
  /callCloudflare\(appId, appSecret, "\/sessions\/new", "POST", \{\}\)/,
  'Cloudflare sessions/new rejects an empty JSON object with decoding_error',
);

console.log('Cloudflare Edge Function source tests passed');
