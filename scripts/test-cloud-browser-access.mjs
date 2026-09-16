import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { deriveShareKey } from '../src/lib/ids.js';
import { createCloudflareScreenShareApi } from '../src/lib/cloudflareScreenShare.js';

const ownerKey = Buffer.alloc(28, 47).toString('base64url');
const roomKey = await deriveShareKey(ownerKey);
const base = { boardId: 'local-board-regression', boardKey: ownerKey, roomKey,
  authorityMode: 'browser-v1', screenShareSessionId: 'screen-regression' };
function fixture({ legacyPermission = null } = {}) {
  const calls = [], rpcCalls = [];
  const ctx = { supabase: { rpc: async (...args) => {
    rpcCalls.push(args); return { data: legacyPermission ? [{ permission: legacyPermission }] : [], error: null };
  } } };
  const source = readFileSync(new URL('../supabase/functions/cloudflare-realtime/index.ts', import.meta.url), 'utf8');
  const js = stripTypeScriptTypes(source.replace(/^import .*;\r?\n/gm, '')).replace('export default {', 'return {');
  const handler = new Function('withSupabase', 'Deno', 'fetch', js)(
    (_config, fn) => (req) => fn(req, ctx),
    { env: { get: (key) => key === 'CLOUDFLARE_REALTIME_APP_ID' ? 'test-app' : 'test-server-secret' } },
    async (url, options) => { calls.push({ url, ...options, parsed: options.body ? JSON.parse(options.body) : null });
      return Response.json(url.endsWith('/sessions/new') ? { sessionId: `session-${calls.length}` }
        : { sessionDescription: { type: 'answer', sdp: 'fixture' }, tracks: [{ mid: '0' }] }); },
  ).fetch;
  return { calls, rpcCalls, async request(operation, patch = {}) {
    const response = await handler(new Request('https://example.invalid/cloud', {
      method: 'POST', body: JSON.stringify({ ...base, operation, ...patch }),
    }));
    return { status: response.status, body: await response.json() };
  } };
}

test('browser-only owner creates Cloud session without a nonexistent database board', async () => {
  const f = fixture(); const result = await f.request('create-publisher-session');
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.ok(result.body.sessionLease); assert.equal(f.rpcCalls.length, 0);
});
test('a shared-link viewer cannot claim publisher permission', async () => {
  const f = fixture();
  const result = await f.request('create-publisher-session', { boardKey: roomKey, permission: 'owner', canEdit: true });
  assert.equal(result.status, 403); assert.equal(f.calls.length, 0);
});
test('an unrelated owner key cannot publish into the actual room', async () => {
  const f = fixture(); const result = await f.request('create-publisher-session', { boardKey: Buffer.alloc(28, 5).toString('base64url') });
  assert.equal(result.status, 403); assert.equal(f.calls.length, 0);
});
test('owner authorizes an editing guest with a signed screen-specific grant', async () => {
  const f = fixture(); const grant = await f.request('authorize-browser-publisher');
  assert.equal(grant.status, 200); assert.ok(grant.body.publisherGrant); assert.equal(f.calls.length, 0);
  const guest = await f.request('create-publisher-session', { boardKey: roomKey, publisherGrant: grant.body.publisherGrant });
  assert.equal(guest.status, 200, JSON.stringify(guest.body)); assert.ok(guest.body.sessionLease);
});
for (const alteration of ['tampered', 'other-room', 'other-screen']) {
  test(`publisher grants reject ${alteration}`, async () => {
    const f = fixture(); const grant = await f.request('authorize-browser-publisher');
    assert.equal(grant.status, 200);
    const patch = { boardKey: roomKey, publisherGrant: grant.body.publisherGrant };
    if (alteration === 'tampered') patch.publisherGrant = `X${patch.publisherGrant.slice(1)}`;
    if (alteration === 'other-room') patch.roomKey = patch.boardKey = await deriveShareKey('different-owner-key-123456789');
    if (alteration === 'other-screen') patch.screenShareSessionId = 'another-screen';
    assert.equal((await f.request('create-publisher-session', patch)).status, 403);
  });
}
test('shared-link viewer creates a read-only session; signed viewer lease cannot publish', async () => {
  const f = fixture(); const viewer = await f.request('create-viewer-session', { boardKey: roomKey });
  assert.equal(viewer.status, 200);
  const denied = await f.request('publish-track', { boardKey: roomKey, ...viewer.body, mid: '0', sdp: 'test' });
  assert.equal(denied.status, 403);
});
test('browser tracks and leases are cryptographically isolated from another room and legacy scope', async () => {
  const f = fixture(); const publisher = await f.request('create-publisher-session');
  assert.equal(publisher.status, 200);
  assert.equal((await f.request('publish-track', { ...publisher.body, mid: '0', sdp: 'test' })).status, 200);
  const trackName = f.calls.at(-1).parsed.tracks[0].trackName;
  assert.ok(trackName.startsWith('screen:local-board-regression:screen-regression:'));
  assert.ok(!trackName.includes(ownerKey) && !trackName.includes(roomKey));
  const otherOwner = Buffer.alloc(28, 12).toString('base64url');
  const denied = await f.request('close-track', { ...publisher.body, mid: '0', boardKey: otherOwner, roomKey: await deriveShareKey(otherOwner) });
  assert.equal(denied.status, 403);
  const legacy = fixture({ legacyPermission: 'owner' });
  assert.equal((await legacy.request('close-track', { ...publisher.body, mid: '0', authorityMode: undefined, roomKey: undefined })).status, 403);
});
test('legacy board access still fails closed; there is no implicit fallback to link-only authorization', async () => {
  const f = fixture(); const result = await f.request('create-publisher-session', { authorityMode: undefined, roomKey: undefined });
  assert.equal(result.status, 403); assert.equal(f.rpcCalls.length, 1); assert.equal(f.calls.length, 0);
});
test('unknown authority modes fail rather than silently weakening access checks', async () => {
  assert.equal((await fixture({ legacyPermission: 'owner' }).request('create-publisher-session', { authorityMode: 'unknown' })).status, 400);
});
test('Cloud API sends explicit browser room scope and obtains the guest grant only for publishing', async () => {
  const calls = []; let grants = 0;
  const api = createCloudflareScreenShareApi({ boardId: base.boardId, boardKey: roomKey, roomKey,
    screenShareSessionId: base.screenShareSessionId, getPublisherGrant: async () => { grants++; return 'signed-grant'; },
    supabase: { functions: { invoke: async (_name, value) => { calls.push(value.body); return { data: { sessionId: 'session-1' }, error: null }; } } },
  });
  await api.createViewerSession(); assert.equal(grants, 0);
  await api.createPublisherSession(); assert.equal(grants, 1);
  assert.equal(calls[1].authorityMode, 'browser-v1'); assert.equal(calls[1].roomKey, roomKey);
  assert.equal(calls[1].publisherGrant, 'signed-grant');
});
test('Cloud UI receives the actual access error instead of generic non-2xx text', async () => {
  const api = createCloudflareScreenShareApi({ boardId: base.boardId, boardKey: ownerKey, screenShareSessionId: base.screenShareSessionId,
    supabase: { functions: { invoke: async () => ({ data: null, error: {
      message: 'Edge Function returned a non-2xx status code', context: Response.json({ error: 'Publisher permission required' }, { status: 403 }),
    } }) } },
  });
  await assert.rejects(api.createPublisherSession(), /Publisher permission required/);
});
