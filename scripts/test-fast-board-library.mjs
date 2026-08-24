import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

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

const { sha256 } = await import('../src/lib/ids.js');
const repository = await import('../src/lib/boardRepository.js');
const localOwnerKey = 'local-owner-key';
localStorage.setItem('alex-board:board:local-present', JSON.stringify({
  id: 'local-present',
  ownerKeyHash: await sha256(localOwnerKey),
}));
const deletionProgress = [];
const localDeletion = await repository.deleteOwnedBoards([
  { boardId: 'local-present', ownerKey: localOwnerKey },
  { boardId: 'already-missing', ownerKey: 'missing-owner-key' },
], {
  onProgress: (progress) => deletionProgress.push(progress),
});
assert.deepEqual(localDeletion.deletedBoardIds, ['local-present', 'already-missing']);
assert.deepEqual(localDeletion.detachedBoardIds, ['already-missing']);
assert.deepEqual(localDeletion.failedBoardIds, []);
assert.deepEqual(deletionProgress.map((progress) => progress.completed), [1, 2]);
assert.equal(localStorage.getItem('alex-board:board:local-present'), null);

const homeSource = await readFile(new URL('../src/components/Home.jsx', import.meta.url), 'utf8');
assert.doesNotMatch(homeSource, /getBoardAccess/);
assert.match(homeSource, /getOwnedBoardSummaries\(entries\)/);
assert.match(homeSource, /Выделить все/);
assert.match(homeSource, /deleteOwnedBoards\(selectedBoards,/);
assert.match(homeSource, /getOwnedBoardsOverLimit\(OWNED_BOARD_LIMIT/);
assert.match(homeSource, /deleteOwnedBoards\(overflow/);
assert.match(homeSource, /Убираю старые доски сверх лимита 50/);
assert.doesNotMatch(homeSource, /await enforceOwnedBoardLimit/);

const repositorySource = await readFile(new URL('../src/lib/boardRepository.js', import.meta.url), 'utf8');
assert.match(repositorySource, /create_board_fast_v8/);
assert.match(repositorySource, /get_owned_board_summaries_v8/);
assert.doesNotMatch(repositorySource, /supabase\.rpc\('delete_owned_boards_v8'/);
assert.match(repositorySource, /for \(const entry of prepared\)/);
assert.match(repositorySource, /onProgress/);
assert.match(repositorySource, /detachedBoardIds/);

const sqlSource = await readFile(new URL('../supabase/fast_board_library_v8.sql', import.meta.url), 'utf8');
assert.match(sqlSource, /create or replace function public\.create_board_fast_v8/);
assert.match(sqlSource, /create or replace function public\.get_owned_board_summaries_v8/);
assert.match(sqlSource, /create or replace function public\.delete_owned_boards_v8/);
assert.doesNotMatch(sqlSource, /snapshot::jsonb[\s\S]*get_owned_board_summaries_v8/);

console.log('Fast creation, automatic 50-board cleanup, and safe sequential deletion tests passed.');
