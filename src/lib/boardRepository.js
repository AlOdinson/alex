import { deriveShareKey, randomToken, sha256 } from './ids.js';
import { isSupabaseConfigured, supabase } from './supabase.js';
import { copySerializedBoardImages } from './imageStorage.js';
import { applySerializedObjectPatch } from './operationProtocol.js';
import {
  clearBoardCache,
  confirmPendingActions,
  getCachedSnapshot,
  getConfirmedActionsAfter,
  getPendingActions,
  setCachedSnapshot,
} from './idb.js';

const LOCAL_PREFIX = 'alex-board:board:';
const BULK_ACTION_THRESHOLD = 220_000;
const BULK_ACTION_CHUNK_TARGET = 150_000;
const BULK_UPLOAD_CONCURRENCY = 4;
const EMPTY_SNAPSHOT = { version: 2, background: 'grid', canvas: { objects: [] } };

function isSerializedActiveSelection(object) {
  const type = String(object?.type ?? '');
  return type === 'ActiveSelection' || type === 'activeSelection';
}

function getLocalBoard(boardId) {
  const raw = localStorage.getItem(`${LOCAL_PREFIX}${boardId}`);
  return raw ? JSON.parse(raw) : null;
}

function setLocalBoard(boardId, value) {
  localStorage.setItem(`${LOCAL_PREFIX}${boardId}`, JSON.stringify(value));
}

function deleteLocalBoard(boardId) {
  localStorage.removeItem(`${LOCAL_PREFIX}${boardId}`);
}

function cloneSnapshot(snapshot) {
  if (typeof structuredClone === 'function') return structuredClone(snapshot);
  return JSON.parse(JSON.stringify(snapshot));
}

function serializedSize(value) {
  try {
    return JSON.stringify(value).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function isMissingFunctionError(error) {
  const message = String(error?.message ?? error ?? '');
  return error?.code === 'PGRST202'
    || /function .* does not exist/i.test(message)
    || /could not find the function/i.test(message);
}

function splitOperationChunks(ops, targetSize = BULK_ACTION_CHUNK_TARGET) {
  const chunks = [];
  let current = [];
  let currentSize = 2;
  for (const op of Array.isArray(ops) ? ops : []) {
    const opSize = serializedSize(op) + 1;
    if (current.length && currentSize + opSize > targetSize) {
      chunks.push(current);
      current = [];
      currentSize = 2;
    }
    current.push(op);
    currentSize += opSize;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

async function runWithConcurrency(items, limit, worker) {
  const source = Array.isArray(items) ? items : [];
  if (!source.length) return;
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(Number(limit ?? 1), source.length)) },
    async () => {
      while (nextIndex < source.length) {
        const index = nextIndex;
        nextIndex += 1;
        // eslint-disable-next-line no-await-in-loop
        await worker(source[index], index);
      }
    },
  );
  await Promise.all(workers);
}

async function applyStandardActionRpc(boardId, keyHash, action) {
  const args = {
    p_id: boardId,
    p_key_hash: keyHash,
    p_action_id: action.actionId,
    p_client_id: action.clientId,
    p_ops: Array.isArray(action.ops) ? action.ops : [],
    p_background: action.background ?? null,
    p_client_revision: Number(action.knownRevision ?? 0),
  };
  const { data, error } = await supabase.rpc('apply_board_action_v8', args);
  return { data, error };
}

async function applyLargeBoardAction(boardId, keyHash, action) {
  const chunks = splitOperationChunks(action.ops);
  const importId = `bulk:${action.actionId}`;
  const uploadChunk = async (chunk, index) => {
    const { data, error } = await supabase.rpc('upload_board_import_chunk_v8', {
      p_id: boardId,
      p_key_hash: keyHash,
      p_import_id: importId,
      p_chunk_index: index,
      p_action_id: action.actionId,
      p_client_id: action.clientId,
      p_ops: chunk,
    });
    if (error) throw error;
    if (!data) throw new Error('Сервер отклонил часть большой операции');
  };

  // Upload the first chunk before parallel workers in case the server initializes the
  // import session lazily. Remaining independent chunks can then travel concurrently.
  if (chunks.length) await uploadChunk(chunks[0], 0);
  await runWithConcurrency(
    chunks.slice(1).map((chunk, offset) => ({ chunk, index: offset + 1 })),
    BULK_UPLOAD_CONCURRENCY,
    ({ chunk, index }) => uploadChunk(chunk, index),
  );

  const { data, error } = await supabase.rpc('commit_board_import_v8', {
    p_id: boardId,
    p_key_hash: keyHash,
    p_import_id: importId,
    p_chunk_count: chunks.length,
    p_action_id: action.actionId,
    p_client_id: action.clientId,
    p_background: action.background,
    p_client_revision: Number(action.knownRevision ?? 0),
  });
  if (error) throw error;
  return data;
}

function normalizeActionResult(data) {
  if (!data) throw new Error('Сервер отклонил изменение доски');
  const rejectedObjectIds = Array.isArray(data.rejected_object_ids)
    ? data.rejected_object_ids.map(String)
    : [];
  const changed = data.changed !== false;
  const appliedOps = Array.isArray(data.applied_ops) ? data.applied_ops : [];
  if (changed && !rejectedObjectIds.length && !appliedOps.length && data.applied_background == null) {
    throw new Error('Supabase v8 не вернул точный набор применённых операций');
  }
  return {
    revision: Number(data.revision ?? 0),
    needsSync: Boolean(data.needs_sync),
    updatedAt: data.updated_at ?? null,
    alreadyApplied: Boolean(data.already_applied),
    changed,
    appliedOps,
    appliedBackground: data.applied_background ?? null,
    rejectedObjectIds,
  };
}

async function rebuildLocalSnapshot(boardId, fallbackSnapshot, fallbackRevision = 0) {
  const cached = await getCachedSnapshot(boardId);
  let snapshot = cached?.snapshot ?? fallbackSnapshot ?? {
    version: 2,
    background: 'grid',
    canvas: { objects: [] },
  };
  let revision = Number(cached?.revision ?? fallbackRevision ?? 0);
  const confirmed = await getConfirmedActionsAfter(boardId, revision);
  snapshot = applyActionsToSnapshot(snapshot, confirmed);
  for (const action of confirmed) {
    revision = Math.max(revision, Number(action.revision ?? revision));
  }
  const pending = await getPendingActions(boardId);
  snapshot = applyActionsToSnapshot(snapshot, pending);
  return { snapshot, revision, pending };
}

function applyOpsToMutableSnapshot(snapshot, ops, background = null) {
  snapshot.version = 2;
  if (!snapshot.canvas || typeof snapshot.canvas !== 'object') snapshot.canvas = { objects: [] };
  if (!Array.isArray(snapshot.canvas.objects)) snapshot.canvas.objects = [];

  const objects = snapshot.canvas.objects;
  // ActiveSelection is only a temporary Fabric UI wrapper. Older experimental
  // releases could persist it as a board object, which may block or hang loading.
  for (let index = objects.length - 1; index >= 0; index -= 1) {
    if (isSerializedActiveSelection(objects[index])) objects.splice(index, 1);
  }
  const sourceOps = (Array.isArray(ops) ? ops : []).filter((op) => (
    op?.type !== 'upsert' || !isSerializedActiveSelection(op.object)
  ));
  const isExplicitReorder = (op) => (
    (op?.type === 'upsert' && op.object?.boardObjectId && Boolean(op.reorder || op.restore))
    || (op?.type === 'patch' && op.id && Boolean(op.reorder))
  );
  const orderedOps = [
    ...sourceOps.filter((op) => !isExplicitReorder(op)),
    ...sourceOps.filter(isExplicitReorder).sort((a, b) => (
      Number(a.zIndex ?? Number.MAX_SAFE_INTEGER) - Number(b.zIndex ?? Number.MAX_SAFE_INTEGER)
    )),
  ];
  const reorderIds = new Set(orderedOps.filter(isExplicitReorder)
    .map((op) => String(op.object?.boardObjectId ?? op.id)));
  const reorderSources = new Map(objects
    .filter((object) => reorderIds.has(String(object?.boardObjectId ?? '')))
    .map((object) => [String(object.boardObjectId), object]));
  if (reorderIds.size) {
    for (let index = objects.length - 1; index >= 0; index -= 1) {
      if (reorderIds.has(String(objects[index]?.boardObjectId ?? ''))) objects.splice(index, 1);
    }
  }
  // Transform batches may contain hundreds of selected objects. Resolve every stable
  // id once instead of repeating findIndex over the whole board for each tiny patch.
  const objectById = new Map([...objects, ...reorderSources.values()]
    .filter((object) => object?.boardObjectId)
    .map((object) => [String(object.boardObjectId), object]));

  for (const op of orderedOps) {
    if (op?.type === 'delete' && op.id) {
      const id = String(op.id);
      const existing = objectById.get(id);
      const index = existing ? objects.indexOf(existing) : -1;
      if (index >= 0) objects.splice(index, 1);
      objectById.delete(id);
      continue;
    }

    if (op?.type === 'patch' && op.id) {
      const id = String(op.id);
      const existing = objectById.get(id);
      const patched = applySerializedObjectPatch(existing, op);
      if (!existing || !patched) continue;
      const existingIndex = objects.indexOf(existing);
      if (existingIndex >= 0) objects[existingIndex] = patched;
      objectById.set(id, patched);
      if (op.reorder && Number.isInteger(op.zIndex)) {
        if (existingIndex >= 0) objects.splice(existingIndex, 1);
        const targetIndex = Math.max(0, Math.min(objects.length, op.zIndex));
        objects.splice(targetIndex, 0, patched);
      } else if (existingIndex < 0) {
        objects.push(patched);
      }
      continue;
    }

    // A transform operation deliberately contains only the small mutable placement
    // fields. The immutable path/image/text payload already lives in the snapshot or an
    // earlier upsert and must never be cloned or transmitted again for a simple move.
    if (op?.type === 'transform') {
      const patches = Array.isArray(op.objects)
        ? op.objects
        : (op.id ? [{
          id: op.id,
          transform: op.transform,
          updatedAt: op.updatedAt,
          updatedBy: op.updatedBy,
          zIndex: op.zIndex,
        }] : []);
      for (const patch of patches) {
        const id = String(patch?.id ?? '');
        if (!id || !patch?.transform || typeof patch.transform !== 'object') continue;
        const existing = objectById.get(id);
        if (!existing) continue;
        Object.assign(existing, patch.transform, {
          boardObjectId: id,
          updatedAt: Number(patch.updatedAt ?? existing.updatedAt ?? Date.now()),
          updatedBy: patch.updatedBy ?? existing.updatedBy ?? null,
        });
        // Moving/scaling/rotating does not normally change layer order. The optional
        // zIndex is accepted only when a caller explicitly marks this as a reorder.
        if (op.reorder && Number.isInteger(patch.zIndex)) {
          const existingIndex = objects.indexOf(existing);
          if (existingIndex >= 0) objects.splice(existingIndex, 1);
          const targetIndex = Math.max(0, Math.min(objects.length, patch.zIndex));
          objects.splice(targetIndex, 0, existing);
        }
      }
      continue;
    }

    if (op?.type !== 'upsert' || !op.object?.boardObjectId) continue;
    const objectId = String(op.object.boardObjectId);
    const previousObject = objectById.get(objectId);
    const existingIndex = previousObject ? objects.indexOf(previousObject) : -1;
    if (existingIndex >= 0) objects.splice(existingIndex, 1);
    const requestedIndex = op.preserveOrder && existingIndex >= 0
      ? existingIndex
      : (Number.isInteger(op.zIndex) ? op.zIndex : objects.length);
    const targetIndex = Math.max(0, Math.min(objects.length, requestedIndex));
    objects.splice(targetIndex, 0, op.object);
    objectById.set(objectId, op.object);
  }

  if (['grid', 'dots', 'blank'].includes(background)) snapshot.background = background;
  snapshot.savedAt = new Date().toISOString();
  return snapshot;
}

export function applyOpsToSnapshot(sourceSnapshot, ops, background = null) {
  const snapshot = cloneSnapshot(sourceSnapshot ?? {
    version: 2,
    background: 'grid',
    canvas: { objects: [] },
  });
  return applyOpsToMutableSnapshot(snapshot, ops, background);
}

export function applyActionsToSnapshot(sourceSnapshot, actions) {
  const snapshot = cloneSnapshot(sourceSnapshot ?? {
    version: 2,
    background: 'grid',
    canvas: { objects: [] },
  });
  for (const action of Array.isArray(actions) ? actions : []) {
    applyOpsToMutableSnapshot(snapshot, action?.ops ?? [], action?.background ?? null);
  }
  return snapshot;
}

function localPermission(board, keyHash) {
  if (!board) return null;
  if (keyHash === board.ownerKeyHash) return 'owner';
  if (keyHash === board.shareKeyHash) return board.guestMode;
  return null;
}

function incompatibleProtocolError(cause = null) {
  const error = new Error(
    'Сервер доски не поддерживает строгую синхронизацию v8. Сначала выполните supabase/authoritative_log_v8.sql.',
  );
  error.cause = cause;
  error.code = 'BOARD_PROTOCOL_V8_REQUIRED';
  return error;
}

export async function createBoard(title = 'Новая доска', studentName = '') {
  const boardId = randomToken(12);
  const ownerKey = randomToken(28);
  const shareKey = await deriveShareKey(ownerKey);
  const ownerKeyHash = await sha256(ownerKey);
  const shareKeyHash = await sha256(shareKey);
  const realtimeKey = randomToken(18);

  if (isSupabaseConfigured) {
    const { error } = await supabase.rpc('create_board', {
      p_id: boardId,
      p_title: title,
      p_owner_key_hash: ownerKeyHash,
      p_share_key_hash: shareKeyHash,
      p_realtime_key: realtimeKey,
    });
    if (error) throw error;
    if (studentName.trim()) {
      const { error: metadataError } = await supabase.rpc('set_board_metadata_v4', {
        p_id: boardId,
        p_owner_key_hash: ownerKeyHash,
        p_title: title,
        p_student_name: studentName,
      });
      if (metadataError && !isMissingFunctionError(metadataError)) {
        throw metadataError;
      }
    }
  } else {
    setLocalBoard(boardId, {
      id: boardId,
      title,
      studentName,
      ownerKeyHash,
      shareKeyHash,
      realtimeKey,
      guestMode: 'edit',
      gameLibraryVisible: false,
      snapshot: { version: 2, background: 'grid', canvas: { objects: [] } },
      snapshotRevision: 0,
      revision: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  return { boardId, ownerKey, shareKey };
}

export async function getBoardAccess(boardId, key) {
  const keyHash = await sha256(key);

  if (isSupabaseConfigured) {
    const { data, error } = await supabase.rpc('get_board_access_v8', {
      p_id: boardId,
      p_key_hash: keyHash,
    });
    if (error) {
      if (isMissingFunctionError(error)) throw incompatibleProtocolError(error);
      throw error;
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return null;
    return {
      permission: row.permission,
      title: row.title,
      studentName: row.student_name ?? '',
      guestMode: row.guest_mode,
      gameLibraryVisible: Boolean(row.game_library_visible),
      realtimeKey: row.realtime_key,
      snapshot: row.snapshot,
      revision: Number(row.revision ?? 0),
      snapshotRevision: Number(row.snapshot_revision ?? row.revision ?? 0),
      updatedAt: row.updated_at,
      createdAt: row.created_at ?? null,
      lastLessonAt: row.last_lesson_at ?? row.updated_at ?? null,
      protocolVersion: Number(row.protocol_version ?? 8),
      logFloorRevision: Number(row.log_floor_revision ?? row.revision ?? 0),
    };
  }

  const board = getLocalBoard(boardId);
  const permission = localPermission(board, keyHash);
  if (!permission) return null;
  const accessSnapshot = board.snapshot ?? EMPTY_SNAPSHOT;
  const accessSnapshotRevision = Number(board.snapshotRevision ?? board.revision ?? 0);
  if (!board.snapshotExternal) {
    await setCachedSnapshot(boardId, {
      snapshot: accessSnapshot,
      revision: accessSnapshotRevision,
      savedAt: Date.now(),
    });
    board.snapshot = EMPTY_SNAPSHOT;
    board.snapshotExternal = true;
    board.snapshotRevision = accessSnapshotRevision;
    setLocalBoard(boardId, board);
  }
  return {
    permission,
    title: board.title,
    studentName: board.studentName ?? '',
    guestMode: board.guestMode,
    gameLibraryVisible: Boolean(board.gameLibraryVisible),
    realtimeKey: board.realtimeKey,
    snapshot: accessSnapshot,
    revision: board.revision,
    snapshotRevision: accessSnapshotRevision,
    updatedAt: board.updatedAt,
    createdAt: board.createdAt ?? null,
    lastLessonAt: board.updatedAt,
  };
}

export async function getBoardRevision(boardId, key) {
  const keyHash = await sha256(key);

  if (isSupabaseConfigured) {
    const { data, error } = await supabase.rpc('get_board_revision_v8', {
      p_id: boardId,
      p_key_hash: keyHash,
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return null;
    return {
      revision: Number(row.revision ?? 0),
      updatedAt: row.updated_at ?? null,
      permission: row.permission ?? null,
      guestMode: row.guest_mode ?? null,
    };
  }

  const board = getLocalBoard(boardId);
  const permission = localPermission(board, keyHash);
  if (!permission) return null;
  return {
    revision: Number(board.revision ?? 0),
    updatedAt: board.updatedAt ?? null,
    permission,
    guestMode: board.guestMode,
  };
}

export async function getBoardChanges(boardId, key, sinceRevision, limit = 500) {
  if (!isSupabaseConfigured) return [];
  const keyHash = await sha256(key);
  const args = {
    p_id: boardId,
    p_key_hash: keyHash,
    p_since_revision: Number(sinceRevision ?? 0),
    p_limit: Math.max(1, Math.min(1000, Number(limit ?? 500))),
  };
  const { data, error } = await supabase.rpc('get_board_changes_v8', args);
  if (error) {
    if (isMissingFunctionError(error)) throw incompatibleProtocolError(error);
    throw error;
  }
  return (Array.isArray(data) ? data : []).map((row) => ({
    revision: Number(row.revision ?? 0),
    actionId: row.action_id,
    clientId: row.client_id,
    ops: Array.isArray(row.ops) ? row.ops : [],
    background: row.background ?? null,
    createdAt: row.created_at ?? null,
  }));
}

export async function getBoardRecovery(boardId, key) {
  if (!isSupabaseConfigured) return null;
  const keyHash = await sha256(key);
  const { data, error } = await supabase.rpc('get_board_recovery_v8', {
    p_id: boardId,
    p_key_hash: keyHash,
  });
  if (error) {
    if (isMissingFunctionError(error)) throw incompatibleProtocolError(error);
    throw error;
  }
  const result = Array.isArray(data) ? data[0] : data;
  if (!result) return null;
  const actions = Array.isArray(result.actions) ? result.actions : [];
  const snapshot = applyActionsToSnapshot(result.snapshot, actions);
  return {
    snapshot,
    revision: Number(result.current_revision ?? result.snapshot_revision ?? 0),
  };
}

export async function setGuestMode(boardId, ownerKey, guestMode) {
  const ownerKeyHash = await sha256(ownerKey);

  if (isSupabaseConfigured) {
    const { data, error } = await supabase.rpc('set_board_guest_mode', {
      p_id: boardId,
      p_owner_key_hash: ownerKeyHash,
      p_guest_mode: guestMode,
    });
    if (error) throw error;
    if (!data) throw new Error('Нет прав на изменение режима ссылки');
    return;
  }

  const board = getLocalBoard(boardId);
  if (!board || board.ownerKeyHash !== ownerKeyHash) {
    throw new Error('Нет прав на изменение режима ссылки');
  }
  board.guestMode = guestMode;
  board.updatedAt = new Date().toISOString();
  setLocalBoard(boardId, board);
}


export async function setGameLibraryVisibility(boardId, ownerKey, visible) {
  const ownerKeyHash = await sha256(ownerKey);
  const nextVisible = Boolean(visible);

  if (isSupabaseConfigured) {
    const { data, error } = await supabase.rpc('set_game_library_visibility_v5', {
      p_id: boardId,
      p_owner_key_hash: ownerKeyHash,
      p_visible: nextVisible,
    });
    if (error) {
      if (isMissingFunctionError(error)) {
        throw new Error('Сначала запустите supabase/game_library_visibility_upgrade_0.8.1.sql');
      }
      throw error;
    }
    if (!data) throw new Error('Только владелец доски может открыть игротеку');
    return nextVisible;
  }

  const board = getLocalBoard(boardId);
  if (!board || board.ownerKeyHash !== ownerKeyHash) {
    throw new Error('Только владелец доски может открыть игротеку');
  }
  board.gameLibraryVisible = nextVisible;
  board.updatedAt = new Date().toISOString();
  setLocalBoard(boardId, board);
  return nextVisible;
}

export async function setBoardMetadata(boardId, ownerKey, { title, studentName }) {
  const ownerKeyHash = await sha256(ownerKey);
  if (isSupabaseConfigured) {
    const { data, error } = await supabase.rpc('set_board_metadata_v4', {
      p_id: boardId,
      p_owner_key_hash: ownerKeyHash,
      p_title: title ?? null,
      p_student_name: studentName ?? null,
    });
    if (error) throw error;
    if (!data) throw new Error('Нет прав на изменение доски');
    return;
  }
  const board = getLocalBoard(boardId);
  if (!board || board.ownerKeyHash !== ownerKeyHash) throw new Error('Нет прав на изменение доски');
  if (typeof title === 'string' && title.trim()) board.title = title.trim();
  if (typeof studentName === 'string') board.studentName = studentName.trim();
  board.updatedAt = new Date().toISOString();
  setLocalBoard(boardId, board);
}

export async function deleteBoard(boardId, ownerKey) {
  const ownerKeyHash = await sha256(ownerKey);
  if (isSupabaseConfigured) {
    const { data, error } = await supabase.rpc('delete_board_v4', {
      p_id: boardId,
      p_owner_key_hash: ownerKeyHash,
    });
    if (error) throw error;
    if (!data) throw new Error('Не удалось удалить доску');
    await clearBoardCache(boardId);
    return;
  }
  const board = getLocalBoard(boardId);
  if (!board || board.ownerKeyHash !== ownerKeyHash) throw new Error('Нет прав на удаление');
  deleteLocalBoard(boardId);
  await clearBoardCache(boardId);
}

export async function duplicateBoard(boardId, ownerKey, title = null) {
  const sourceOwnerHash = await sha256(ownerKey);
  const newBoardId = randomToken(12);
  const newOwnerKey = randomToken(28);
  const newShareKey = await deriveShareKey(newOwnerKey);
  const newOwnerHash = await sha256(newOwnerKey);
  const newShareHash = await sha256(newShareKey);
  const newRealtimeKey = randomToken(18);

  if (isSupabaseConfigured) {
    // A board copy must include every locally completed action. Pending operations are
    // idempotently committed first; only then is the server snapshot duplicated.
    const pending = await getPendingActions(boardId);
    let knownRevision = Number((await getBoardRevision(boardId, ownerKey))?.revision ?? 0);
    for (let offset = 0; offset < pending.length; offset += 32) {
      const actions = pending.slice(offset, offset + 32);
      // eslint-disable-next-line no-await-in-loop
      const results = await applyBoardActionBatch(boardId, ownerKey, actions, knownRevision);
      if (results.some((result) => Array.isArray(result?.rejectedObjectIds) && result.rejectedObjectIds.length)) {
        throw new Error('Одно из ожидающих действий конфликтует с сервером. Откройте доску и дождитесь восстановления.');
      }
      // eslint-disable-next-line no-await-in-loop
      await confirmPendingActions(actions.map((action, index) => ({ action, result: results[index] })));
      knownRevision = Math.max(knownRevision, ...results.map((result) => Number(result?.revision ?? 0)));
    }

    const sourceAccess = await getBoardRecovery(boardId, ownerKey);
    if (!sourceAccess?.snapshot) throw new Error('Не удалось получить актуальный урок для копирования');

    // Copy image assets before creating the board. The exact recovered v8 state is then
    // installed as the new board's authoritative snapshot in one operation.
    const copiedSnapshot = await copySerializedBoardImages(sourceAccess.snapshot, newBoardId);

    const duplicateArgs = {
      p_source_id: boardId,
      p_source_owner_key_hash: sourceOwnerHash,
      p_new_id: newBoardId,
      p_new_title: title,
      p_new_owner_key_hash: newOwnerHash,
      p_new_share_key_hash: newShareHash,
      p_new_realtime_key: newRealtimeKey,
    };
    const { data, error } = await supabase.rpc('duplicate_board_v7', duplicateArgs);
    if (error) throw error;
    if (!data) throw new Error('Не удалось скопировать доску');

    try {
      const duplicateAccess = await getBoardAccess(newBoardId, newOwnerKey);
      if (!duplicateAccess) throw new Error('Не удалось открыть созданную копию');
      await saveBoardSnapshot(
        newBoardId,
        newOwnerKey,
        copiedSnapshot,
        Number(duplicateAccess.revision ?? 0),
      );
    } catch (snapshotError) {
      await supabase.rpc('delete_board_v4', {
        p_id: newBoardId,
        p_owner_key_hash: newOwnerHash,
      }).catch?.(() => undefined);
      throw snapshotError;
    }
  } else {
    const source = getLocalBoard(boardId);
    if (!source || source.ownerKeyHash !== sourceOwnerHash) throw new Error('Нет прав на копирование');
    const rebuilt = await rebuildLocalSnapshot(
      boardId,
      source.snapshot,
      Number(source.snapshotRevision ?? source.revision ?? 0),
    );
    await setCachedSnapshot(newBoardId, {
      snapshot: rebuilt.snapshot,
      revision: 0,
      savedAt: Date.now(),
    });
    setLocalBoard(newBoardId, {
      ...source,
      id: newBoardId,
      title: title?.trim() || `${source.title} — копия`,
      ownerKeyHash: newOwnerHash,
      shareKeyHash: newShareHash,
      realtimeKey: newRealtimeKey,
      gameLibraryVisible: false,
      snapshot: EMPTY_SNAPSHOT,
      snapshotExternal: true,
      snapshotRevision: 0,
      revision: 0,
      appliedActions: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  return { boardId: newBoardId, ownerKey: newOwnerKey, shareKey: newShareKey };
}

export async function applyBoardActionBatch(boardId, key, actions, knownRevision = 0) {
  const safeActions = (Array.isArray(actions) ? actions : [])
    .filter((action) => action?.actionId)
    .map((action) => ({
      actionId: action.actionId,
      clientId: action.clientId ?? '',
      ops: Array.isArray(action.ops) ? action.ops : [],
      background: action.background ?? null,
      serializedSize: Number.isFinite(Number(action.serializedSize))
        ? Number(action.serializedSize)
        : null,
      atomic: Boolean(action.atomic),
    }));
  if (!safeActions.length) return [];
  if (safeActions.length === 1 || safeActions.some((action) => (
    Number.isFinite(Number(action.serializedSize))
      ? Number(action.serializedSize) > BULK_ACTION_THRESHOLD
      : serializedSize(action.ops) > BULK_ACTION_THRESHOLD
  ))) {
    const results = [];
    let revision = Number(knownRevision ?? 0);
    for (const action of safeActions) {
      // Large logical actions remain individually atomic and use the staged-import path.
      // eslint-disable-next-line no-await-in-loop
      const result = await applyBoardAction(boardId, key, { ...action, knownRevision: revision });
      results.push({ actionId: action.actionId, ...result });
      revision = Math.max(revision, Number(result?.revision ?? revision));
    }
    return results;
  }

  if (isSupabaseConfigured) {
    const keyHash = await sha256(key);
    const { data, error } = await supabase.rpc('apply_board_actions_batch_v8', {
      p_id: boardId,
      p_key_hash: keyHash,
      p_actions: safeActions.map((action) => ({
        action_id: action.actionId,
        client_id: action.clientId,
        ops: action.ops,
        background: action.background,
      })),
      p_client_revision: Number(knownRevision ?? 0),
    });
    if (error) {
      if (isMissingFunctionError(error)) throw incompatibleProtocolError(error);
      throw error;
    }
    return (Array.isArray(data) ? data : []).map((item, index) => ({
      actionId: item?.action_id ?? safeActions[index]?.actionId,
      ...normalizeActionResult(item),
    }));
  }

  const results = [];
  let revision = Number(knownRevision ?? 0);
  for (const action of safeActions) {
    // eslint-disable-next-line no-await-in-loop
    const result = await applyBoardAction(boardId, key, { ...action, knownRevision: revision });
    results.push({ actionId: action.actionId, ...result });
    revision = Math.max(revision, Number(result?.revision ?? revision));
  }
  return results;
}

export async function applyBoardAction(
  boardId,
  key,
  {
    actionId,
    clientId,
    ops = [],
    background = null,
    knownRevision = 0,
    serializedSize: providedSerializedSize = null,
  },
) {
  const keyHash = await sha256(key);

  if (isSupabaseConfigured) {
    const safeOps = Array.isArray(ops) ? ops : [];
    let data;
    let error;

    const safeOpsSerializedSize = Number.isFinite(Number(providedSerializedSize))
      ? Number(providedSerializedSize)
      : serializedSize(safeOps);
    if (safeOpsSerializedSize > BULK_ACTION_THRESHOLD) {
      data = await applyLargeBoardAction(boardId, keyHash, {
        actionId,
        clientId,
        ops: safeOps,
        background,
        knownRevision,
      });
    } else {
      ({ data, error } = await applyStandardActionRpc(boardId, keyHash, {
        actionId,
        clientId,
        ops: safeOps,
        background,
        knownRevision,
      }));
      if (error) {
        if (isMissingFunctionError(error)) throw incompatibleProtocolError(error);
        throw error;
      }
    }

    return normalizeActionResult(data);
  }

  const board = getLocalBoard(boardId);
  const permission = localPermission(board, keyHash);
  if (!(permission === 'owner' || permission === 'edit')) throw new Error('Доска открыта только для просмотра');
  board.appliedActions ??= {};
  if (board.appliedActions[actionId]) {
    return { revision: board.appliedActions[actionId], needsSync: false, alreadyApplied: true, changed: false };
  }
  const serverRevisionBefore = Number(board.revision ?? 0);
  if (board.snapshotRevision == null) board.snapshotRevision = serverRevisionBefore;
  if (!board.snapshotExternal) {
    await setCachedSnapshot(boardId, {
      snapshot: board.snapshot ?? EMPTY_SNAPSHOT,
      revision: Number(board.snapshotRevision ?? serverRevisionBefore),
      savedAt: Date.now(),
    });
    board.snapshot = EMPTY_SNAPSHOT;
    board.snapshotExternal = true;
  }
  const changed = (Array.isArray(ops) && ops.length > 0)
    || ['grid', 'dots', 'blank'].includes(background);
  board.revision = changed ? serverRevisionBefore + 1 : serverRevisionBefore;
  board.updatedAt = new Date().toISOString();
  board.appliedActions[actionId] = board.revision;
  const ids = Object.keys(board.appliedActions);
  if (ids.length > 500) ids.slice(0, ids.length - 500).forEach((id) => delete board.appliedActions[id]);
  setLocalBoard(boardId, board);
  return {
    revision: board.revision,
    needsSync: serverRevisionBefore > Number(knownRevision ?? 0),
    updatedAt: board.updatedAt,
    alreadyApplied: false,
    changed,
    appliedOps: changed && Array.isArray(ops) ? ops : [],
    appliedBackground: background,
    rejectedObjectIds: [],
  };
}

export async function saveBoardSnapshot(boardId, key, snapshot, revision) {
  const keyHash = await sha256(key);

  if (isSupabaseConfigured) {
    const { data, error } = await supabase.rpc('save_board_snapshot_v8', {
      p_id: boardId,
      p_key_hash: keyHash,
      p_snapshot: snapshot,
      p_client_revision: revision,
    });
    if (error) throw error;
    if (data === null || data === false) throw new Error('Сервер отклонил сохранение');
    return Number(data);
  }

  const board = getLocalBoard(boardId);
  const permission = localPermission(board, keyHash);
  if (!(permission === 'owner' || permission === 'edit')) throw new Error('Доска открыта только для просмотра');
  board.revision = Math.max(Number(board.revision ?? 0) + 1, Number(revision ?? 0));
  board.snapshotRevision = board.revision;
  await setCachedSnapshot(boardId, {
    snapshot,
    revision: board.snapshotRevision,
    savedAt: Date.now(),
  });
  board.snapshot = EMPTY_SNAPSHOT;
  board.snapshotExternal = true;
  board.updatedAt = new Date().toISOString();
  setLocalBoard(boardId, board);
  return board.revision;
}

export { isSupabaseConfigured };
