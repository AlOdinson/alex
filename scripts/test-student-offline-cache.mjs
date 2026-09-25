import assert from 'node:assert/strict';
import test from 'node:test';
import { createStudentOfflineRecorder, readStudentOfflineSnapshot, studentOfflineScope } from '../src/lib/studentOfflineCache.js';
function store() {
  const values = new Map();
  return { values, async replace(key, value) { values.set(key, { ...structuredClone(value), commits: [] }); },
    async append(key, value) { values.get(key)?.commits.push(structuredClone(value)); },
    async read(key) { return structuredClone(values.get(key) ?? null); } };
}
const empty = () => ({ version: 2, background: 'grid', canvas: { objects: [] } });
const upsert = (id, left = 1) => ({ type: 'upsert', object: { type: 'rect', boardObjectId: id, left }, zIndex: 0 });

test('reopening restores baseline plus confirmed add, move, delete, and restore', async () => {
  const storage = store(); const options = { boardId: 'a', roomKey: 'share', storage };
  const writer = createStudentOfflineRecorder(options);
  writer.snapshot(empty(), 0);
  writer.commit({ revision: 1, ops: [upsert('old-note')] });
  writer.commit({ revision: 2, ops: [upsert('old-note', 800)] });
  writer.commit({ revision: 3, ops: [{ type: 'delete', id: 'old-note' }] });
  writer.commit({ revision: 4, ops: [upsert('old-note', 800)] });
  await writer.flush(); writer.close();
  const result = await readStudentOfflineSnapshot('a', 'share', { storage });
  assert.equal(result.revision, 4); assert.equal(result.snapshot.canvas.objects[0].left, 800);
});

test('different share keys and different boards cannot read the saved copy', async () => {
  const storage = store(); const writer = createStudentOfflineRecorder({ boardId: 'a', roomKey: 'secret', storage });
  writer.snapshot(empty(), 4); await writer.flush();
  assert.equal(await readStudentOfflineSnapshot('a', 'wrong', { storage }), null);
  assert.equal(await readStudentOfflineSnapshot('b', 'secret', { storage }), null);
  assert.ok(![...storage.values.keys()][0].includes('secret'));
});

test('a gap never labels a partly reconstructed archive with a later revision', async () => {
  const storage = store(); const writer = createStudentOfflineRecorder({ boardId: 'a', roomKey: 's', storage });
  writer.snapshot(empty(), 4);
  writer.commit({ revision: 5, ops: [upsert('five')] });
  writer.commit({ revision: 7, ops: [upsert('seven')] }); await writer.flush();
  const result = await readStudentOfflineSnapshot('a', 's', { storage });
  assert.equal(result.revision, 5); assert.deepEqual(result.snapshot.canvas.objects.map(o => o.boardObjectId), ['five']);
});

test('a new owner baseline clears obsolete cached tail, including a lower authoritative revision', async () => {
  const storage = store(); const writer = createStudentOfflineRecorder({ boardId: 'a', roomKey: 's', storage });
  writer.snapshot(empty(), 10); writer.commit({ revision: 11, ops: [upsert('obsolete')] });
  writer.snapshot(empty(), 0); writer.commit({ revision: 1, ops: [upsert('new')] }); await writer.flush();
  const result = await readStudentOfflineSnapshot('a', 's', { storage });
  assert.equal(result.revision, 1); assert.deepEqual(result.snapshot.canvas.objects.map(o => o.boardObjectId), ['new']);
});

test('cache work neither waits in a commit caller nor keeps mutable references', async () => {
  const storage = store(); let release;
  const original = storage.replace;
  storage.replace = async (...args) => { await new Promise(r => { release = r; }); return original(...args); };
  const writer = createStudentOfflineRecorder({ boardId: 'a', roomKey: 's', storage });
  const baseline = empty(); assert.equal(writer.snapshot(baseline, 0), undefined);
  baseline.canvas.objects.push({ boardObjectId: 'unconfirmed-local' });
  const commit = { revision: 1, ops: [upsert('real', 50)] };
  assert.equal(writer.commit(commit), undefined); commit.ops[0].object.left = 999;
  while (!release) await new Promise(r => setTimeout(r, 1));
  release(); await writer.flush();
  const result = await readStudentOfflineSnapshot('a', 's', { storage });
  assert.equal(result.snapshot.canvas.objects.length, 1); assert.equal(result.snapshot.canvas.objects[0].left, 50);
});

test('closed recorders reject new writes but finish already received confirmed changes', async () => {
  const storage = store(); const writer = createStudentOfflineRecorder({ boardId: 'a', roomKey: 's', storage });
  writer.snapshot(empty(), 0); writer.commit({ revision: 1, ops: [upsert('one')] }); writer.close();
  writer.commit({ revision: 2, ops: [upsert('two')] }); await writer.flush();
  assert.equal((await readStudentOfflineSnapshot('a', 's', { storage })).revision, 1);
});

test('missing or failed storage never claims to contain a lesson', async () => {
  assert.equal(await readStudentOfflineSnapshot('a', 's', { storage: store() }), null);
  assert.equal(await readStudentOfflineSnapshot('a', 's', { storage: { read() { throw new Error('quota'); } } }), null);
  assert.equal(await studentOfflineScope('', 's'), null);
});

test('viewing archive yields while replaying a long journal', async () => {
  const storage = store(); let yields = 0;
  const writer = createStudentOfflineRecorder({ boardId: 'a', roomKey: 's', storage });
  writer.snapshot(empty(), 0);
  for (let i = 1; i <= 120; i++) writer.commit({ revision: i, ops: [upsert(`note-${i}`)] });
  await writer.flush();
  const result = await readStudentOfflineSnapshot('a', 's', { storage, yieldTask: async () => { yields++; } });
  assert.equal(result.revision, 120); assert.equal(yields, 2);
});

test('optional cache serialization failure never escapes into the live commit pipeline', async () => {
  const errors = []; const storage = store();
  const writer = createStudentOfflineRecorder({ boardId: 'a', roomKey: 's', storage, onError: e => errors.push(e) });
  assert.doesNotThrow(() => writer.snapshot({ canvas: { objects: [{ unsupported: () => {} }] } }, 0));
  assert.doesNotThrow(() => writer.commit({ revision: 1, ops: [{ type: 'upsert', unsupported: () => {} }] }));
  await writer.flush(); assert.equal(errors.length, 2);
  writer.snapshot(empty(), 1); writer.commit({ revision: 2, ops: [upsert('valid')] }); await writer.flush();
  assert.equal((await readStudentOfflineSnapshot('a', 's', { storage })).revision, 2);
});
