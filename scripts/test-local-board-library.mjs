import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalBoardLibrary } from '../src/lib/localBoardLibrary.js';

test('creates a board entirely through the browser authority store', async () => {
  const created = [];
  const tokens = ['board-id', 'owner-key'];
  const library = createLocalBoardLibrary({
    createBoardRecord: async (record) => { created.push(record); return record; },
    listBoardRecords: async () => [],
    getBoardRecord: async () => null,
    updateBoardRecord: async () => null,
    deleteBoardRecord: async () => true,
    randomToken: () => tokens.shift(),
    deriveShareKey: async (ownerKey) => `share:${ownerKey}`,
  });

  const board = await library.createBoard('Алгебра', 'Анна');
  assert.equal(created.length, 1);
  assert.equal(created[0].boardId, 'board-id');
  assert.equal(created[0].ownerKey, 'owner-key');
  assert.equal(created[0].shareKey, 'share:owner-key');
  assert.equal(created[0].realtimeKey, 'share:owner-key');
  assert.equal(created[0].title, 'Алгебра');
  assert.equal(created[0].studentName, 'Анна');
  assert.equal(board.boardId, 'board-id');
});

test('renames and deletes local boards without any server call', async () => {
  const updates = [];
  const deletes = [];
  const library = createLocalBoardLibrary({
    createBoardRecord: async (record) => record,
    listBoardRecords: async () => [],
    getBoardRecord: async () => null,
    updateBoardRecord: async (boardId, patch) => { updates.push({ boardId, patch }); return { boardId, ...patch }; },
    deleteBoardRecord: async (boardId) => { deletes.push(boardId); return true; },
    randomToken: () => 'token',
    deriveShareKey: async () => 'share',
  });

  await library.renameBoard('board-a', 'Геометрия');
  await library.setGuestMode('board-a', 'view');
  await library.deleteBoard('board-a');

  assert.deepEqual(updates, [
    { boardId: 'board-a', patch: { title: 'Геометрия' } },
    { boardId: 'board-a', patch: { guestMode: 'view' } },
  ]);
  assert.deepEqual(deletes, ['board-a']);
});
