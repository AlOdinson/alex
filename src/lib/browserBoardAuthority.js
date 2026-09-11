import { createTeacherAuthority } from './teacherAuthority.js';
import { applyAuthorityActions, applyAuthorityOps } from './authoritySnapshot.js';
import {
  getAuthorityBoard,
  getAuthorityCommitsAfter,
  persistAuthorityCommit,
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
  let currentSnapshot = applyAuthorityActions(board.snapshot, replay);

  const authority = createTeacherAuthority({
    initialRevision: headRevision,
    persistCommit: async (attemptedCommit) => {
      const persisted = await persistCommit(safeBoardId, attemptedCommit);
      if (persisted?.duplicate) return persisted;
      const durableCommit = persisted?.commit ?? attemptedCommit;
      currentSnapshot = applyAuthorityOps(
        currentSnapshot,
        durableCommit?.ops ?? [],
        durableCommit?.background ?? null,
      );
      return persisted ?? { commit: durableCommit, duplicate: false };
    },
  });

  return {
    boardId: safeBoardId,
    getRevision() {
      return authority.getRevision();
    },
    getSnapshot() {
      return cloneValue(currentSnapshot);
    },
    commitAction(action) {
      return authority.commitAction(action);
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
