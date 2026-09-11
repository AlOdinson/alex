import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createBrowserBoardRepository } from '../src/lib/browserBoardRepositoryCompat.js';

const storage = new Map();
globalThis.localStorage = {
  getItem(key) {
    return storage.has(key) ? storage.get(key) : null;
  },
  setItem(key, value) {
    storage.set(key, String(value));
  },
  removeItem(key) {
    storage.delete(key);
  },
};

const library = await import('../src/lib/boardLibrary.js');
assert.equal(library.OWNED_BOARD_LIMIT, 50);

for (let index = 0; index < 52; index += 1) {
  library.rememberOwnedBoard({
    boardId: `board-${String(index).padStart(2, '0')}`,
    ownerKey: `owner-${index}`,
    createdAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
  });
}

const overflow = library.getOwnedBoardsOverLimit(50, 'board-51');
assert.deepEqual(overflow.map((entry) => entry.boardId), ['board-00', 'board-01']);
library.forgetOwnedBoards(overflow.map((entry) => entry.boardId));
assert.equal(library.getOwnedBoards().length, 50);

const authorityBoards = new Map([
  ['local-present', {
    boardId: 'local-present',
    ownerKey: 'local-owner-key',
    title: 'Local board',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }],
]);
const deletionProgress = [];
const repository = createBrowserBoardRepository({
  getBoard: async (boardId) => authorityBoards.get(boardId) ?? null,
  listBoards: async () => [...authorityBoards.values()],
  deleteBoardRecord: async (boardId) => authorityBoards.delete(boardId),
});
const localDeletion = await repository.deleteOwnedBoards([
  { boardId: 'local-present', ownerKey: 'local-owner-key' },
  { boardId: 'already-missing', ownerKey: 'missing-owner-key' },
], {
  onProgress: (progress) => deletionProgress.push(progress),
});
assert.deepEqual(
  localDeletion.deletedBoardIds,
  ['local-present', 'already-missing'],
  'a stale library entry whose authority board is already absent should be removable as a successful detach',
);
assert.deepEqual(localDeletion.detachedBoardIds, ['already-missing']);
assert.deepEqual(localDeletion.failedBoardIds, []);
assert.deepEqual(deletionProgress.map((progress) => progress.completed), [1, 2]);
assert.equal(authorityBoards.has('local-present'), false);

const wrongOwnerBoards = new Map([
  ['protected-board', { boardId: 'protected-board', ownerKey: 'real-owner' }],
]);
const protectedRepository = createBrowserBoardRepository({
  getBoard: async (boardId) => wrongOwnerBoards.get(boardId) ?? null,
  listBoards: async () => [...wrongOwnerBoards.values()],
  deleteBoardRecord: async (boardId) => wrongOwnerBoards.delete(boardId),
});
const wrongOwnerDeletion = await protectedRepository.deleteOwnedBoards([
  { boardId: 'protected-board', ownerKey: 'wrong-owner' },
]);
assert.deepEqual(wrongOwnerDeletion.deletedBoardIds, []);
assert.deepEqual(wrongOwnerDeletion.detachedBoardIds, []);
assert.deepEqual(wrongOwnerDeletion.failedBoardIds, ['protected-board']);
assert.equal(wrongOwnerBoards.has('protected-board'), true, 'wrong owner must never delete a local authority board');

const homeSource = await readFile(new URL('../src/components/Home.jsx', import.meta.url), 'utf8');
assert.doesNotMatch(homeSource, /getBoardAccess/);
assert.match(homeSource, /getOwnedBoardSummaries\(entries\)/);
assert.match(homeSource, /const missingBoardIds = entries/);
assert.match(homeSource, /forgetOwnedBoards\(missingBoardIds\)/);
assert.match(homeSource, /if \(!summary\) return \[\]/);
assert.doesNotMatch(homeSource, /unavailable: true/);
assert.match(homeSource, /Выделить все/);
assert.match(homeSource, /deleteOwnedBoards\(selectedBoards,/);
assert.match(homeSource, /getOwnedBoardsOverLimit\(OWNED_BOARD_LIMIT/);
assert.match(homeSource, /deleteOwnedBoards\(overflow/);
assert.match(homeSource, /Убираю старые доски сверх лимита 50/);
assert.doesNotMatch(homeSource, /await enforceOwnedBoardLimit/);

const publicRepositorySource = await readFile(new URL('../src/lib/boardRepository.js', import.meta.url), 'utf8');
assert.match(publicRepositorySource, /browserBoardRepositoryCompat\.js/);
assert.doesNotMatch(publicRepositorySource, /supabase\.rpc/);

const compatSource = await readFile(new URL('../src/lib/browserBoardRepositoryCompat.js', import.meta.url), 'utf8');
assert.match(compatSource, /deleteOwnedBoards/);
assert.match(compatSource, /onProgress/);
assert.match(compatSource, /detachedBoardIds/);
assert.doesNotMatch(compatSource, /supabase\.rpc/);

console.log('Fast local creation, automatic 50-board cleanup, stale-card pruning, and safe sequential deletion tests passed.');
