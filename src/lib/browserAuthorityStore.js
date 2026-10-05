import { isAuthoritativeBoardOperation } from './operationProtocol.js';
import { isNotebookOperation, notebookChildKey } from './notebookOperations.js';
import { boardTombstoneDelta } from './boardTombstoneIndex.js';
const DB_NAME = 'alex-board-authority';
const DB_VERSION = 4;
const BOARD_TOMBSTONE_STORE = 'boardTombstones';
const TOMBSTONE_MIGRATION_STORE = 'boardTombstoneMigrations';
const TOMBSTONE_BACKUP_STORE = 'boardTombstoneBackups';
const NOTEBOOK_OUTBOX_STORE = 'notebookOutbox';
const SNAPSHOT_STORE = 'snapshots';
const NOTEBOOK_TOMBSTONE_STORE = 'notebookTombstones';
const BOARD_STORE = 'boards';
const COMMIT_STORE = 'commits';
const ASSET_STORE = 'assets';
const BOARD_REVISION_INDEX = 'boardRevision';
const BOARD_ID_INDEX = 'boardId';
const OPEN_TIMEOUT_MS = 15_000;
const CREATE_TIMEOUT_MS = 15_000;
const LIBRARY_TIMEOUT_MS = 30_000;
let mediaCleanupRecovery = null;

function storageTimeout(message) {
  const error = new Error(message);
  error.name = 'TimeoutError';
  return error;
}

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
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(() => fail(storageTimeout(
      'Хранилище досок не отвечает. Закройте другие вкладки доски и перезагрузите страницу. Не очищайте данные сайта.',
    )), OPEN_TIMEOUT_MS);
    request.onupgradeneeded = () => {
      if (settled) {
        try { request.transaction?.abort(); } catch { /* already ended */ }
        request.result.close();
        return;
      }
      const db = request.result;

      if (!db.objectStoreNames.contains(BOARD_STORE)) {
        db.createObjectStore(BOARD_STORE, { keyPath: 'boardId' });
      }

      if (!db.objectStoreNames.contains(COMMIT_STORE)) {
        const commits = db.createObjectStore(COMMIT_STORE, { keyPath: 'actionKey' });
        commits.createIndex(BOARD_REVISION_INDEX, ['boardId', 'revision'], { unique: true });
        commits.createIndex(BOARD_ID_INDEX, 'boardId', { unique: false });
      }

      if (!db.objectStoreNames.contains(SNAPSHOT_STORE)) {
        db.createObjectStore(SNAPSHOT_STORE, { keyPath: 'boardId' });
        const cursorRequest = request.transaction.objectStore(BOARD_STORE).openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) return;
          const { snapshot = EMPTY_SNAPSHOT, ...metadata } = cursor.value;
          request.transaction.objectStore(SNAPSHOT_STORE).put({ boardId: metadata.boardId, snapshot });
          cursor.update(metadata);
          cursor.continue();
        };
        // An abort rolls back both stores and the version. No partial migration
        // can leave a metadata row with its old saved lesson missing.
      }
      if (!db.objectStoreNames.contains(NOTEBOOK_TOMBSTONE_STORE)) {
        const tombstones = db.createObjectStore(NOTEBOOK_TOMBSTONE_STORE, { keyPath: ['boardId', 'childKey'] });
        tombstones.createIndex(BOARD_ID_INDEX, 'boardId');
      }

      if (!db.objectStoreNames.contains(BOARD_TOMBSTONE_STORE)) {
        const deleted = db.createObjectStore(BOARD_TOMBSTONE_STORE, { keyPath: ['boardId', 'objectId'] });
        deleted.createIndex(BOARD_ID_INDEX, 'boardId');
      }
      if (!db.objectStoreNames.contains(TOMBSTONE_MIGRATION_STORE)) {
        db.createObjectStore(TOMBSTONE_MIGRATION_STORE, { keyPath: 'boardId' });
      }
      if (!db.objectStoreNames.contains(TOMBSTONE_BACKUP_STORE)) {
        db.createObjectStore(TOMBSTONE_BACKUP_STORE, { keyPath: 'boardId' });
      }

      if (!db.objectStoreNames.contains(NOTEBOOK_OUTBOX_STORE)) {
        const pending = db.createObjectStore(NOTEBOOK_OUTBOX_STORE, { keyPath: 'sequence', autoIncrement: true });
        pending.createIndex('pendingAction', ['boardId', 'clientId', 'actionId'], { unique: true });
        pending.createIndex('boardClient', ['boardId', 'clientId']);
        pending.createIndex(BOARD_ID_INDEX, 'boardId');
      }

      if (!db.objectStoreNames.contains(ASSET_STORE)) {
        const assets = db.createObjectStore(ASSET_STORE, { keyPath: 'assetKey' });
        assets.createIndex(BOARD_ID_INDEX, 'boardId', { unique: false });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      if (settled) {
        // IndexedDB.open cannot be cancelled. Retire a late result without ever
        // starting a create transaction or retaining a blocking connection.
        db.close();
        return;
      }
      settled = true;
      clearTimeout(timer);
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => fail(request.error ?? new Error('Could not open authority database'));
    request.onblocked = () => fail(new Error(
      'Хранилище досок заблокировано другой вкладкой. Закройте другие вкладки доски и повторите. Не очищайте данные сайта.',
    ));
  });
}

async function withTransaction(storeNames, mode, work, timeoutMs = 0) {
  const db = await openDatabase();
  let transaction;
  let timer;
  try {
    transaction = db.transaction(storeNames, mode);
    let rejectCompletion;
    const completion = new Promise((resolve, reject) => {
      rejectCompletion = reject;
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Authority transaction failed'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Authority transaction aborted'));
    });
    // A synchronous work failure or abort can occur before Promise.all attaches.
    // Observe that rejection without changing the result reported to the caller.
    completion.catch(() => {});
    if (timeoutMs > 0) {
      timer = setTimeout(() => rejectCompletion(storageTimeout(
        'Не удалось дождаться хранилища досок. Перезагрузите страницу и проверьте «Мои доски» перед повтором. Не очищайте данные сайта.',
      )), timeoutMs);
    }
    // Observe transaction failure even if an individual request never settles;
    // success still requires the transaction's complete event, not just add().
    const [result] = await Promise.all([work(transaction), completion]);
    return result;
  } catch (error) {
    try { transaction?.abort(); } catch { /* already committed or aborted */ }
    // Do not wait forever for a broken browser to deliver the abort event.
    throw error;
  } finally {
    clearTimeout(timer);
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
  assertTombstoneStorageReadable(input ?? {});
  if (input?.notebookVersion != null && ![0, 1].includes(input.notebookVersion)) {
    throw new Error('Unsupported notebook format version; update required');
  }
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
    notebookTombstones: cloneValue(input?.notebookTombstones ?? {}),
    ...(input?.notebookVersion === 1 ? { notebookVersion: 1 } : {}),
    protocolVersion: 1,
    ...(input?.verificationVersion === 1 ? { verificationVersion: 1 } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

function tombstoneStorageError(message, code = 'tombstone_migration_conflict') {
  return Object.assign(new Error(message), { code });
}
function assertTombstoneStorageReadable(board) {
  if (board.tombstoneStorageVersion != null && board.tombstoneStorageVersion !== 1) {
    throw tombstoneStorageError('Update required for this deletion storage format', 'tombstone_update_required');
  }
}
function legacyTombstones(board) {
  const value = Object.hasOwn(board, 'tombstones') ? board.tombstones : {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw tombstoneStorageError('Invalid original tombstone table; migration stopped, do not clear site data');
  }
  return value;
}
async function readStoredTombstones(transaction, board) {
  assertTombstoneStorageReadable(board);
  if (board.tombstoneStorageVersion !== 1) return legacyTombstones(board);
  const records = await requestResult(transaction.objectStore(BOARD_TOMBSTONE_STORE).index(BOARD_ID_INDEX).getAll(board.boardId));
  return Object.fromEntries(records.map(row => [row.objectId, row.value]));
}

/** Upgrade only the addressed board, retaining the untouched original and a
 * recovery copy until an atomic final switch. Commits cannot write a legacy row
 * while this runs. Batches yield actual IDB transactions; no lesson/media/outbox
 * rewrite and no automatic expiration of deletion history occur here.
 */
export async function migrateAuthorityBoardTombstones(boardId, { batchSize = 128, signal, onProgress } = {}) {
  const key = String(boardId ?? '').trim();
  if (!key) throw new Error('boardId is required');
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000) throw new TypeError('Migration batch size must be 1..1000');
  const assertActive = () => { if (signal?.aborted) throw new DOMException('Migration interrupted; original data retained', 'AbortError'); };
  assertActive();
  const source = await withTransaction([BOARD_STORE, TOMBSTONE_MIGRATION_STORE, TOMBSTONE_BACKUP_STORE], 'readwrite', async tx => {
    const board = await requestResult(tx.objectStore(BOARD_STORE).get(key));
    if (!board) throw new Error('Authority board not found');
    assertTombstoneStorageReadable(board);
    if (board.tombstoneStorageVersion === 1) return null;
    const table = legacyTombstones(board), signature = JSON.stringify(table), keys = Object.keys(table).sort();
    const migrations = tx.objectStore(TOMBSTONE_MIGRATION_STORE), backups = tx.objectStore(TOMBSTONE_BACKUP_STORE);
    const [progress, backup] = await Promise.all([requestResult(migrations.get(key)), requestResult(backups.get(key))]);
    const sourceRevision = Number(board.revision ?? 0);
    if (progress || backup) {
      if (!progress || !backup || progress.sourceRevision !== sourceRevision || backup.sourceRevision !== sourceRevision
        || progress.count !== keys.length || JSON.stringify(backup.tombstones) !== signature) {
        throw tombstoneStorageError('Original data changed during migration; original table retained');
      }
    } else {
      await requestResult(backups.add({ boardId: key, sourceRevision, tombstones: table, createdAt: Date.now() }));
      await requestResult(migrations.add({ boardId: key, sourceRevision, count: keys.length, cursor: 0 }));
    }
    return { table, keys, signature, sourceRevision };
  });
  if (!source) return { migrated: false, storageVersion: 1 };
  for (;;) {
    assertActive();
    const progress = await withTransaction([TOMBSTONE_MIGRATION_STORE, BOARD_TOMBSTONE_STORE], 'readwrite', async tx => {
      const migrations = tx.objectStore(TOMBSTONE_MIGRATION_STORE), current = await requestResult(migrations.get(key));
      if (!current) return null; // Another caller finished, or the board was deleted.
      if (current.sourceRevision !== source.sourceRevision || current.count !== source.keys.length
        || !Number.isSafeInteger(current.cursor) || current.cursor < 0 || current.cursor > current.count) {
        throw tombstoneStorageError('Invalid migration progress; original table retained');
      }
      const end = Math.min(current.count, current.cursor + batchSize), target = tx.objectStore(BOARD_TOMBSTONE_STORE);
      for (let i = current.cursor; i < end; i++) {
        const objectId = source.keys[i];
        await requestResult(target.put({ boardId: key, objectId, value: source.table[objectId] }));
      }
      if (end !== current.cursor) await requestResult(migrations.put({ ...current, cursor: end }));
      return { copied: end, total: current.count };
    });
    if (!progress) break;
    try { await onProgress?.(progress); } catch { /* Observers cannot corrupt saved migration progress. */ }
    if (progress.copied === progress.total) break;
  }
  assertActive();
  return withTransaction([BOARD_STORE, TOMBSTONE_MIGRATION_STORE, BOARD_TOMBSTONE_STORE], 'readwrite', async tx => {
    const boards = tx.objectStore(BOARD_STORE), board = await requestResult(boards.get(key));
    if (!board) throw new Error('Authority board not found');
    assertTombstoneStorageReadable(board);
    if (board.tombstoneStorageVersion === 1) return { migrated: false, storageVersion: 1 };
    const migrations = tx.objectStore(TOMBSTONE_MIGRATION_STORE);
    const progress = await requestResult(migrations.get(key));
    const count = await requestResult(tx.objectStore(BOARD_TOMBSTONE_STORE).index(BOARD_ID_INDEX).count(key));
    if (!progress || progress.cursor !== source.keys.length || progress.count !== source.keys.length
      || progress.sourceRevision !== source.sourceRevision || Number(board.revision ?? 0) !== source.sourceRevision
      || count !== source.keys.length || JSON.stringify(legacyTombstones(board)) !== source.signature) {
      throw tombstoneStorageError('Incomplete or changed migration; original table retained');
    }
    const { tombstones, ...metadata } = board;
    await requestResult(boards.put({ ...metadata, tombstoneStorageVersion: 1 }));
    await requestResult(migrations.delete(key));
    // Retain the original backup for recovery; it is NOT the new canonical table
    // and may not be used to discard newer confirmed edits during rollback.
    return { migrated: true, storageVersion: 1, copied: count };
  });
}

async function readStoredSnapshot(transaction, board) {
  const record = await requestResult(transaction.objectStore(SNAPSHOT_STORE).get(board.boardId));
  if (!record || !Object.hasOwn(record, 'snapshot')) throw new Error('Authority baseline is missing; do not clear site data');
  return { ...board, snapshot: record.snapshot, tombstones: await readStoredTombstones(transaction, board) };
}

export async function createAuthorityBoard(input) {
  const board = normalizeBoardInput(input);
  return withTransaction([BOARD_STORE, SNAPSHOT_STORE, NOTEBOOK_TOMBSTONE_STORE, BOARD_TOMBSTONE_STORE], 'readwrite', async (transaction) => {
    const { snapshot, notebookTombstones, tombstones, ...metadata } = board;
    await requestResult(transaction.objectStore(BOARD_STORE).add({ ...metadata, tombstoneStorageVersion: 1 }));
    await requestResult(transaction.objectStore(SNAPSHOT_STORE).add({ boardId: board.boardId, snapshot }));
    for (const [objectId, value] of Object.entries(tombstones)) {
      await requestResult(transaction.objectStore(BOARD_TOMBSTONE_STORE).put({ boardId: board.boardId, objectId, value }));
    }
    for (const [childKey, value] of Object.entries(notebookTombstones)) {
      await requestResult(transaction.objectStore(NOTEBOOK_TOMBSTONE_STORE).put({ boardId: board.boardId, childKey, value }));
    }
    return { ...cloneValue(board), tombstoneStorageVersion: 1 };
  }, CREATE_TIMEOUT_MS);
}

/** Permission checks and head reads must not decode a lesson snapshot per stroke. */
export async function getAuthorityBoardMetadata(boardId) {
  const key = String(boardId ?? '').trim();
  if (!key) return null;
  return withTransaction([BOARD_STORE], 'readonly', async transaction => {
    const board = await requestResult(transaction.objectStore(BOARD_STORE).get(key));
    return board ? cloneValue(board) : null;
  });
}

export async function getAuthorityBoard(boardId) {
  const key = String(boardId ?? '').trim();
  if (!key) return null;
  return withTransaction([BOARD_STORE, SNAPSHOT_STORE, NOTEBOOK_TOMBSTONE_STORE, BOARD_TOMBSTONE_STORE], 'readonly', async transaction => {
    const board = await requestResult(transaction.objectStore(BOARD_STORE).get(key));
    if (!board) return null;
    const [full, deleted] = await Promise.all([
      readStoredSnapshot(transaction, board),
      requestResult(transaction.objectStore(NOTEBOOK_TOMBSTONE_STORE).index(BOARD_ID_INDEX).getAll(key)),
    ]);
    return { ...full, notebookTombstones: Object.fromEntries(deleted.map(row => [row.childKey, row.value])) };
  });
}

export async function listAuthorityBoards() {
  const result = await withTransaction([BOARD_STORE, SNAPSHOT_STORE, BOARD_TOMBSTONE_STORE], 'readonly', async (transaction) => {
    const boards = await requestResult(transaction.objectStore(BOARD_STORE).getAll());
    const full = await Promise.all((Array.isArray(boards) ? boards : []).map(board => readStoredSnapshot(transaction, board)));
    return full
      .map(cloneValue)
      .sort((left, right) => Number(right.updatedAt ?? 0) - Number(left.updatedAt ?? 0));
  }, LIBRARY_TIMEOUT_MS);
  // Recover only after a successful library read. A failed/stalled library must
  // retain its existing timeout and must not initiate any cleanup writes.
  if (!mediaCleanupRecovery) {
    mediaCleanupRecovery = recoverAuthorityMediaCleanup().catch(() => {})
      .finally(() => { mediaCleanupRecovery = null; });
  }
  return result;
}

export async function updateAuthorityBoardMetadata(boardId, patch = {}) {
  const key = String(boardId ?? '').trim();
  if (!key) throw new Error('boardId is required');
  return withTransaction([BOARD_STORE, SNAPSHOT_STORE, BOARD_TOMBSTONE_STORE], 'readwrite', async (transaction) => {
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
    return readStoredSnapshot(transaction, next);
  });
}

export async function deleteAuthorityBoard(boardId) {
  const key = String(boardId ?? '').trim();
  if (!key) return false;
  const removed = await withTransaction([BOARD_STORE, COMMIT_STORE, ASSET_STORE, SNAPSHOT_STORE, NOTEBOOK_TOMBSTONE_STORE, NOTEBOOK_OUTBOX_STORE, BOARD_TOMBSTONE_STORE, TOMBSTONE_MIGRATION_STORE, TOMBSTONE_BACKUP_STORE], 'readwrite', async (transaction) => {
    const boards = transaction.objectStore(BOARD_STORE);
    const existing = await requestResult(boards.get(key));
    if (!existing) return false;
    await Promise.all([
      requestResult(boards.delete(key)),
      requestResult(transaction.objectStore(SNAPSHOT_STORE).delete(key)),
      deleteRecordsByBoardId(transaction.objectStore(NOTEBOOK_TOMBSTONE_STORE), key),
      deleteRecordsByBoardId(transaction.objectStore(NOTEBOOK_OUTBOX_STORE), key),
      deleteRecordsByBoardId(transaction.objectStore(BOARD_TOMBSTONE_STORE), key),
      requestResult(transaction.objectStore(TOMBSTONE_MIGRATION_STORE).delete(key)),
      requestResult(transaction.objectStore(TOMBSTONE_BACKUP_STORE).delete(key)),
      deleteRecordsByBoardId(transaction.objectStore(COMMIT_STORE), key),
      deleteRecordsByBoardId(transaction.objectStore(ASSET_STORE), key),
    ]);
    await requestResult(transaction.objectStore(ASSET_STORE).put({
      assetKey: `media-cleanup:${key}`, mediaCleanupBoardId: key,
    }));
    return true;
  });
  // Preserve the journal on failure so the next library visit can finish it.
  await recoverAuthorityMediaCleanup(key).catch(() => {});
  return removed;
}

export async function recoverAuthorityMediaCleanup(boardId) {
  const pending = await withTransaction([ASSET_STORE], 'readonly', async transaction => {
    const assets = transaction.objectStore(ASSET_STORE);
    if (boardId) {
      const entry = await requestResult(assets.get(`media-cleanup:${boardId}`));
      return entry ? [entry] : [];
    }
    return requestResult(assets.getAll(IDBKeyRange.bound('media-cleanup:', 'media-cleanup:\uffff')));
  }, LIBRARY_TIMEOUT_MS);
  if (!pending.length) return;
  const { boardMediaAssets } = await import('./mediaAssetStore.js');
  for (const entry of pending) {
    await boardMediaAssets.deleteBoard(entry.mediaCleanupBoardId);
    await withTransaction([ASSET_STORE], 'readwrite', transaction =>
      requestResult(transaction.objectStore(ASSET_STORE).delete(entry.assetKey)), LIBRARY_TIMEOUT_MS);
  }
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

  const save = () => withTransaction([BOARD_STORE, COMMIT_STORE, NOTEBOOK_TOMBSTONE_STORE, BOARD_TOMBSTONE_STORE], 'readwrite', async (transaction) => {
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
    assertTombstoneStorageReadable(board);
    if (board.tombstoneStorageVersion !== 1) throw tombstoneStorageError('Tombstone migration required', 'tombstone_migration_required');

    const expectedRevision = Number(board.revision ?? 0) + 1;
    const revision = Number(commit?.revision ?? 0);
    if (!Number.isInteger(revision) || revision !== expectedRevision) {
      throw new Error(`Authority revision mismatch: expected ${expectedRevision}, received ${revision}`);
    }

    const childOps = (commit.ops ?? []).filter(op => op?.type === 'notebook');
    if (childOps.some(op => !isNotebookOperation(op))) throw new Error('Invalid notebook journal operation');
    if (Number(board.notebookVersion ?? 0) > 1) throw new Error('Update required for this notebook');

    const record = {
      ...cloneValue(commit),
      boardId: key,
      actionId,
      actionKey,
      revision,
      ...(childOps.length ? { notebookVersion: 1 } : {}),
    };
    const nextBoard = {
      ...board,
      revision,
      ...(childOps.length ? { notebookVersion: 1 } : {}),
      updatedAt: Number(commit?.committedAt ?? Date.now()) || Date.now(),
    };

    const deleted = transaction.objectStore(NOTEBOOK_TOMBSTONE_STORE);
    for (const operation of childOps) for (const change of operation.changes) {
      const childKey = notebookChildKey(operation.id, operation.pageNumber, change.object?.boardObjectId ?? change.id);
      if (change.type === 'delete') await requestResult(deleted.put({ boardId: key, childKey, value: {
        clientId: String(record.clientId ?? ''), actionId, revision,
        mutationId: String(change.mutationId ?? operation.mutationId ?? actionId),
      } }));
      else if (change.type === 'insert') await requestResult(deleted.delete([key, childKey]));
    }
    const topDeleted = transaction.objectStore(BOARD_TOMBSTONE_STORE);
    for (const change of boardTombstoneDelta(record.ops, record)) {
      if (change.type === 'set') await requestResult(topDeleted.put({ boardId: key, objectId: change.id, value: change.value }));
      else await requestResult(topDeleted.delete([key, change.id]));
    }
    await requestResult(commits.add(record));
    await requestResult(boards.put(nextBoard));
    return { commit: cloneValue(record), duplicate: false };
  });
  try { return await save(); } catch (error) {
    if (error.code !== 'tombstone_migration_required') throw error;
    await migrateAuthorityBoardTombstones(key);
    return save();
  }
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

  return withTransaction([BOARD_STORE, SNAPSHOT_STORE], 'readwrite', async (transaction) => {
    const boards = transaction.objectStore(BOARD_STORE);
    const board = await requestResult(boards.get(key));
    if (!board) throw new Error('Authority board not found');
    assertTombstoneStorageReadable(board);
    if (snapshotRevision > Number(board.revision ?? 0)) {
      throw new Error('Snapshot cannot be newer than the authoritative revision');
    }
    if (snapshotRevision < Number(board.snapshotRevision ?? 0)) return Number(board.snapshotRevision ?? 0);

    await requestResult(transaction.objectStore(SNAPSHOT_STORE).put({ boardId: key, snapshot: cloneValue(snapshot ?? EMPTY_SNAPSHOT) }));
    await requestResult(boards.put({
      ...board,
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


/**
 * Durable local pending intents share the existing database, but not the board
 * baseline/commit stores. This also works for a student without an owner board.
 * Stable action identities are append-once; only acknowledgement or an explicit
 * clear/delete removes a row. Sequence keys preserve order across browser reload.
 */
export function createNotebookOutbox({ boardId, clientId, maxPending = 1024, maxActionBytes = 8 * 1024 * 1024 } = {}) {
  const board = String(boardId ?? '').trim(), client = String(clientId ?? '').trim();
  if (!board || !client) throw new TypeError('Notebook outbox board and client are required');
  if (![maxPending, maxActionBytes].every(value => Number.isSafeInteger(value) && value > 0)) throw new TypeError('Invalid notebook outbox limits');
  const scope = [board, client];
  function validate(input) {
    if (!input || !String(input.actionId ?? '').trim() || input.clientId !== client) throw new TypeError('Notebook outbox action/client identity is invalid');
    if (!Array.isArray(input.ops) || !input.ops.length || !input.ops.every(isAuthoritativeBoardOperation)) throw new TypeError('Invalid notebook outbox operations');
    const action = cloneValue(input), encoded = JSON.stringify(action);
    if (new TextEncoder().encode(encoded).byteLength > maxActionBytes) throw new Error('Notebook outbox action exceeds byte limit');
    return { action, encoded };
  }
  return {
    async save(input) {
      const { action, encoded } = validate(input);
      return withTransaction([NOTEBOOK_OUTBOX_STORE], 'readwrite', async transaction => {
        const store = transaction.objectStore(NOTEBOOK_OUTBOX_STORE);
        const previous = await requestResult(store.index('pendingAction').get([board, client, action.actionId]));
        if (previous) {
          if (JSON.stringify(previous.action) !== encoded) throw new Error('Notebook action identity already contains different content');
          return previous.sequence;
        }
        if (await requestResult(store.index('boardClient').count(IDBKeyRange.only(scope))) >= maxPending) {
          throw new Error('Notebook outbox full; existing unsent actions retained');
        }
        return requestResult(store.add({ boardId: board, clientId: client, actionId: action.actionId, action }));
      }, CREATE_TIMEOUT_MS);
    },
    async list() {
      return withTransaction([NOTEBOOK_OUTBOX_STORE], 'readonly', async transaction => {
        const values = await requestResult(transaction.objectStore(NOTEBOOK_OUTBOX_STORE).index('boardClient').getAll(IDBKeyRange.only(scope)));
        return values.map(record => {
          validate(record.action); // Unknown future operations are not silently skipped.
          return cloneValue(record.action);
        });
      }, LIBRARY_TIMEOUT_MS);
    },
    async remove(actionId) {
      return withTransaction([NOTEBOOK_OUTBOX_STORE], 'readwrite', async transaction => {
        const store = transaction.objectStore(NOTEBOOK_OUTBOX_STORE);
        const key = await requestResult(store.index('pendingAction').getKey([board, client, String(actionId)]));
        if (key != null) await requestResult(store.delete(key));
      }, CREATE_TIMEOUT_MS);
    },
    async clear() {
      return withTransaction([NOTEBOOK_OUTBOX_STORE], 'readwrite', transaction => new Promise((resolve, reject) => {
        const cursor = transaction.objectStore(NOTEBOOK_OUTBOX_STORE).index('boardClient').openCursor(IDBKeyRange.only(scope));
        cursor.onerror = () => reject(cursor.error);
        cursor.onsuccess = () => {
          if (!cursor.result) { resolve(); return; }
          cursor.result.delete(); cursor.result.continue();
        };
      }), CREATE_TIMEOUT_MS);
    },
  };
}
