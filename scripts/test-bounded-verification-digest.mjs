import assert from 'node:assert/strict';
import test from 'node:test';
const module = await import('../src/lib/boundedVerificationDigest.js').catch((e) => {
  if (e.code === 'ERR_MODULE_NOT_FOUND') return null;
  throw e;
});
test('cooperative digest implementation exists', () => assert.equal(typeof module?.verificationDigest, 'function'));
const feature = (name, work) => test(name, { skip: !module }, work);
feature('canonical property order does not change digest', async () => {
  assert.equal(await module.verificationDigest({ a: 1, b: ['x', null] }),
    await module.verificationDigest({ b: ['x', null], a: 1 }));
});
feature('content, order, absence and background produce different fingerprints', async () => {
  const values = [null, [], {}, { id: 'a', object: null }, { id: 'a', object: { stroke: 'red' } },
    { id: 'a', object: { stroke: 'black' } }, { id: 'a', zIndex: 1 }, { id: 'a', zIndex: 2 },
    ['a', 'b'], ['b', 'a'], 'grid', 'dots', 1, '1', false, 0, ''];
  const hashes = await Promise.all(values.map((v) => module.verificationDigest(v)));
  assert.equal(new Set(hashes).size, values.length);
});
feature('runtime and transient rendering flags do not affect durable digest', async () => {
  assert.equal(await module.verificationDigest({ id: 'a', transientPreview: true, pendingImage: true, selectable: false }),
    await module.verificationDigest({ id: 'a' }));
});
feature('a single very long path yields instead of one monolithic stringify', async () => {
  let time = 0; let yields = 0;
  const path = Array.from({ length: 10000 }, (_, i) => ['L', i, i / 3]);
  const hash = await module.verificationDigest({ path }, { now: () => time += 0.02,
    yieldControl: async () => { yields++; }, budgetMs: 4 });
  assert.ok(yields > 0); assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hash, await module.verificationDigest({ path }));
});
feature('large unicode strings have stable fingerprints across cooperative yields', async () => {
  const value = { text: 'А🙂\n\"'.repeat(10000) };
  let time = 0;
  const left = await module.verificationDigest(value, { now: () => ++time, yieldControl: async () => {} });
  assert.equal(left, await module.verificationDigest(value));
});
feature('stale generation aborts computation without returning a digest', async () => {
  let valid = true; let time = 0;
  await assert.rejects(module.verificationDigest({ path: new Array(10000).fill('x') }, {
    isCurrent: () => valid, now: () => ++time, yieldControl: async () => { valid = false; },
  }), (e) => e.name === 'AbortError');
});
feature('abort signal is observed', async () => {
  const abort = new AbortController(); abort.abort();
  await assert.rejects(module.verificationDigest({}, { signal: abort.signal }), (e) => e.name === 'AbortError');
});
feature('cooperative JSON serialization preserves long paths and unicode', async () => {
  const value = { text: '🙂\n\"\\'.repeat(10000), path: Array.from({ length: 3000 }, (_, i) => ['L', i, i]) };
  let time = 0; let yields = 0;
  const json = await module.verificationJson(value, { now: () => ++time, yieldControl: async () => { yields++; } });
  assert.deepEqual(JSON.parse(json), value); assert.ok(yields > 0);
});
feature('independent SHA256 folding reference matches the canonical stream', async () => {
  const { createHash } = await import('node:crypto');
  const value = { n: 42, text: 'abc', items: [true, null] };
  const pieces = [...module.verificationTokens(value)].join('');
  let hash = Buffer.alloc(32);
  for (let offset = 0; offset < pieces.length; offset += 4096) {
    hash = createHash('sha256').update(hash).update(Buffer.from(pieces.slice(offset, offset + 4096), 'utf8')).digest();
  }
  assert.equal(await module.verificationDigest(value), hash.toString('hex'));
});
feature('fingerprint is stable across JSON transport dropping undefined object properties', async () => {
  const source = { boardObjectId: 'a', unused: undefined, path: [['M', 0, 0]], nested: { empty: undefined, x: 1 } };
  assert.equal(await module.verificationDigest(source), await module.verificationDigest(JSON.parse(JSON.stringify(source))));
});

feature('a cheap budget checkpoint does not allocate a microtask for every coordinate', async () => {
  let clock = 0; let yields = 0;
  const budget = module.createVerificationBudget({ now: () => clock, yieldControl: async () => { yields++; } });
  assert.equal(budget.checkpoint(), null, 'within-budget work stays synchronous');
  clock = 4;
  const pending = budget.checkpoint();
  assert.equal(typeof pending?.then, 'function', 'expired budget yields to a task');
  await pending;
  assert.equal(yields, 1);
  assert.equal(budget.checkpoint(), null);
});
