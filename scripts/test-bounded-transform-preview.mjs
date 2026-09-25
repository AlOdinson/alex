import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserAuthorityRealtimeCore } from '../src/lib/browserAuthorityRealtimeCore.js';
const frames = (n) => Array.from({ length: n }, (_, i) => ({ id: `object-${i}`, matrix: [1, 0, 0, 1, i + 35, i + 25],
  updatedAt: 1790312345678 + i, objectType: 'path', objectKind: 'path',
  creationClientId: 'teacher-123456789', creationSessionId: `creation-session-123456789-${i}` }));
function core(publish, enabled = true) {
  return createBrowserAuthorityRealtimeCore({ clientId: 'owner', name: 'Преподаватель 🙂',
    session: { sendOps: async (ops) => ({ revision: 1, appliedOps: ops }),
      getVerificationStats: () => ({ enabled }) }, publish });
}
const frame = (sequence = 1, phase = 'update', count = 300) => ({ objects: frames(count),
  sessionId: 'gesture', sessionOrder: 1, sequence, phase, mode: 'objects' });
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };

test('new-board 300-member live move fits the byte limit without losing objects', async () => {
  const sent = []; const c = core(async (event, payload) => {
    assert.ok(new TextEncoder().encode(JSON.stringify(payload)).length <= 48000, 'preview payload exceeds safe byte budget');
    sent.push({ event, payload });
  });
  await c.sendTransform(frame(1, 'start'));
  assert.equal(sent.length, 3);
  assert.ok(sent.every((m) => m.payload.objects.length <= 100));
  assert.deepEqual(sent.flatMap((m) => m.payload.objects.map((o) => o.id)), frames(300).map((o) => o.id));
  assert.equal(new Set(sent.map((m) => m.payload.sessionId)).size, 3, 'chunks need independent receiver sequence fences');
  const sessions = sent.map((m) => m.payload.sessionId);
  sent.length = 0; await c.sendTransform(frame(2, 'end'));
  assert.deepEqual(sent.map((m) => m.payload.sessionId), sessions, 'stable chunk identities through end');
  assert.ok(sent.every((m) => m.payload.phase === 'end' && m.payload.sequence === 2));
  await c.disconnect();
});

test('slow previews coalesce transient updates, never overlap, and do not delay durable actions', async () => {
  let release; const held = new Promise((r) => { release = r; }); const sent = [];
  let active = 0; let maxActive = 0;
  const c = core(async (_event, payload) => {
    active++; maxActive = Math.max(maxActive, active); sent.push(payload.sequence);
    if (sent.length === 1) await held;
    active--; return 'ok';
  });
  const first = c.sendTransform(frame(1, 'start', 1)); await flush();
  const updates = [];
  for (let i = 2; i <= 50; i++) updates.push(c.sendTransform(frame(i, 'update', 1)));
  const last = c.sendTransform(frame(51, 'end', 1)); await flush();
  assert.equal(maxActive, 1, 'transient publishes must not pile up');
  const commit = await c.sendOps([{ type: 'delete', id: 'unrelated' }]);
  assert.equal(commit.revision, 1);
  release(); await Promise.all([first, ...updates, last]);
  assert.deepEqual(sent, [1, 51], 'keep the newest preview, not 49 obsolete ones');
  await c.disconnect();
});

test('new-board preview errors are contained; canonical moves are not rejected', async () => {
  const c = core(() => { throw new Error('offline preview'); });
  assert.equal(await c.sendTransform(frame(1, 'end', 2)), 'failed');
  assert.equal((await c.sendOps([{ type: 'transform', objects: [{ id: 'a', transform: { left: 50 } }] }])).revision, 1);
  await c.disconnect();
});

test('old boards keep one unchanged preview envelope', async () => {
  const sent = []; const c = core(async (event, payload) => { sent.push({ event, payload }); }, false);
  const transform = frame(); await c.sendTransform(transform);
  assert.equal(sent.length, 1); assert.equal(sent[0].payload.sessionId, 'gesture');
  assert.deepEqual(sent[0].payload.objects, transform.objects);
  await c.disconnect();
});

test('an oversized individual preview stays out of the network, including multibyte data', async () => {
  const sent = []; const c = core(async (_event, payload) => { sent.push(payload); });
  const payload = frame(1, 'end', 1); payload.objects[0].creationSessionId = '🙂'.repeat(20000);
  assert.equal(await c.sendTransform(payload), 'too-large');
  assert.equal(sent.length, 0);
  await c.disconnect();
});
