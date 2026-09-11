import { operationObjectIds } from './operationProtocol.js';
import { createTeacherObjectLockAuthority } from './teacherObjectLocks.js';

function defaultTransferId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `transfer-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function safeRevision(value) {
  const revision = Number(value ?? 0);
  return Number.isInteger(revision) && revision >= 0 ? revision : 0;
}

function journalIsContiguous(commits, fromRevision, toRevision) {
  if (!Array.isArray(commits) || !commits.length) return false;
  if (safeRevision(commits[0]?.revision) !== fromRevision + 1) return false;
  if (safeRevision(commits.at(-1)?.revision) !== toRevision) return false;
  for (let index = 0; index < commits.length; index += 1) {
    if (safeRevision(commits[index]?.revision) !== fromRevision + index + 1) return false;
  }
  return true;
}

function authoritativeAckFields(commit) {
  const fields = {};
  if (Object.prototype.hasOwnProperty.call(commit ?? {}, 'changed')) {
    fields.changed = Boolean(commit.changed);
  }
  if (Object.prototype.hasOwnProperty.call(commit ?? {}, 'appliedOps')) {
    fields.appliedOps = Array.isArray(commit.appliedOps) ? commit.appliedOps : [];
  }
  if (Object.prototype.hasOwnProperty.call(commit ?? {}, 'appliedBackground')) {
    fields.appliedBackground = commit.appliedBackground ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(commit ?? {}, 'skippedConflicts')) {
    fields.skippedConflicts = Array.isArray(commit.skippedConflicts) ? commit.skippedConflicts : [];
  }
  if (Object.prototype.hasOwnProperty.call(commit ?? {}, 'rejectedObjectIds')) {
    fields.rejectedObjectIds = Array.isArray(commit.rejectedObjectIds) ? commit.rejectedObjectIds : [];
  }
  return fields;
}

export function createTeacherPeerHub({
  authority,
  getSnapshot,
  getCommitsAfter,
  createTransferId = defaultTransferId,
  maxJournalCommits = 256,
  onCommit = () => {},
  lockAuthority = createTeacherObjectLockAuthority(),
} = {}) {
  if (!authority?.getRevision || !authority?.commitAction) throw new Error('teacher authority is required');
  if (typeof getSnapshot !== 'function') throw new Error('getSnapshot is required');
  if (typeof getCommitsAfter !== 'function') throw new Error('getCommitsAfter is required');

  const peers = new Map();
  const journalLimit = Math.max(1, Number(maxJournalCommits) || 256);

  const requirePeer = (peerId) => {
    const peer = peers.get(String(peerId ?? ''));
    if (!peer) throw new Error('Peer is not registered');
    return peer;
  };

  const removePeer = (peerId) => {
    const id = String(peerId ?? '').trim();
    peers.delete(id);
    if (id && typeof lockAuthority?.release === 'function') {
      Promise.resolve(lockAuthority.release({ clientId: id })).catch(() => undefined);
    }
  };

  const broadcastCommit = async (commit) => {
    for (const transport of peers.values()) {
      // eslint-disable-next-line no-await-in-loop
      await transport.send('commit', commit);
    }
  };

  const sendSnapshot = async (peer) => {
    const loaded = await getSnapshot();
    const revision = safeRevision(loaded?.revision ?? authority.getRevision());
    const payload = JSON.stringify({ snapshot: loaded?.snapshot ?? null, revision });
    await peer.sendTextTransfer('snapshot', payload, {
      transferId: createTransferId(),
    });
  };

  const sendSync = async (peer, fromRevision) => {
    const currentRevision = safeRevision(authority.getRevision());
    const knownRevision = safeRevision(fromRevision);
    if (knownRevision >= currentRevision) {
      await peer.send('head', { revision: currentRevision });
      return;
    }

    const commits = await getCommitsAfter(knownRevision, journalLimit + 1);
    if (
      commits.length <= journalLimit
      && journalIsContiguous(commits, knownRevision, currentRevision)
    ) {
      for (const commit of commits) {
        // eslint-disable-next-line no-await-in-loop
        await peer.send('commit', commit);
      }
      await peer.send('head', { revision: currentRevision });
      return;
    }

    await sendSnapshot(peer);
  };

  return {
    addPeer(peerId, transport) {
      const id = String(peerId ?? '').trim();
      if (!id) throw new Error('peerId is required');
      if (!transport?.send || !transport?.sendTextTransfer) throw new Error('peer transport is required');
      peers.set(id, transport);
      return () => removePeer(id);
    },

    removePeer,

    getPeerCount() {
      return peers.size;
    },

    broadcastCommit,

    async handleMessage(peerId, message) {
      const safePeerId = String(peerId ?? '').trim();
      const peer = requirePeer(safePeerId);
      const type = String(message?.type ?? '');
      const payload = message?.payload && typeof message.payload === 'object' ? message.payload : {};

      if (type === 'head-request') {
        await peer.send('head', { revision: safeRevision(authority.getRevision()) });
        return;
      }

      if (type === 'snapshot-request') {
        await sendSnapshot(peer);
        return;
      }

      if (type === 'sync-request') {
        await sendSync(peer, payload.revision);
        return;
      }

      if (type === 'lock-request') {
        if (!lockAuthority) return;
        const operation = String(payload.operation ?? '');
        let result = null;
        if (operation === 'acquire' && typeof lockAuthority.acquire === 'function') {
          result = await lockAuthority.acquire({
            clientId: safePeerId,
            lockToken: String(payload.lockToken ?? ''),
            objectIds: Array.isArray(payload.objectIds) ? payload.objectIds.map(String) : [],
            ttlMs: Number(payload.ttlMs ?? 0),
          });
        }
        if (operation === 'refresh' && typeof lockAuthority.refresh === 'function') {
          result = await lockAuthority.refresh({
            clientId: safePeerId,
            lockToken: String(payload.lockToken ?? ''),
            ttlMs: Number(payload.ttlMs ?? 0),
          });
        }
        if (operation === 'release' && typeof lockAuthority.release === 'function') {
          result = await lockAuthority.release({
            clientId: safePeerId,
            lockToken: payload.lockToken == null ? null : String(payload.lockToken),
          });
        }
        if (!result) return;
        await peer.send('lock-result', {
          ...result,
          requestId: String(payload.requestId ?? ''),
          operation,
        });
        return;
      }

      if (type !== 'action-proposal') return;

      const proposal = {
        ...payload,
        clientId: safePeerId,
      };
      const affectedIds = [...operationObjectIds(proposal.ops ?? [])];
      if (affectedIds.length && typeof lockAuthority?.getConflicts === 'function') {
        const conflicts = await lockAuthority.getConflicts({
          clientId: safePeerId,
          objectIds: affectedIds,
        });
        if (Array.isArray(conflicts) && conflicts.length) {
          await peer.send('ack', {
            actionId: String(proposal.actionId ?? ''),
            revision: safeRevision(authority.getRevision()),
            accepted: false,
            duplicate: false,
            needsSync: false,
            changed: false,
            appliedOps: [],
            appliedBackground: null,
            skippedConflicts: [],
            rejectedObjectIds: [...new Set(conflicts.map((conflict) => String(conflict?.objectId ?? '')).filter(Boolean))],
            error: 'Object locked by another participant',
          });
          return;
        }
      }

      try {
        const commit = await authority.commitAction(proposal);
        if (commit?.duplicate) {
          await peer.send('commit', commit);
        } else if (commit?.changed !== false) {
          await broadcastCommit(commit);
          onCommit(commit);
        }
        await peer.send('ack', {
          actionId: String(commit?.actionId ?? proposal.actionId ?? ''),
          revision: safeRevision(commit?.revision),
          accepted: true,
          duplicate: Boolean(commit?.duplicate),
          needsSync: Boolean(commit?.needsSync),
          ...authoritativeAckFields(commit),
        });
      } catch (error) {
        await peer.send('ack', {
          actionId: String(proposal.actionId ?? ''),
          revision: safeRevision(authority.getRevision()),
          accepted: false,
          duplicate: false,
          needsSync: true,
          changed: false,
          appliedOps: [],
          appliedBackground: null,
          skippedConflicts: [],
          rejectedObjectIds: [],
          error: String(error?.message ?? error ?? 'Commit rejected'),
        });
      }
    },
  };
}
