import { createBoardTombstoneIndex, applyBoardTombstoneOperations } from './boardTombstoneIndex.js';
import { createIndexedBoardModel } from './indexedBoardModel.js';
import { prepareIndexedNotebookAction, applyIndexedNotebookOps } from './notebookIndexedTransaction.js';
import { assertNotebookCommitReadable } from './notebookProtocol.js';
import { updateNotebookTombstones } from './notebookOperations.js';
import { createVerificationView, isBoundedVerificationBoard } from './boundedVerificationState.js';
import { createVerificationWorkLane } from './boundedVerificationProtocol.js';
import { isConditionalHistoryOperation, prepareAuthoritativeHistory } from './historyOperations.js';
import { createTeacherAuthority } from './teacherAuthority.js';
import { applyAuthorityActions, applyAuthorityOpsInPlace, forkAuthoritySnapshot } from './authoritySnapshot.js';
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
  return applyBoardTombstoneOperations(source, commit.ops, commit);
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
  enableNotebookOperations = false,
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
  if (Number(board.notebookVersion ?? 0) > 1 || board.notebookVersion === 1 && !enableNotebookOperations) {
    throw new Error('Notebook update required; this reader cannot edit the stored journal');
  }

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
  replay.forEach(commit => assertNotebookCommitReadable(commit, enableNotebookOperations ? 1 : 0));
  let currentSnapshot = applyAuthorityActions(board.snapshot, replay);
  if (enableNotebookOperations) currentSnapshot = createIndexedBoardModel(currentSnapshot).snapshot;
  let notebookRequirement = board.notebookVersion === 1 ? 1 : 0;
  let currentTombstones = createBoardTombstoneIndex(board.tombstones ?? {});
  let currentNotebookTombstones = cloneValue(board.notebookTombstones ?? {});

  const authority = createTeacherAuthority({
    initialRevision: headRevision,
    persistCommit: async (attemptedCommit) => {
      const persisted = await persistCommit(safeBoardId, attemptedCommit);
      if (persisted?.duplicate) return persisted;
      const durableCommit = persisted?.commit ?? attemptedCommit;
      if (durableCommit.ops?.some(op => op?.type === 'notebook')) notebookRequirement = 1;
      const ops = durableCommit?.ops ?? [], background = durableCommit?.background ?? null;
      const scoped = enableNotebookOperations && applyIndexedNotebookOps(currentSnapshot, ops, background);
      if (scoped) currentSnapshot = scoped;
      else if (enableNotebookOperations) {
        const next = forkAuthoritySnapshot(currentSnapshot, ops);
        applyAuthorityOpsInPlace(next, ops, background);
        currentSnapshot = createIndexedBoardModel(next).snapshot;
      } else applyAuthorityOpsInPlace(currentSnapshot, ops, background);
      currentTombstones = updateTombstones(currentTombstones, durableCommit);
      currentNotebookTombstones = updateNotebookTombstones(currentNotebookTombstones, durableCommit.ops, durableCommit);
      return persisted ?? { commit: durableCommit, duplicate: false };
    },
  });

  const verificationView = isBoundedVerificationBoard(board) ? createVerificationView({
    notebookVersion: enableNotebookOperations ? 1 : 0,
    getSnapshot: () => currentSnapshot,
    getRevision: () => authority.getRevision(),
  }) : null;
  const verificationLane = verificationView ? createVerificationWorkLane() : null;

  let commitQueue = Promise.resolve();

  const commitOne = async (actionInput) => {
    const action = actionInput && typeof actionInput === 'object' ? actionInput : {};
    const actionId = String(action.actionId ?? '').trim();
    if (!actionId) throw new Error('actionId is required');

    const prior = await loadActionOutcome(safeBoardId, actionId);
    if (prior) return normalizePriorOutcome(prior);

    const input = {
      snapshot: currentSnapshot,
      tombstones: currentTombstones,
      notebookTombstones: currentNotebookTombstones,
      notebookVersion: enableNotebookOperations ? 1 : 0,
      clientId: String(action.clientId ?? ''),
      actionId,
      ops: action.ops,
      background: action.background,
    };

    const history = (action.ops ?? []).some(isConditionalHistoryOperation);
    const scoped = enableNotebookOperations && prepareIndexedNotebookAction(input, { history });
    const evaluation = scoped?.evaluation ?? evaluateAuthorityAction(input);
    const historyResult = history
      ? (scoped?.history ?? prepareAuthoritativeHistory(currentSnapshot, evaluation.appliedOps, evaluation.appliedBackground, action))
      : null;
    if (historyResult) evaluation.appliedOps = historyResult.appliedOps;

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
        ...(history ? { historyInverseOps: [] } : {}),
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
      // Never accept client-supplied inverse data as authoritative.
      historyInverseOps: historyResult?.historyInverseOps,
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
    getNotebookVersion() { return enableNotebookOperations ? 1 : 0; },
    getNotebookRequirement() { return notebookRequirement; },
    getNotebookTombstones() { return cloneValue(currentNotebookTombstones); },
    // Internal cold-start source. The indexed snapshot and persistent tombstone
    // index are authority-owned versions; commits replace them rather than mutate
    // prior versions. Callers must revision-fence this reference before install.
    getNotebookCheckpointSource() {
      return { snapshot: currentSnapshot, revision: authority.getRevision(), tombstones: currentTombstones,
        notebookTombstones: currentNotebookTombstones };
    },
    getRevision() {
      return authority.getRevision();
    },
    getSnapshot() {
      return cloneValue(currentSnapshot);
    },
    getVerificationView() { return verificationView; },
    runVerification(key, work) {
      return verificationLane ? verificationLane.run(key, work)
        : Promise.reject(new Error('Board verification is not enabled'));
    },
    closeVerification() { verificationLane?.close(); },
    getTombstones() {
      return currentTombstones.serialize();
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