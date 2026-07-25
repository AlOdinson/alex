const LIBRARY_KEY = 'alex-board:owner-library:v1';

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

export function rememberOwnedBoard(entry) {
  if (!entry?.boardId || !entry?.ownerKey) return;
  const entries = readAll();
  const index = entries.findIndex((item) => item.boardId === entry.boardId);
  const next = {
    ...(index >= 0 ? entries[index] : {}),
    ...entry,
    lastOpenedAt: Date.now(),
  };
  if (index >= 0) entries.splice(index, 1, next);
  else entries.push(next);
  writeAll(entries);
}

export function forgetOwnedBoard(boardId) {
  writeAll(readAll().filter((entry) => entry.boardId !== boardId));
}

export function updateOwnedBoard(boardId, patch) {
  const entries = readAll();
  const index = entries.findIndex((entry) => entry.boardId === boardId);
  if (index < 0) return;
  entries[index] = { ...entries[index], ...patch };
  writeAll(entries);
}
