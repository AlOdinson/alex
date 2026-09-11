const DB_NAME = 'alex-board-authority';
const DB_VERSION = 1;
const BOARD_STORE = 'boards';
const COMMIT_STORE = 'commits';
const ASSET_STORE = 'assets';
const BOARD_REVISION_INDEX = 'boardRevision';
const BOARD_ID_INDEX = 'boardId';

const EMPTY_SNAPSHOT = {
  version: 2,
  background: 'grid',
  canvas: { objects: [] },
};

function cloneValue(value) {
  if (value == null || typeof value !== 'object') return value;
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function requireIndexedDb() {
  if (typeof indexedDB === 'undefined') throw new Error('IndexedDB is unavailable');
  return indexedDB;
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = requireIndexedDb().open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(BOARD_STORE)) {
        db.createObjectStore(BOARD_STORE, { keyPath: 'boardId' });
      }

      if (!db.objectStoreNames.contains(COMMIT_STORE)) {
        const commits = db.createObjectStore(COMMIT_STORE, { keyPath: 'actionKey' });
        commits.createIndex(BOARD_REVISION_INDEX, ['boardId', 'revision'], { unique: true });
        commits.createIndex(BOARD_ID_INDEX, 'boardId', { unique: false });
      }

      if (!db.objectStoreNames.contains(ASSET_STORE)) {
        const assets = db.createObjectStore(ASSET_STORE, { keyPath: 'assetKey' });
        assets.createIndex(BOARD_ID_INDEX, 'boardId', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open authority database'));
    request.onblocked = () => reject(new Error('Authority database upgrade is blocked by another tab'));
  });
}

async function withTransaction(storeNames, mode, work) {
  const db = await openDatabase();
  const transaction = db.transaction(storeNames, mode);
  const completion = new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('Authority transaction failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Authority transaction aborted'));
  });

  try {
    const result = await work(transaction);
    await completion;
    return result;
  } catch (error) {
    try {
      transaction.abort();
    } catch {
      // The transaction may already have completed or aborted.
    }
    try {
      await completion;
    } catch {
      // Preserve the original error from the operation.
    }
    throw error;
  } finally {
    db.close();
  }
}

function deleteRecordsByBoardId(store, boardId) {
  return new Promise((resolve, reject) => {
    const index = store.index(BOARD_ID_INDEX);
    const request = index.openCursor(IDBKeyRange.only(boardId));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      const deletion = cursor.delete();
      deletion.onsuccess = () => cursor.continue();
      deletion.onerror = () => reject(deletion.error ?? new Error('Could not delete authority board records'));
    };
    request.onerror = () => reject(request.error ?? new Error('Could not scan authority board records'));
  });
}

function normalizeBoardInput(input) {
  const boardId = String(input?.boardId ?? '').trim();
  if (!boardId) throw new Error('boardId is required');
  const now = Number(input?.createdAt ?? Date.now()) || Date.now();
  return {
    boardId,
    ownerKey: String(input?.ownerKey ?? ''),
    shareKey: String(input?.shareKey ?? ''),
    realtimeKey: String(input?.realtimeKey ?? ''),
    title: String(input?.title ?? 'Новая доска').trim() || 'Новая доска',
    studentName: String(input?.studentName ?? '').trim(),
    guestMode: input?.guestMode === 'view' ? 'view' : 'edit',
    gameLibraryVisible: Boolean(input?.gameLibraryVisible),
    revision: 0,
    snapshotRevision: 0,
    snapshot: cloneValue(input?.snapshot ?? EMPTY_SNAPSHOT),
    tombstones: cloneValue(input?.tombstones ?? {}),
    protocolVersion: 1,
    createdAt: now,
    updatedAt: now,
  };
}

function applyCommitTombstones(source, commit) {
  const tombstones = cloneValue(source ?? {});
  const clientId = String(commit?.clientId ?? '');
  const actionId = String(commit?.actionId ?? '');
  const revision = Number(commit?.revision ?? 0);
  for (const operation of Array.isArray(commit?.ops) ? commit.ops : []) {
    if (operation?.type === 'delete' && operation.id) {
      const id = String(operation.id);
      tombstones[id] = {
        clientId,
        mutationId: String(operation.mutationId ?? actionId),
        actionId,
        revision,
      };
      continue;
    }
    if (operation?.type === 'upsert' && operation.object?.boardObjectId) {
      delete tombstones[String(operation.object.boardObjectId)];
    }
  }
  return tombstones;
}

export async function createAuthorityBoard(input) {
  const board = normalizeBoardInput(input);
  return withTransaction([BOARD_STORE], 'readwrite', async (transaction) => {
    await requestResult(transaction.objectStore(BOARD_STORE).add(board));
    return cloneValue(board);
  });
}

export async function getAuthorityBoard(boardId) {
  const key = String(boardId ?? '').trim();
  if (!key) return null;
  return withTransaction([BOARD_STORE], 'readonly', async (transaction) => {
    const board = await requestResult(transaction.objectStore(BOARD_STORE).get(key));
    return board ? cloneValue(board) : null;
  });
}

export async function listAuthorityBoards() {
  return withTransaction([BOARD_STORE], 'readonly', async (transaction) => {
    const boards = await requestResult(transaction.objectStore(BOARD_STORE).getAll());
    return (Array.isArray(boards) ? boards : [])
      .map(cloneValue)
      .sort((left, right) => Number(right.updatedAt ?? 0) - Number(left.updatedAt ?? 0));
  });
}

export async function updateAuthorityBoardMetadata(boardId, patch = {}) {
  const key = String(boardId ?? '').trim();
  if (!key) throw new Error('boardId is required');
  return withTransaction([BOARD_STORE], 'readwrite', async (transaction) => {
    const boards = transaction.objectStore(BOARD_STORE);
    const board = await requestResult(boards.get(key));
    if (!board) throw new Error('Authority board not found');

    const next = { ...board };
    if (Object.hasOwn(patch, 'title')) {
      next.title = String(patch.title ?? '').trim() || 'Новая доска';
    }
    if (Object.hasOwn(patch, 'studentName')) {
      next.studentName = String(patch.studentName ?? '').trim();
    }
    if (Object.hasOwn(patch, 'guestMode')) {
      next.guestMode = patch.guestMode === 'view' ? 'view' : 'edit';
    }
    if (Object.hasOwn(patch, 'gameLibraryVisible')) {
      next.gameLibraryVisible = Boolean(patch.gameLibraryVisible);
    }
    next.updatedAt = Date.now();
    await requestResult(boards.put(next));
    return cloneValue(next);
  });
}

export async function deleteAuthorityBoard(boardId) {
  const key = String(boardId ?? '').trim();
  if (!key) return false;
  return withTransaction([BOARD_STORE, COMMIT_STORE, ASSET_STORE], 'readwrite', async (transaction) => {
    const boards = transaction.objectStore(BOARD_STORE);
    const existing = await requestResult(boards.get(key));
    if (!existing) return false;
    await Promise.all([
      requestResult(boards.delete(key)),
      deleteRecordsByBoardId(transaction.objectStore(COMMIT_STORE), key),
      deleteRecordsByBoardId(transaction.objectStore(ASSET_STORE), key),
    ]);
    return true;
  });
}

export async function getAuthorityActionOutcome(boardId, actionId) {
  const key = String(boardId ?? '').trim();
  const safeActionId = String(actionId ?? '').trim();
  if (!key || !safeActionId) return null;
  return withTransaction([COMMIT_STORE], 'readonly', async (transaction) => {
    const record = await requestResult(
      transaction.objectStore(COMMIT_STORE).get(`${key}:${safeActionId}`),
    );
    if (!record) return null;
    return cloneValue(record.noop ? record.result : record);
  });
}

export async function persistAuthorityNoopOutcome(boardId, result) {
  const key = String(boardId ?? '').trim();
  const actionId = String(result?.actionId ?? '').trim();
  if (!key) throw new Error('boardId is required');
  if (!actionId) throw new Error('actionId is required');
  const actionKey = `${key}:${actionId}`;

  return withTransaction([COMMIT_STORE], 'readwrite', async (transaction) => {
    const commits = transaction.objectStore(COMMIT_STORE);
    const existing = await requestResult(commits.get(actionKey));
    if (existing) {
      return {
        result: cloneValue(existing.noop ? existing.result : existing),
        duplicate: true,
      };
    }
    const record = {
      actionKey,
      boardId: key,
      actionId,
      noop: true,
      result: cloneValue(result),
      createdAt: Date.now(),
    };
    // No top-level revision is stored for a no-op, so it is deliberately absent from
    // the compound boardRevision journal index and cannot create a revision gap.
    await requestResult(commits.add(record));
    return { result: cloneValue(result), duplicate: false };
  });
}

export async function persistAuthorityCommit(boardId, commit) {
  const key = String(boardId ?? '').trim();
  const actionId = String(commit?.actionId ?? '').trim();
  if (!key) throw new Error('boardId is required');
  if (!actionId) throw new Error('actionId is required');
  const actionKey = `${key}:${actionId}`;

  return withTransaction([BOARD_STORE, COMMIT_STORE], 'readwrite', async (transaction) => {
    const boards = transaction.objectStore(BOARD_STORE);
    const commits = transaction.objectStore(COMMIT_STORE);
    const existing = await requestResult(commits.get(actionKey));
    if (existing) {
      return {
        commit: cloneValue(existing.noop ? existing.result : existing),
        duplicate: true,
      };
    }

    const board = await requestResult(boards.get(key));
    if (!board) throw new Error('Authority board not found');

    const expectedRevision = Number(board.revision ?? 0) + 1;
    const revision = Number(commit?.revision ?? 0);
    if (!Number.isInteger(revision) || revision !== expectedRevision) {
      throw new Error(`Authority revision mismatch: expected ${expectedRevision}, received ${revision}`);
    }

    const record = {
      ...cloneValue(commit),
      boardId: key,
      actionId,
      actionKey,
      revision,
    };
    const nextBoard = {
      ...board,
      revision,
      tombstones: applyCommitTombstones(board.tombstones, record),
      updatedAt: Number(commit?.committedAt ?? Date.now()) || Date.now(),
    };

    await requestResult(commits.add(record));
    await requestResult(boards.put(nextBoard));
    return { commit: cloneValue(record), duplicate: false };
  });
}

export async function getAuthorityCommitsAfter(boardId, revision = 0, limit = 500) {
  const key = String(boardId ?? '').trim();
  if (!key) return [];
  const floor = Math.max(0, Number(revision ?? 0) || 0);
  const safeLimit = Math.max(1, Math.min(1000, Number(limit ?? 500) || 500));

  return withTransaction([COMMIT_STORE], 'readonly', async (transaction) => {
    const index = transaction.objectStore(COMMIT_STORE).index(BOARD_REVISION_INDEX);
    const range = IDBKeyRange.bound(
      [key, floor + 1],
      [key, Number.MAX_SAFE_INTEGER],
    );
    return new Promise((resolve, reject) => {
      const results = [];
      const request = index.openCursor(range, 'next');
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || results.length >= safeLimit) {
          resolve(results.map(cloneValue));
          return;
        }
        results.push(cursor.value);
        cursor.continue();
      };
      request.onerror = () => reject(request.error ?? new Error('Could not read authority journal'));
    });
  });
}

export async function saveAuthoritySnapshot(boardId, snapshot, revision) {
  const key = String(boardId ?? '').trim();
  if (!key) throw new Error('boardId is required');
  const snapshotRevision = Math.max(0, Number(revision ?? 0) || 0);

  return withTransaction([BOARD_STORE], 'readwrite', async (transaction) => {
    const boards = transaction.objectStore(BOARD_STORE);
    const board = await requestResult(boards.get(key));
    if (!board) throw new Error('Authority board not found');
    if (snapshotRevision > Number(board.revision ?? 0)) {
      throw new Error('Snapshot cannot be newer than the authoritative revision');
    }
    if (snapshotRevision < Number(board.snapshotRevision ?? 0)) return Number(board.snapshotRevision ?? 0);

    await requestResult(boards.put({
      ...board,
      snapshot: cloneValue(snapshot ?? EMPTY_SNAPSHOT),
      snapshotRevision,
      updatedAt: Math.max(Number(board.updatedAt ?? 0), Date.now()),
    }));
    return snapshotRevision;
  });
}

export async function putAuthorityAsset(boardId, assetId, blob, metadata = {}) {
  const key = String(boardId ?? '').trim();
  const id = String(assetId ?? '').trim();
  if (!key || !id) throw new Error('boardId and assetId are required');
  const record = {
    assetKey: `${key}:${id}`,
    boardId: key,
    assetId: id,
    blob,
    contentType: String(metadata?.contentType ?? blob?.type ?? ''),
    byteSize: Number(metadata?.byteSize ?? blob?.size ?? 0),
    width: Number(metadata?.width ?? 0),
    height: Number(metadata?.height ?? 0),
    createdAt: Number(metadata?.createdAt ?? Date.now()) || Date.now(),
  };
  return withTransaction([ASSET_STORE], 'readwrite', async (transaction) => {
    await requestResult(transaction.objectStore(ASSET_STORE).put(record));
    return { ...record, blob };
  });
}

export async function getAuthorityAsset(boardId, assetId) {
  const key = `${String(boardId ?? '').trim()}:${String(assetId ?? '').trim()}`;
  return withTransaction([ASSET_STORE], 'readonly', async (transaction) => {
    const record = await requestResult(transaction.objectStore(ASSET_STORE).get(key));
    return record ?? null;
  });
}
