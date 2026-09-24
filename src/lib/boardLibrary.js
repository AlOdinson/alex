const LIBRARY_KEY = 'alex-board:owner-library:v2';
const LEGACY_LIBRARY_KEY = 'alex-board:owner-library:v1';
export const OWNED_BOARD_LIMIT = 50;

let legacyLibraryCleared = false;
// The library is only an index. A failed cache write must never invalidate an
// IndexedDB board. Keep pending metadata edits, not a stale full-tab snapshot.
const pendingChanges = new Map();
let lastReadableEntries = [];

function clearLegacyLibrary() {
  if (legacyLibraryCleared) return;
  legacyLibraryCleared = true;
  try {
    localStorage.removeItem(LEGACY_LIBRARY_KEY);
  } catch {
    // The board library is best-effort metadata. IndexedDB remains authoritative.
  }
}

function readAll() {
  clearLegacyLibrary();
  try {
    const value = JSON.parse(localStorage.getItem(LIBRARY_KEY) ?? '[]');
    lastReadableEntries = Array.isArray(value) ? value.filter((entry) => (
      entry && typeof entry.boardId === 'string' && entry.boardId
      && typeof entry.ownerKey === 'string' && entry.ownerKey
    )) : [];
  } catch {
    // Security settings or quota errors must not hide this tab's pending edits.
  }
  const merged = new Map(lastReadableEntries.map((entry) => [entry.boardId, entry]));
  for (const [boardId, entry] of pendingChanges) {
    if (entry === null) merged.delete(boardId);
    else merged.set(boardId, entry);
  }
  return [...merged.values()];
}

function writeAll(entries) {
  const previous = new Map(readAll().map((entry) => [entry.boardId, entry]));
  const next = new Map(entries.map((entry) => [entry.boardId, entry]));
  for (const [boardId, entry] of next) {
    if (JSON.stringify(previous.get(boardId)) !== JSON.stringify(entry)) {
      pendingChanges.set(boardId, entry);
    }
  }
  for (const boardId of previous.keys()) {
    if (!next.has(boardId)) pendingChanges.set(boardId, null);
  }
  const merged = readAll();
  try {
    localStorage.setItem(LIBRARY_KEY, JSON.stringify(merged));
    lastReadableEntries = merged;
    pendingChanges.clear();
  } catch {
    // IndexedDB remains authoritative; the Home page restores cards after reload.
  }
}

export function restoreOwnedBoards(records) {
  const entries = new Map(readAll().map((entry) => [entry.boardId, entry]));
  for (const record of Array.isArray(records) ? records : []) {
    if (!record?.boardId || !record?.ownerKey) continue;
    const existing = entries.get(record.boardId);
    const createdAt = Number(record.createdAt) || Date.now();
    const updatedAt = Number(record.updatedAt) || createdAt;
    entries.set(record.boardId, {
      ...existing,
      boardId: record.boardId,
      ownerKey: record.ownerKey,
      title: record.title ?? 'Новая доска',
      studentName: record.studentName ?? '',
      createdAt: new Date(createdAt).toISOString(),
      updatedAt: new Date(updatedAt).toISOString(),
      libraryAddedAt: existing?.libraryAddedAt ?? createdAt,
      lastOpenedAt: existing?.lastOpenedAt ?? updatedAt,
      // Recovery must not trigger destructive overflow cleanup, even when older
      // failed attempts left more than 50 durable boards. Manual deletion works.
      recoveredFromStorage: existing ? Boolean(existing.recoveredFromStorage) : true,
    });
  }
  writeAll([...entries.values()]);
  return getOwnedBoards();
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
  const createdAt = Date.parse(entry?.createdAt ?? '');
  if (Number.isFinite(createdAt)) return createdAt;
  return Number(entry?.libraryAddedAt ?? entry?.lastOpenedAt ?? 0);
}

export function getOwnedBoardsOverLimit(limit = OWNED_BOARD_LIMIT, preserveBoardId = '') {
  const safeLimit = Math.max(0, Number(limit) || 0);
  const entries = readAll().filter((entry) => !entry.recoveredFromStorage);
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
