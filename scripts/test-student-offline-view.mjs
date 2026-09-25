import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserBoardRepository } from '../src/lib/browserBoardRepositoryCompat.js';

const snapshot = { version: 2, background: 'dots', canvas: { objects: [{ boardObjectId: 'lesson', type: 'rect', left: 1400 }] } };
function repository(options = {}) {
  return createBrowserBoardRepository({ getBoard: async () => null, getReplica: () => null,
    createAuthorityRecord: async () => { throw new Error('Viewing must not create authority'); }, ...options });
}

test('a returning student opens a confirmed read cache while the owner is absent', async () => {
  const keys = [];
  const repo = repository({ getReadOnlySnapshot: async (...args) => {
    keys.push(args); return { snapshot, revision: 42, savedAt: 12345 };
  } });
  const result = await repo.getBoardAccess('offline-lesson', 'share-secret');
  assert.deepEqual(result.snapshot, snapshot, 'previously received notes must be available without a peer');
  assert.equal(result.snapshotRevision, 42);
  assert.equal(result.offlineSnapshot, true, 'cached contents are explicitly display-only, not live authority');
  assert.deepEqual(keys, [['offline-lesson', 'share-secret']]);
});

test('an online in-memory replica takes precedence over a disk viewing copy', async () => {
  let reads = 0;
  const result = await repository({ getReplica: () => ({ snapshot, revision: 43 }),
    getReadOnlySnapshot: async () => { reads++; return { snapshot, revision: 42 }; },
  }).getBoardAccess('lesson', 'key');
  assert.equal(result.revision, 43); assert.equal(reads, 0);
});

test('a device with no saved lesson stays empty, rather than manufacturing notes', async () => {
  const result = await repository({ getReadOnlySnapshot: async () => null }).getBoardAccess('lesson', 'key');
  assert.equal(result.snapshot, null); assert.equal(result.revision, 0);
});

test('unavailable local storage must not prevent normal connection', async () => {
  const result = await repository({ getReadOnlySnapshot: async () => { throw new Error('blocked storage'); } })
    .getBoardAccess('lesson', 'key');
  assert.equal(result.snapshot, null);
});

test('an absent URL key never opens the viewing cache', async () => {
  let reads = 0;
  const result = await repository({ getReadOnlySnapshot: async () => { reads++; return { snapshot, revision: 1 }; } })
    .getBoardAccess('lesson', '');
  assert.equal(result, null); assert.equal(reads, 0);
});

test('cached notes cannot become the source of a live recovery response', async () => {
  const repo = repository({ getReadOnlySnapshot: async () => ({ snapshot, revision: 42 }) });
  await repo.getBoardAccess('offline-lesson', 'share-secret');
  assert.equal(await repo.getBoardRecovery('offline-lesson', 'share-secret'), null);
  assert.equal((await repo.getBoardRevision('offline-lesson', 'share-secret')).revision, 0);
});

test('read-only navigation crosses the global input gate only after Canvas is fenced', async () => {
  class StateEvent extends Event { constructor(detail) { super('alex-board-runtime-state'); this.detail = detail; } }
  const window = new EventTarget(); window.location = { pathname: '/alex/board/view-lesson' };
  const document = { documentElement: { dataset: {} }, body: { append() {} },
    createElement: () => ({ dataset: {}, style: {}, remove() {} }) };
  globalThis.window = window; globalThis.document = document;
  await import(`../src/durableEditGate.js?offline-navigation=${Date.now()}`);
  window.dispatchEvent(new StateEvent({ boardId: 'view-lesson', permission: 'edit', state: 'teacher-offline' }));
  let safe = false;
  const target = { closest: (selector) => selector.includes('data-readonly-navigation') ? (safe ? {} : null) : {} };
  function pointer() { const e = new Event('pointerdown', { cancelable: true });
    Object.defineProperty(e, 'target', { value: target }); window.dispatchEvent(e); return e; }
  assert.equal(pointer().defaultPrevented, true, 'an editable Canvas must stay protected');
  safe = true;
  assert.equal(pointer().defaultPrevented, false, 'a fenced student Canvas must allow dragging and pinch');
  window.dispatchEvent(new StateEvent({ boardId: 'view-lesson', permission: 'owner', state: 'waiting' }));
  assert.equal(pointer().defaultPrevented, true, 'no bypass for an owner waiting for the exclusive tab lock');
  delete globalThis.window; delete globalThis.document;
});
