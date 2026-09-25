import { applyAuthorityOpsInPlace } from './authoritySnapshot.js';
import { validIntegrityIds } from './boardIntegrityData.js';

const replicas = new Map();
const MAX_REPLICA_COMMITS = 512;
const EMPTY_SNAPSHOT = { version: 2, background: 'grid', canvas: { objects: [] } };

function cloneValue(value) {
  if (value == null || typeof value !== 'object') return value;
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function safeRevision(value) {
  const revision = Number(value ?? 0);
  return Number.isInteger(revision) && revision >= 0 ? revision : 0;
}

function boardKey(boardId) {
  return String(boardId ?? '').trim();
}

function emptyState() {
  return {
    snapshot: cloneValue(EMPTY_SNAPSHOT),
    revision: 0,
    commits: [],
    updatedAt: Date.now(),
  };
}

function ensureState(boardId) {
  const key = boardKey(boardId);
  if (!key) throw new Error('boardId is required');
  let state = replicas.get(key);
  if (!state) {
    state = emptyState();
    replicas.set(key, state);
  }
  return state;
}

export function installReplicaSnapshot(boardId, snapshot, revision = 0) {
  const key = boardKey(boardId);
  if (!key) throw new Error('boardId is required');
  const next = {
    snapshot: cloneValue(snapshot ?? EMPTY_SNAPSHOT),
    revision: safeRevision(revision),
    commits: [],
    updatedAt: Date.now(),
  };
  replicas.set(key, next);
  return getReplicaState(key);
}

export function applyReplicaCommit(boardId, commit) {
  const state = ensureState(boardId);
  const incomingRevision = safeRevision(commit?.revision);
  if (incomingRevision <= state.revision) {
    return { applied: false, duplicate: true, needsSnapshot: false, revision: state.revision };
  }
  if (incomingRevision !== state.revision + 1) {
    return { applied: false, duplicate: false, needsSnapshot: true, revision: state.revision };
  }

  applyAuthorityOpsInPlace(
    state.snapshot,
    Array.isArray(commit?.ops) ? commit.ops : [],
    commit?.background ?? null,
  );
  state.revision = incomingRevision;
  state.commits.push(cloneValue(commit));
  if (state.commits.length > MAX_REPLICA_COMMITS) {
    state.commits.splice(0, state.commits.length - MAX_REPLICA_COMMITS);
  }
  state.updatedAt = Date.now();
  return { applied: true, duplicate: false, needsSnapshot: false, revision: state.revision };
}

export function getReplicaRevision(boardId) {
  const key = boardKey(boardId);
  if (!key) return 0;
  return safeRevision(replicas.get(key)?.revision);
}

export function getReplicaState(boardId) {
  const key = boardKey(boardId);
  if (!key) return null;
  const state = replicas.get(key);
  if (!state) return null;
  return {
    snapshot: cloneValue(state.snapshot),
    revision: state.revision,
    updatedAt: state.updatedAt,
  };
}

export function getReplicaChangesAfter(boardId, revision = 0, limit = 500) {
  const key = boardKey(boardId);
  const state = replicas.get(key);
  if (!state) return [];
  const floor = safeRevision(revision);
  const safeLimit = Math.max(1, Math.min(1000, Number(limit ?? 500) || 500));
  return state.commits
    .filter((commit) => safeRevision(commit?.revision) > floor)
    .slice(0, safeLimit)
    .map(cloneValue);
}

export function clearReplicaState(boardId) {
  const key = boardKey(boardId);
  if (!key) return false;
  return replicas.delete(key);
}

// Internal audit-only access. Callers must not mutate this view or use it for writes.
export function getReplicaIntegritySource(boardId) {
  const key = boardKey(boardId);
  const state = replicas.get(key);
  return state ? { boardId: key, revision: state.revision, snapshot: state.snapshot } : null;
}

export function repairReplicaIntegrityRecords(boardId, expectedRevision, records, background = null) {
  const state = replicas.get(boardKey(boardId));
  if (!state || state.revision !== expectedRevision || !Array.isArray(records)) return false;
  const ids = records.map((record) => record?.id);
  if (!validIntegrityIds(ids) || records.some((record) => (
    record.count !== 0 && record.count !== 1
  ) || (record.count === 0 ? record.object !== null : (
    String(record.object?.boardObjectId ?? '') !== record.id
    || !Number.isInteger(record.zIndex) || record.zIndex < 0
  )))) return false;
  const targetIds = new Set(ids);
  const objects = state.snapshot.canvas.objects.filter((object) => !targetIds.has(String(object?.boardObjectId ?? '')));
  for (const record of records.filter((entry) => entry.count === 1).sort((a, b) => a.zIndex - b.zIndex)) {
    objects.splice(Math.min(record.zIndex, objects.length), 0, cloneValue(record.object));
  }
  state.snapshot.canvas.objects = objects;
  if (['grid', 'dots', 'blank'].includes(background)) state.snapshot.background = background;
  // This repairs a replica at the same committed revision, not a new user action.
  // Do not append history, change authority or advance the revision.
  return true;
}
