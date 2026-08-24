const LIBRARY_KEY = 'alex-board:owner-library:v1';
export const OWNED_BOARD_LIMIT = 50;

function readAll() {
  try {
    const value = JSON.parse(localStorage.getItem(LIBRARY_KEY) ?? '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function writeAll(entries) {
  localStorage.setItem(LIBRARY_KEY, JSON.stringify(entries));
}

export function getOwnedBoards() {
  return readAll().sort((a, b) => Number(b.lastOpenedAt ?? 0) - Number(a.lastOpenedAt ?? 0));
}

export function getOwnedBoard(boardId) {
  if (!boardId) return null;
  return readAll().find((entry) => entry.boardId === boardId) ?? null;
}

export function rememberOwnedBoard(entry) {
  if (!entry?.boardId || !entry?.ownerKey) return;
  const entries = readAll();
  const index = entries.findIndex((item) => item.boardId === entry.boardId);
  const now = Date.now();
  const next = {
    ...(index >= 0 ? entries[index] : {}),
    ...entry,
    libraryAddedAt: index >= 0
      ? Number(entries[index].libraryAddedAt ?? entries[index].lastOpenedAt ?? now)
      : now,
    lastOpenedAt: now,
  };
  if (index >= 0) entries.splice(index, 1, next);
  else entries.push(next);
  writeAll(entries);
}

export function forgetOwnedBoard(boardId) {
  writeAll(readAll().filter((entry) => entry.boardId !== boardId));
}

export function forgetOwnedBoards(boardIds) {
  const ids = new Set((Array.isArray(boardIds) ? boardIds : []).filter(Boolean).map(String));
  if (!ids.size) return;
  writeAll(readAll().filter((entry) => !ids.has(String(entry.boardId))));
}

export function updateOwnedBoard(boardId, patch) {
  const entries = readAll();
  const index = entries.findIndex((entry) => entry.boardId === boardId);
  if (index < 0) return;
  entries[index] = { ...entries[index], ...patch };
  writeAll(entries);
}

function createdTime(entry) {
  const serverCreatedAt = Date.parse(entry?.createdAt ?? '');
  if (Number.isFinite(serverCreatedAt)) return serverCreatedAt;
  return Number(entry?.libraryAddedAt ?? entry?.lastOpenedAt ?? 0);
}

export function getOwnedBoardsOverLimit(limit = OWNED_BOARD_LIMIT, preserveBoardId = '') {
  const safeLimit = Math.max(0, Number(limit) || 0);
  const entries = readAll();
  const overflowCount = Math.max(0, entries.length - safeLimit);
  if (!overflowCount) return [];

  return entries
    .filter((entry) => entry.boardId !== preserveBoardId)
    .sort((left, right) => {
      const byCreation = createdTime(left) - createdTime(right);
      if (byCreation) return byCreation;
      return String(left.boardId).localeCompare(String(right.boardId));
    })
    .slice(0, overflowCount);
}
