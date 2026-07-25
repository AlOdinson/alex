import { deriveShareKey, randomToken, sha256 } from './ids.js';
import { isSupabaseConfigured, supabase } from './supabase.js';

const LOCAL_PREFIX = 'alex-board:board:';

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

export function applyOpsToSnapshot(sourceSnapshot, ops, background = null) {
  const snapshot = cloneSnapshot(sourceSnapshot ?? {
    version: 2,
    background: 'grid',
    canvas: { objects: [] },
  });
  snapshot.version = 2;
  if (!snapshot.canvas || typeof snapshot.canvas !== 'object') snapshot.canvas = { objects: [] };
  if (!Array.isArray(snapshot.canvas.objects)) snapshot.canvas.objects = [];

  const objects = snapshot.canvas.objects;
  for (const op of Array.isArray(ops) ? ops : []) {
    if (op?.type === 'delete' && op.id) {
      const index = objects.findIndex((object) => object?.boardObjectId === op.id);
      if (index >= 0) objects.splice(index, 1);
      continue;
    }
    if (op?.type !== 'upsert' || !op.object?.boardObjectId) continue;
    const existingIndex = objects.findIndex(
      (object) => object?.boardObjectId === op.object.boardObjectId,
    );
    if (existingIndex >= 0) objects.splice(existingIndex, 1);
    const requestedIndex = Number.isInteger(op.zIndex) ? op.zIndex : objects.length;
    const targetIndex = Math.max(0, Math.min(objects.length, requestedIndex));
    objects.splice(targetIndex, 0, op.object);
  }

  if (['grid', 'dots', 'blank'].includes(background)) snapshot.background = background;
  snapshot.savedAt = new Date().toISOString();
  return snapshot;
}

function localPermission(board, keyHash) {
  if (!board) return null;
  if (keyHash === board.ownerKeyHash) return 'owner';
  if (keyHash === board.shareKeyHash) return board.guestMode;
  return null;
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
      if (metadataError && !/function .* does not exist/i.test(metadataError.message ?? '')) {
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
      snapshot: { version: 2, background: 'grid', canvas: { objects: [] } },
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
    let data;
    let error;
    ({ data, error } = await supabase.rpc('get_board_access_v4', {
      p_id: boardId,
      p_key_hash: keyHash,
    }));
    if (error && /function .* does not exist/i.test(error.message ?? '')) {
      ({ data, error } = await supabase.rpc('get_board_access', {
        p_id: boardId,
        p_key_hash: keyHash,
      }));
    }
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return null;
    return {
      permission: row.permission,
      title: row.title,
      studentName: row.student_name ?? '',
      guestMode: row.guest_mode,
      realtimeKey: row.realtime_key,
      snapshot: row.snapshot,
      revision: Number(row.revision ?? 0),
      updatedAt: row.updated_at,
      createdAt: row.created_at ?? null,
      lastLessonAt: row.last_lesson_at ?? row.updated_at ?? null,
    };
  }

  const board = getLocalBoard(boardId);
  const permission = localPermission(board, keyHash);
  if (!permission) return null;
  return {
    permission,
    title: board.title,
    studentName: board.studentName ?? '',
    guestMode: board.guestMode,
    realtimeKey: board.realtimeKey,
    snapshot: board.snapshot,
    revision: board.revision,
    updatedAt: board.updatedAt,
    createdAt: board.createdAt ?? null,
    lastLessonAt: board.updatedAt,
  };
}

export async function getBoardSyncState(boardId, key) {
  const keyHash = await sha256(key);
  if (isSupabaseConfigured) {
    const { data, error } = await supabase.rpc('get_board_sync_state_v4', {
      p_id: boardId,
      p_key_hash: keyHash,
    });
    if (error) {
      if (/function .* does not exist/i.test(error.message ?? '')) {
        const fallback = await getBoardRevision(boardId, key);
        return fallback ? { ...fallback, objectCount: null, stateHash: null } : null;
      }
      throw error;
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return null;
    return {
      revision: Number(row.revision ?? 0),
      objectCount: Number(row.object_count ?? 0),
      stateHash: row.state_hash ?? null,
      updatedAt: row.updated_at ?? null,
      permission: row.permission ?? null,
      guestMode: row.guest_mode ?? null,
    };
  }

  const access = await getBoardAccess(boardId, key);
  if (!access) return null;
  return {
    revision: Number(access.revision ?? 0),
    objectCount: access.snapshot?.canvas?.objects?.length ?? 0,
    stateHash: null,
    updatedAt: access.updatedAt,
    permission: access.permission,
    guestMode: access.guestMode,
  };
}

export async function getBoardRevision(boardId, key) {
  const keyHash = await sha256(key);

  if (isSupabaseConfigured) {
    const { data, error } = await supabase.rpc('get_board_revision', {
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
  const { data, error } = await supabase.rpc('get_board_changes_v4', {
    p_id: boardId,
    p_key_hash: keyHash,
    p_since_revision: Number(sinceRevision ?? 0),
    p_limit: Math.max(1, Math.min(1000, Number(limit ?? 500))),
  });
  if (error) {
    if (/function .* does not exist/i.test(error.message ?? '')) return null;
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
  const { data, error } = await supabase.rpc('get_board_recovery_v4', {
    p_id: boardId,
    p_key_hash: keyHash,
  });
  if (error) {
    if (/function .* does not exist/i.test(error.message ?? '')) return null;
    throw error;
  }
  const result = Array.isArray(data) ? data[0] : data;
  if (!result) return null;
  const actions = Array.isArray(result.actions) ? result.actions : [];
  let snapshot = result.snapshot;
  for (const action of actions) {
    snapshot = applyOpsToSnapshot(snapshot, action.ops ?? [], action.background ?? null);
  }
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
    return;
  }
  const board = getLocalBoard(boardId);
  if (!board || board.ownerKeyHash !== ownerKeyHash) throw new Error('Нет прав на удаление');
  deleteLocalBoard(boardId);
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
    const { data, error } = await supabase.rpc('duplicate_board_v4', {
      p_source_id: boardId,
      p_source_owner_key_hash: sourceOwnerHash,
      p_new_id: newBoardId,
      p_new_title: title,
      p_new_owner_key_hash: newOwnerHash,
      p_new_share_key_hash: newShareHash,
      p_new_realtime_key: newRealtimeKey,
    });
    if (error) throw error;
    if (!data) throw new Error('Не удалось скопировать доску');
  } else {
    const source = getLocalBoard(boardId);
    if (!source || source.ownerKeyHash !== sourceOwnerHash) throw new Error('Нет прав на копирование');
    setLocalBoard(newBoardId, {
      ...cloneSnapshot(source),
      id: newBoardId,
      title: title?.trim() || `${source.title} — копия`,
      ownerKeyHash: newOwnerHash,
      shareKeyHash: newShareHash,
      realtimeKey: newRealtimeKey,
      revision: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  return { boardId: newBoardId, ownerKey: newOwnerKey, shareKey: newShareKey };
}

export async function applyBoardAction(
  boardId,
  key,
  { actionId, clientId, ops = [], background = null, knownRevision = 0 },
) {
  const keyHash = await sha256(key);

  if (isSupabaseConfigured) {
    const { data, error } = await supabase.rpc('apply_board_action_v4', {
      p_id: boardId,
      p_key_hash: keyHash,
      p_action_id: actionId,
      p_client_id: clientId,
      p_ops: Array.isArray(ops) ? ops : [],
      p_background: background,
      p_client_revision: Number(knownRevision ?? 0),
    });
    if (error) {
      if (/function .* does not exist/i.test(error.message ?? '')) {
        return applyBoardOps(boardId, key, ops, { background, knownRevision });
      }
      throw error;
    }
    if (!data) throw new Error('Сервер отклонил изменение доски');
    return {
      revision: Number(data.revision ?? 0),
      needsSync: Boolean(data.needs_sync),
      updatedAt: data.updated_at ?? null,
      alreadyApplied: Boolean(data.already_applied),
      changed: data.changed !== false,
    };
  }

  const board = getLocalBoard(boardId);
  const permission = localPermission(board, keyHash);
  if (!(permission === 'owner' || permission === 'edit')) throw new Error('Доска открыта только для просмотра');
  board.appliedActions ??= {};
  if (board.appliedActions[actionId]) {
    return { revision: board.appliedActions[actionId], needsSync: false, alreadyApplied: true, changed: false };
  }
  const serverRevisionBefore = Number(board.revision ?? 0);
  board.snapshot = applyOpsToSnapshot(board.snapshot, ops, background);
  board.revision = serverRevisionBefore + 1;
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
    changed: true,
  };
}

/** Compatibility wrapper for older server deployments. */
export async function applyBoardOps(
  boardId,
  key,
  ops,
  { background = null, knownRevision = 0 } = {},
) {
  const keyHash = await sha256(key);

  if (isSupabaseConfigured) {
    const { data, error } = await supabase.rpc('apply_board_ops', {
      p_id: boardId,
      p_key_hash: keyHash,
      p_ops: Array.isArray(ops) ? ops : [],
      p_background: background,
      p_client_revision: Number(knownRevision ?? 0),
    });
    if (error) throw error;
    if (!data) throw new Error('Сервер отклонил изменение доски');
    return {
      revision: Number(data.revision ?? 0),
      needsSync: Boolean(data.needs_sync),
      updatedAt: data.updated_at ?? null,
    };
  }

  return applyBoardAction(boardId, key, {
    actionId: randomToken(18),
    clientId: 'local',
    ops,
    background,
    knownRevision,
  });
}

export async function saveBoardSnapshot(boardId, key, snapshot, revision) {
  const keyHash = await sha256(key);

  if (isSupabaseConfigured) {
    const { data, error } = await supabase.rpc('save_board_snapshot', {
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
  board.snapshot = snapshot;
  board.revision = Math.max(Number(board.revision ?? 0) + 1, Number(revision ?? 0));
  board.updatedAt = new Date().toISOString();
  setLocalBoard(boardId, board);
  return board.revision;
}

export { isSupabaseConfigured };
