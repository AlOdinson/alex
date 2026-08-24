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

const homeSource = await readFile(new URL('../src/components/Home.jsx', import.meta.url), 'utf8');
assert.doesNotMatch(homeSource, /getBoardAccess/);
assert.match(homeSource, /getOwnedBoardSummaries\(entries\)/);
assert.match(homeSource, /Выделить все/);
assert.match(homeSource, /deleteOwnedBoards\(selectedBoards\)/);
assert.match(homeSource, /getOwnedBoardsOverLimit\(OWNED_BOARD_LIMIT/);

const repositorySource = await readFile(new URL('../src/lib/boardRepository.js', import.meta.url), 'utf8');
assert.match(repositorySource, /create_board_fast_v8/);
assert.match(repositorySource, /get_owned_board_summaries_v8/);
assert.match(repositorySource, /delete_owned_boards_v8/);

const sqlSource = await readFile(new URL('../supabase/fast_board_library_v8.sql', import.meta.url), 'utf8');
assert.match(sqlSource, /create or replace function public\.create_board_fast_v8/);
assert.match(sqlSource, /create or replace function public\.get_owned_board_summaries_v8/);
assert.match(sqlSource, /create or replace function public\.delete_owned_boards_v8/);
assert.doesNotMatch(sqlSource, /snapshot::jsonb[\s\S]*get_owned_board_summaries_v8/);

console.log('Fast board creation, 50-board limit, and bulk library controls tests passed.');
