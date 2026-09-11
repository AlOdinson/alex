import { applyAuthorityActions, applyAuthorityOps } from './authoritySnapshot.js';
import {
  createAuthorityBoard,
  deleteAuthorityBoard,
  getAuthorityBoard,
  getAuthorityCommitsAfter,
  listAuthorityBoards,
  saveAuthoritySnapshot,
  updateAuthorityBoardMetadata,
} from './browserAuthorityStore.js';
import { openBrowserBoardAuthority } from './browserBoardAuthority.js';
import {
  getReplicaChangesAfter,
  getReplicaState,
} from './browserReplicaStore.js';
import { getBoardRuntime } from './browserBoardRuntimeRegistry.js';
import { localBoardLibrary } from './localBoardLibrary.js';

const EMPTY_SNAPSHOT = { version: 2, background: 'grid', canvas: { objects: [] } };
const LOCK_TTL_MS = 12_000;

function cloneValue(value) {
  if (value == null || typeof value !== 'object') return value;
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function safeRevision(value) {
  const revision = Number(value ?? 0);
  return Number.isInteger(revision) && revision >= 0 ? revision : 0;
}

function isoTime(value) {
  const numeric = Number(value ?? Date.now()) || Date.now();
  return new Date(numeric).toISOString();
}

function accessMetadata(board, permission, snapshot, revision) {
  const currentRevision = safeRevision(revision);
  return {
    permission,
    realtimeKey: String(board?.realtimeKey ?? board?.shareKey ?? ''),
    guestMode: board?.guestMode === 'view' ? 'view' : 'edit',
    gameLibraryVisible: Boolean(board?.gameLibraryVisible),
    title: String(board?.title ?? 'Доска'),
    studentName: String(board?.studentName ?? ''),
    snapshot: snapshot ? cloneValue(snapshot) : null,
    snapshotRevision: currentRevision,
    revision: currentRevision,
    updatedAt: isoTime(board?.updatedAt),
    createdAt: isoTime(board?.createdAt),
  };
}

export function createBrowserBoardRepository({
  getBoard = getAuthorityBoard,
  listBoards = listAuthorityBoards,
  createBoard = (title, studentName) => localBoardLibrary.createBoard(title, studentName),
  updateBoard = updateAuthorityBoardMetadata,
  deleteBoardRecord = deleteAuthorityBoard,
  openAuthority = openBrowserBoardAuthority,
  saveSnapshot = saveAuthoritySnapshot,
  getReplica = getReplicaState,
  getReplicaChanges = getReplicaChangesAfter,
  getRuntime = getBoardRuntime,
} = {}) {
  const requireOwner = async (boardId, key) => {
    const board = await getBoard(String(boardId ?? '').trim());
    if (!board || String(board.ownerKey ?? '') !== String(key ?? '')) {
      throw new Error('Owner permission required');
    }
    return board;
  };

  const localAccess = async (board, key) => {
    let permission = null;
    if (String(key ?? '') === String(board.ownerKey ?? '')) permission = 'owner';
    else if (String(key ?? '') === String(board.shareKey ?? '')) permission = board.guestMode === 'view' ? 'view' : 'edit';
    if (!permission) return null;

    const authority = await openAuthority({ boardId: board.boardId });
    return accessMetadata(
      board,
      permission,
      authority.getSnapshot(),
      authority.getRevision(),
    );
  };

  const remoteAccess = (boardId, key) => {
    const secret = String(key ?? '').trim();
    if (!secret) return null;
    const replica = getReplica(String(boardId ?? '').trim());
    return {
      permission: 'edit',
      realtimeKey: secret,
      guestMode: 'edit',
      gameLibraryVisible: false,
      title: 'Доска',
      studentName: '',
      snapshot: replica?.snapshot ? cloneValue(replica.snapshot) : null,
      snapshotRevision: safeRevision(replica?.revision),
      revision: safeRevision(replica?.revision),
      updatedAt: null,
      createdAt: null,
    };
  };

  const getAccess = async (boardId, key) => {
    const id = String(boardId ?? '').trim();
    if (!id) return null;
    const board = await getBoard(id);
    return board ? localAccess(board, key) : remoteAccess(id, key);
  };

  const activeRuntime = (boardId) => getRuntime(String(boardId ?? '').trim());

  return {
    async createBoard(title = 'Новая доска', studentName = '') {
      const created = await createBoard(title, studentName);
      return {
        boardId: created.boardId,
        ownerKey: created.ownerKey,
        shareKey: created.shareKey,
        createdAt: isoTime(created.createdAt),
      };
    },

    async getOwnedBoardSummaries(entries) {
      const ids = new Set((Array.isArray(entries) ? entries : []).map((entry) => String(entry?.boardId ?? '')));
      const boards = await listBoards();
      return boards.filter((board) => ids.has(String(board.boardId))).map((board) => ({
        boardId: board.boardId,
        title: board.title,
        studentName: board.studentName ?? '',
        createdAt: isoTime(board.createdAt),
        updatedAt: isoTime(board.updatedAt),
        lastLessonAt: isoTime(board.updatedAt),
      }));
    },

    async deleteOwnedBoards(entries, { onProgress = null } = {}) {
      const source = Array.isArray(entries) ? entries : [];
      const deletedBoardIds = [];
      const detachedBoardIds = [];
      const failedBoardIds = [];
      const failures = [];
      for (let index = 0; index < source.length; index += 1) {
        const entry = source[index];
        const boardId = String(entry?.boardId ?? '');
        let deleted = false;
        try {
          // A library entry may legitimately outlive its local IndexedDB authority
          // record (manual browser data cleanup, prior deletion, or another tab). In
          // that case there is nothing left to authorize or delete: detach it from the
          // visible library as an idempotent success. Existing records still require
          // the exact owner key before any destructive operation.
          // eslint-disable-next-line no-await-in-loop
          const board = await getBoard(boardId);
          if (!board) {
            deleted = true;
            deletedBoardIds.push(boardId);
            detachedBoardIds.push(boardId);
          } else {
            if (String(board.ownerKey ?? '') !== String(entry?.ownerKey ?? '')) {
              throw new Error('Owner permission required');
            }
            // eslint-disable-next-line no-await-in-loop
            const removed = Boolean(await deleteBoardRecord(boardId));
            deleted = true;
            deletedBoardIds.push(boardId);
            // deleteAuthorityBoard returns false only when the record vanished between
            // the ownership read and deletion, which is another successful detach.
            if (!removed) detachedBoardIds.push(boardId);
          }
        } catch (error) {
          failedBoardIds.push(boardId);
          failures.push({ boardId, error: String(error?.message ?? error) });
        }
        onProgress?.({ boardId, deleted, completed: index + 1, total: source.length });
      }
      return { deletedBoardIds, detachedBoardIds, failedBoardIds, failures };
    },

    getBoardAccess: getAccess,

    async getBoardRevision(boardId, key) {
      const board = await getBoard(String(boardId ?? '').trim());
      if (board) {
        const access = await localAccess(board, key);
        if (!access) return null;
        return {
          revision: access.revision,
          updatedAt: access.updatedAt,
          permission: access.permission,
          guestMode: access.guestMode,
        };
      }
      const replica = getReplica(String(boardId ?? '').trim());
      if (!String(key ?? '').trim()) return null;
      return {
        revision: safeRevision(replica?.revision),
        updatedAt: null,
        permission: 'edit',
        guestMode: 'edit',
      };
    },

    async getBoardChanges(boardId, key, sinceRevision = 0, limit = 500) {
      const board = await getBoard(String(boardId ?? '').trim());
      if (board) {
        const access = await localAccess(board, key);
        if (!access) return [];
        const authority = await openAuthority({ boardId: board.boardId });
        return authority.getCommitsAfter(safeRevision(sinceRevision), limit);
      }
      if (!String(key ?? '').trim()) return [];
      return getReplicaChanges(String(boardId ?? '').trim(), safeRevision(sinceRevision), limit);
    },

    async getBoardRecovery(boardId, key) {
      const board = await getBoard(String(boardId ?? '').trim());
      if (board) {
        const access = await localAccess(board, key);
        if (!access) return null;
        return { snapshot: access.snapshot, revision: access.revision };
      }
      if (!String(key ?? '').trim()) return null;
      const replica = getReplica(String(boardId ?? '').trim());
      return replica ? { snapshot: cloneValue(replica.snapshot), revision: safeRevision(replica.revision) } : null;
    },

    async setGuestMode(boardId, ownerKey, guestMode) {
      await requireOwner(boardId, ownerKey);
      const mode = guestMode === 'view' ? 'view' : 'edit';
      await updateBoard(String(boardId), { guestMode: mode });
      return mode;
    },

    async setGameLibraryVisibility(boardId, ownerKey, visible) {
      await requireOwner(boardId, ownerKey);
      const nextVisible = Boolean(visible);
      await updateBoard(String(boardId), { gameLibraryVisible: nextVisible });
      return nextVisible;
    },

    async setBoardMetadata(boardId, ownerKey, { title, studentName } = {}) {
      await requireOwner(boardId, ownerKey);
      const patch = {};
      if (typeof title === 'string') patch.title = title.trim() || 'Новая доска';
      if (typeof studentName === 'string') patch.studentName = studentName.trim();
      return updateBoard(String(boardId), patch);
    },

    async deleteBoard(boardId, ownerKey) {
      await requireOwner(boardId, ownerKey);
      return deleteBoardRecord(String(boardId));
    },

    async duplicateBoard(boardId, ownerKey, title = null) {
      const source = await requireOwner(boardId, ownerKey);
      const authority = await openAuthority({ boardId: source.boardId });
      const created = await createBoard(title ?? `${source.title ?? 'Доска'} — копия`, source.studentName ?? '');
      await saveSnapshot(created.boardId, authority.getSnapshot(), 0);
      return {
        boardId: created.boardId,
        ownerKey: created.ownerKey,
        shareKey: created.shareKey,
        createdAt: isoTime(created.createdAt),
      };
    },

    async acquireBoardObjectLocks(boardId, _key, _clientId, lockToken, objectIds) {
      const runtime = activeRuntime(boardId);
      if (!runtime?.requestLock) throw new Error('Board runtime is not ready');
      return runtime.requestLock('acquire', {
        lockToken: String(lockToken ?? ''),
        objectIds: [...new Set((Array.isArray(objectIds) ? objectIds : []).filter(Boolean).map(String))],
        ttlMs: LOCK_TTL_MS,
      });
    },

    async refreshBoardObjectLocks(boardId, _key, _clientId, lockToken) {
      const runtime = activeRuntime(boardId);
      if (!runtime?.requestLock) return { refreshed: false, objectIds: [] };
      return runtime.requestLock('refresh', {
        lockToken: String(lockToken ?? ''),
        ttlMs: LOCK_TTL_MS,
      });
    },

    async releaseBoardObjectLocks(boardId, _key, _clientId, lockToken = null) {
      const runtime = activeRuntime(boardId);
      if (!runtime?.requestLock) return 0;
      const result = await runtime.requestLock('release', {
        lockToken: lockToken == null ? null : String(lockToken),
      });
      return Number(result?.released ?? 0);
    },

    async getBoardObjectLocks() {
      return [];
    },

    async applyBoardAction(boardId, key, action) {
      const board = await requireOwner(boardId, key);
      const authority = await openAuthority({ boardId: board.boardId });
      const commit = await authority.commitAction(action);
      return {
        revision: safeRevision(commit.revision),
        needsSync: Boolean(commit.needsSync),
        updatedAt: isoTime(commit.committedAt),
        alreadyApplied: Boolean(commit.duplicate),
        changed: true,
        appliedOps: cloneValue(commit.ops ?? []),
        appliedBackground: commit.background ?? null,
        rejectedObjectIds: [],
        skippedConflicts: [],
      };
    },

    async applyBoardActionBatch(boardId, key, actions) {
      const results = [];
      for (const action of Array.isArray(actions) ? actions : []) {
        // eslint-disable-next-line no-await-in-loop
        results.push(await this.applyBoardAction(boardId, key, action));
      }
      return results;
    },

    async saveBoardSnapshot(boardId, key, snapshot, revision) {
      const id = String(boardId ?? '').trim();
      const board = await getBoard(id);
      if (!board) {
        if (!String(key ?? '').trim()) return 0;
        // Remote students are read-only with respect to replica durability. Their
        // compaction lifecycle may call this compatibility API, but the only writers
        // to a student replica are authoritative teacher snapshots/commits over P2P.
        return safeRevision(getReplica(id)?.revision);
      }
      await requireOwner(boardId, key);
      return saveSnapshot(id, cloneValue(snapshot ?? EMPTY_SNAPSHOT), safeRevision(revision));
    },
  };
}

export const browserBoardRepository = createBrowserBoardRepository();

export const applyOpsToSnapshot = applyAuthorityOps;
export const applyActionsToSnapshot = applyAuthorityActions;

// Temporary compatibility flag for Board.jsx. It means "an authoritative durable
// backend exists", not that Supabase is in use. It keeps the existing reconciliation
// hooks active while they are redirected to IndexedDB / peer replica state.
export const isSupabaseConfigured = true;
