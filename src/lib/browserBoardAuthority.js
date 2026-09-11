import { createTeacherAuthority } from './teacherAuthority.js';
import { applyAuthorityActions, applyAuthorityOpsInPlace } from './authoritySnapshot.js';
import { evaluateAuthorityAction } from './authorityOperationEvaluator.js';
import {
  getAuthorityActionOutcome,
  getAuthorityBoard,
  getAuthorityCommitsAfter,
  persistAuthorityCommit,
  persistAuthorityNoopOutcome,
  saveAuthoritySnapshot,
} from './browserAuthorityStore.js';

function cloneValue(value) {
  if (value == null || typeof value !== 'object') return value;
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function safeRevision(value) {
  const revision = Number(value ?? 0);
  return Number.isInteger(revision) && revision >= 0 ? revision : 0;
}

function normalizePriorOutcome(outcome) {
  if (!outcome || typeof outcome !== 'object') return null;
  const changed = outcome.changed !== false;
  return {
    ...cloneValue(outcome),
    revision: safeRevision(outcome.revision),
    duplicate: true,
    changed,
    appliedOps: cloneValue(outcome.appliedOps ?? outcome.ops ?? []),
    appliedBackground: outcome.appliedBackground ?? outcome.background ?? null,
    skippedConflicts: cloneValue(outcome.skippedConflicts ?? []),
  };
}

function updateTombstones(source, commit) {
  const tombstones = cloneValue(source ?? {});
  const clientId = String(commit?.clientId ?? '');
  const actionId = String(commit?.actionId ?? '');
  const revision = safeRevision(commit?.revision);
  for (const operation of Array.isArray(commit?.ops) ? commit.ops : []) {
    if (operation?.type === 'delete' && operation.id) {
      tombstones[String(operation.id)] = {
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

async function loadContiguousJournal({ boardId, fromRevision, toRevision, loadCommitsAfter }) {
  const commits = [];
  let cursor = safeRevision(fromRevision);
  const head = safeRevision(toRevision);

  while (cursor < head) {
    // eslint-disable-next-line no-await-in-loop
    const batch = await loadCommitsAfter(boardId, cursor, 1000);
    const relevant = (Array.isArray(batch) ? batch : [])
      .filter((commit) => safeRevision(commit?.revision) <= head);
    if (!relevant.length) {
      throw new Error(`Authority journal gap after revision ${cursor}`);
    }
    for (const commit of relevant) {
      const revision = safeRevision(commit?.revision);
      if (revision !== cursor + 1) {
        throw new Error(`Authority journal gap: expected ${cursor + 1}, received ${revision}`);
      }
      commits.push(commit);
      cursor = revision;
      if (cursor === head) break;
    }
  }

  return commits;
}

export async function openBrowserBoardAuthority({
  boardId,
  loadBoard = getAuthorityBoard,
  loadCommitsAfter = getAuthorityCommitsAfter,
  persistCommit = persistAuthorityCommit,
  saveSnapshot = saveAuthoritySnapshot,
  loadActionOutcome = getAuthorityActionOutcome,
  persistNoopOutcome = persistAuthorityNoopOutcome,
} = {}) {
  const safeBoardId = String(boardId ?? '').trim();
  if (!safeBoardId) throw new Error('boardId is required');

  const board = await loadBoard(safeBoardId);
  if (!board) throw new Error('Authority board not found');

  const headRevision = safeRevision(board.revision);
  const snapshotRevision = safeRevision(board.snapshotRevision);
  if (snapshotRevision > headRevision) {
    throw new Error('Authority snapshot is newer than the journal head');
  }

  const replay = await loadContiguousJournal({
    boardId: safeBoardId,
    fromRevision: snapshotRevision,
    toRevision: headRevision,
    loadCommitsAfter,
  });
  const currentSnapshot = applyAuthorityActions(board.snapshot, replay);
  let currentTombstones = cloneValue(board.tombstones ?? {});

  const authority = createTeacherAuthority({
    initialRevision: headRevision,
    persistCommit: async (attemptedCommit) => {
      const persisted = await persistCommit(safeBoardId, attemptedCommit);
      if (persisted?.duplicate) return persisted;
      const durableCommit = persisted?.commit ?? attemptedCommit;
      applyAuthorityOpsInPlace(
        currentSnapshot,
        durableCommit?.ops ?? [],
        durableCommit?.background ?? null,
      );
      currentTombstones = updateTombstones(currentTombstones, durableCommit);
      return persisted ?? { commit: durableCommit, duplicate: false };
    },
  });

  let commitQueue = Promise.resolve();

  const commitOne = async (actionInput) => {
    const action = actionInput && typeof actionInput === 'object' ? actionInput : {};
    const actionId = String(action.actionId ?? '').trim();
    if (!actionId) throw new Error('actionId is required');

    const prior = await loadActionOutcome(safeBoardId, actionId);
    if (prior) return normalizePriorOutcome(prior);

    const evaluation = evaluateAuthorityAction({
      snapshot: currentSnapshot,
      tombstones: currentTombstones,
      ops: action.ops,
      background: action.background,
    });

    if (!evaluation.changed) {
      const currentRevision = authority.getRevision();
      const noop = {
        actionId,
        clientId: String(action.clientId ?? ''),
        baseRevision: safeRevision(action.baseRevision),
        revision: currentRevision,
        needsSync: currentRevision > safeRevision(action.baseRevision),
        committedAt: Date.now(),
        duplicate: false,
        changed: false,
        ops: [],
        background: null,
        appliedOps: [],
        appliedBackground: null,
        skippedConflicts: cloneValue(evaluation.skippedConflicts),
      };
      const persisted = await persistNoopOutcome(safeBoardId, noop);
      if (persisted?.duplicate) return normalizePriorOutcome(persisted.result);
      return noop;
    }

    const commit = await authority.commitAction({
      ...action,
      ops: evaluation.appliedOps,
      background: evaluation.appliedBackground,
      skippedConflicts: evaluation.skippedConflicts,
    });

    return {
      ...cloneValue(commit),
      changed: true,
      appliedOps: cloneValue(commit.ops ?? evaluation.appliedOps),
      appliedBackground: commit.background ?? evaluation.appliedBackground ?? null,
      skippedConflicts: cloneValue(commit.skippedConflicts ?? evaluation.skippedConflicts),
    };
  };

  return {
    boardId: safeBoardId,
    getRevision() {
      return authority.getRevision();
    },
    getSnapshot() {
      return cloneValue(currentSnapshot);
    },
    getTombstones() {
      return cloneValue(currentTombstones);
    },
    commitAction(action) {
      const task = commitQueue.then(() => commitOne(action));
      commitQueue = task.catch(() => undefined);
      return task;
    },
    getCommitsAfter(revision, limit = 500) {
      return loadCommitsAfter(safeBoardId, safeRevision(revision), limit);
    },
    async compactSnapshot() {
      const revision = authority.getRevision();
      await saveSnapshot(safeBoardId, cloneValue(currentSnapshot), revision);
      return revision;
    },
  };
}