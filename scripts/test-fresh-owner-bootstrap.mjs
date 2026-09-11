import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createFreshOwnerBootstrap,
  recoverFreshOwnerBootstrap,
} from '../src/lib/freshOwnerBootstrap.js';

const now = 1_789_160_000_000;

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

test('fresh owner bootstrap can recreate only the just-created empty authority board', async () => {
  const storage = memoryStorage();
  createFreshOwnerBootstrap({
    boardId: 'fresh-board',
    ownerKey: 'owner-secret',
    shareKey: 'share-secret',
    title: 'Новая доска',
    studentName: 'Анна',
    createdAt: now,
  }, { storage, now: () => now });

  let created = null;
  const recovered = await recoverFreshOwnerBootstrap({
    boardId: 'fresh-board',
    ownerKey: 'owner-secret',
    storage,
    now: () => now + 500,
    getBoard: async () => null,
    createBoard: async (record) => {
      created = record;
      return record;
    },
  });

  assert.equal(recovered?.boardId, 'fresh-board');
  assert.equal(created.ownerKey, 'owner-secret');
  assert.equal(created.shareKey, 'share-secret');
  assert.equal(created.realtimeKey, 'share-secret');
  assert.equal(created.guestMode, 'edit');
  assert.deepEqual(created.snapshot, {
    version: 2,
    background: 'grid',
    canvas: { objects: [] },
  });
});

test('production board created before the hotfix can recover from recent owner-library v2 entry', async () => {
  const storage = memoryStorage();
  const ownerStorage = memoryStorage();
  ownerStorage.setItem('alex-board:owner-library:v2', JSON.stringify([{
    boardId: 'fresh-board',
    ownerKey: 'owner-secret',
    title: 'Первая доска',
    studentName: 'Иван',
    createdAt: new Date(now).toISOString(),
  }]));

  let created = null;
  const recovered = await recoverFreshOwnerBootstrap({
    boardId: 'fresh-board',
    ownerKey: 'owner-secret',
    storage,
    ownerStorage,
    now: () => now + 5 * 60_000,
    deriveShareKey: async (key) => `derived:${key}`,
    getBoard: async () => null,
    createBoard: async (record) => {
      created = record;
      return record;
    },
  });

  assert.equal(recovered?.boardId, 'fresh-board');
  assert.equal(created.shareKey, 'derived:owner-secret');
  assert.equal(created.realtimeKey, 'derived:owner-secret');
  assert.equal(created.title, 'Первая доска');
  assert.equal(created.studentName, 'Иван');
});

test('share/student key can never use a pending owner bootstrap', async () => {
  const storage = memoryStorage();
  createFreshOwnerBootstrap({
    boardId: 'fresh-board',
    ownerKey: 'owner-secret',
    shareKey: 'share-secret',
    createdAt: now,
  }, { storage, now: () => now });

  let creates = 0;
  const recovered = await recoverFreshOwnerBootstrap({
    boardId: 'fresh-board',
    ownerKey: 'share-secret',
    storage,
    now: () => now + 500,
    getBoard: async () => null,
    createBoard: async () => { creates += 1; },
  });

  assert.equal(recovered, null);
  assert.equal(creates, 0);
});

test('expired or different-board bootstrap cannot create authority', async () => {
  const storage = memoryStorage();
  createFreshOwnerBootstrap({
    boardId: 'fresh-board',
    ownerKey: 'owner-secret',
    shareKey: 'share-secret',
    createdAt: now,
  }, { storage, now: () => now });

  let creates = 0;
  const expired = await recoverFreshOwnerBootstrap({
    boardId: 'fresh-board',
    ownerKey: 'owner-secret',
    storage,
    now: () => now + 3 * 60 * 60_000,
    getBoard: async () => null,
    createBoard: async () => { creates += 1; },
  });
  const different = await recoverFreshOwnerBootstrap({
    boardId: 'other-board',
    ownerKey: 'owner-secret',
    storage,
    now: () => now + 500,
    getBoard: async () => null,
    createBoard: async () => { creates += 1; },
  });

  assert.equal(expired, null);
  assert.equal(different, null);
  assert.equal(creates, 0);
});

test('existing authority record is never replaced', async () => {
  const storage = memoryStorage();
  createFreshOwnerBootstrap({
    boardId: 'fresh-board',
    ownerKey: 'owner-secret',
    shareKey: 'share-secret',
    createdAt: now,
  }, { storage, now: () => now });

  const existing = { boardId: 'fresh-board', ownerKey: 'owner-secret', revision: 7 };
  let creates = 0;
  const recovered = await recoverFreshOwnerBootstrap({
    boardId: 'fresh-board',
    ownerKey: 'owner-secret',
    storage,
    now: () => now + 500,
    getBoard: async () => existing,
    createBoard: async () => { creates += 1; },
  });

  assert.equal(recovered, existing);
  assert.equal(creates, 0);
});