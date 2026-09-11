import { deriveShareKey as defaultDeriveShareKey } from './ids.js';

const SESSION_KEY = 'alex-board:fresh-owner-bootstrap:v1';
const OWNER_LIBRARY_KEY = 'alex-board:owner-library:v2';
const MAX_AGE_MS = 2 * 60 * 60_000;
const EMPTY_SNAPSHOT = {
  version: 2,
  background: 'grid',
  canvas: { objects: [] },
};

function browserStorage(name) {
  try {
    return globalThis?.[name] ?? null;
  } catch {
    return null;
  }
}

function parseJson(storage, key) {
  if (!storage?.getItem) return null;
  try {
    const raw = storage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function timestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function recent(createdAt, currentTime) {
  const created = timestamp(createdAt);
  if (!created) return false;
  const age = currentTime - created;
  return age >= -60_000 && age <= MAX_AGE_MS;
}

function normalizeCandidate(candidate, boardId, ownerKey, currentTime) {
  if (!candidate || typeof candidate !== 'object') return null;
  if (String(candidate.boardId ?? '') !== boardId) return null;
  if (String(candidate.ownerKey ?? '') !== ownerKey) return null;
  if (!recent(candidate.createdAt, currentTime)) return null;
  return candidate;
}

function recentOwnerLibraryCandidate(storage, boardId, ownerKey, currentTime) {
  const entries = parseJson(storage, OWNER_LIBRARY_KEY);
  if (!Array.isArray(entries)) return null;
  const candidate = entries.find((entry) => (
    String(entry?.boardId ?? '') === boardId
    && String(entry?.ownerKey ?? '') === ownerKey
  ));
  return normalizeCandidate(candidate, boardId, ownerKey, currentTime);
}

export function createFreshOwnerBootstrap(board, {
  storage = browserStorage('sessionStorage'),
  now = () => Date.now(),
} = {}) {
  if (!storage?.setItem) return false;
  const boardId = String(board?.boardId ?? '').trim();
  const ownerKey = String(board?.ownerKey ?? '').trim();
  if (!boardId || !ownerKey) return false;
  const createdAt = board?.createdAt ?? now();
  const payload = {
    boardId,
    ownerKey,
    shareKey: String(board?.shareKey ?? ''),
    title: String(board?.title ?? 'Новая доска').trim() || 'Новая доска',
    studentName: String(board?.studentName ?? '').trim(),
    createdAt,
    markedAt: now(),
  };
  try {
    storage.setItem(SESSION_KEY, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

export function clearFreshOwnerBootstrap({
  storage = browserStorage('sessionStorage'),
  boardId = '',
  ownerKey = '',
} = {}) {
  if (!storage?.removeItem) return;
  const current = parseJson(storage, SESSION_KEY);
  if (!current) return;
  if (boardId && String(current.boardId ?? '') !== String(boardId)) return;
  if (ownerKey && String(current.ownerKey ?? '') !== String(ownerKey)) return;
  try { storage.removeItem(SESSION_KEY); } catch { /* storage can be unavailable */ }
}

export async function recoverFreshOwnerBootstrap({
  boardId,
  ownerKey,
  storage = browserStorage('sessionStorage'),
  ownerStorage = browserStorage('localStorage'),
  now = () => Date.now(),
  getBoard,
  createBoard,
  deriveShareKey = defaultDeriveShareKey,
} = {}) {
  const id = String(boardId ?? '').trim();
  const key = String(ownerKey ?? '').trim();
  if (!id || !key || typeof getBoard !== 'function' || typeof createBoard !== 'function') return null;

  const existing = await getBoard(id);
  if (existing) return existing;

  const currentTime = Number(now()) || Date.now();
  const sessionCandidate = normalizeCandidate(
    parseJson(storage, SESSION_KEY),
    id,
    key,
    currentTime,
  );
  // Compatibility recovery matters for the production build that created the broken
  // board before this bootstrap marker existed. Home already persisted the exact owner
  // key in owner-library v2 before navigating, so a recent exact match is equally safe.
  const ownerCandidate = sessionCandidate
    ?? recentOwnerLibraryCandidate(ownerStorage, id, key, currentTime);
  if (!ownerCandidate) return null;

  const shareKey = String(ownerCandidate.shareKey ?? '').trim()
    || await deriveShareKey(key);
  if (!shareKey) return null;

  const record = {
    boardId: id,
    ownerKey: key,
    shareKey,
    realtimeKey: shareKey,
    title: String(ownerCandidate.title ?? 'Новая доска').trim() || 'Новая доска',
    studentName: String(ownerCandidate.studentName ?? '').trim(),
    guestMode: 'edit',
    createdAt: timestamp(ownerCandidate.createdAt) || currentTime,
    snapshot: EMPTY_SNAPSHOT,
  };

  try {
    const created = await createBoard(record);
    clearFreshOwnerBootstrap({ storage, boardId: id, ownerKey: key });
    return created;
  } catch (error) {
    // A simultaneous tab may have recreated the exact board between get/add. Never
    // overwrite it; accept only the same owner key after re-reading the authority store.
    const raced = await getBoard(id).catch(() => null);
    if (raced && String(raced.ownerKey ?? '') === key) {
      clearFreshOwnerBootstrap({ storage, boardId: id, ownerKey: key });
      return raced;
    }
    throw error;
  }
}