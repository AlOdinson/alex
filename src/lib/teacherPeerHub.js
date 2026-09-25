import { createIntegrityPeerResponder } from './boardIntegrityPeer.js';
import { validIntegrityIds } from './boardIntegrityData.js';
import { operationObjectIds } from './operationProtocol.js';
import { createTeacherObjectLockAuthority } from './teacherObjectLocks.js';

const SNAPSHOT_WRITE_TIMEOUT_MS = 120_000;

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
  if (Array.isArray(commit?.historyInverseOps)) fields.historyInverseOps = commit.historyInverseOps;
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
  snapshotWriteTimeoutMs = SNAPSHOT_WRITE_TIMEOUT_MS,
  onCommit = () => {},
  runIntegrityWork = (work) => work(),
  onError = () => {},
  lockAuthority = createTeacherObjectLockAuthority(),
  canPeerEdit = async () => true,
} = {}) {
  if (!authority?.getRevision || !authority?.commitAction) throw new Error('teacher authority is required');
  if (typeof getSnapshot !== 'function') throw new Error('getSnapshot is required');
  if (typeof getCommitsAfter !== 'function') throw new Error('getCommitsAfter is required');
  if (typeof canPeerEdit !== 'function') throw new Error('canPeerEdit must be a function');

  const peers = new Map();
  const integrityPeers = new Map();
  const integrityFields = (peer) => {
    const item = integrityPeers.get(peer);
    return item ? { integrity: item.info } : {};
  };
  const negotiateIntegrity = (peer, payload) => {
    if (payload.integrityVersion !== 1 || integrityPeers.has(peer)) return;
    const source = authority.getIntegritySource?.();
    if (source?.version !== 1 || !source.boardId) return;
    const info = { version: 1, sessionId: String(createTransferId()), boardId: source.boardId };
    const responder = createIntegrityPeerResponder({
      getSource: () => authority.getIntegritySource?.(), ...info,
      runWork: runIntegrityWork, onError,
      send: (type, data) => peer.send(type, data),
      sendTextTransfer: (kind, text) => peer.sendTextTransfer(kind, text, { transferId: createTransferId() }),
    });
    integrityPeers.set(peer, { info, responder, hintBusy: false, nextHint: null });
  };
  const journalLimit = Math.max(1, Number(maxJournalCommits) || 256);
  const snapshotTimeout = Number.isFinite(Number(snapshotWriteTimeoutMs)) && Number(snapshotWriteTimeoutMs) > 0
    ? Number(snapshotWriteTimeoutMs)
    : SNAPSHOT_WRITE_TIMEOUT_MS;

  const requirePeer = (peerId) => {
    const peer = peers.get(String(peerId ?? ''));
    if (!peer) throw new Error('Peer is not registered');
    return peer;
  };

  const removePeer = (peerId, expectedTransport = null) => {
    const id = String(peerId ?? '').trim();
    const transport = peers.get(id);
    if (!transport) return false;
    // A stale cleanup callback must not unregister a replacement transport that has
    // already been installed under the same stable peer id.
    if (expectedTransport && transport !== expectedTransport) return false;
    peers.delete(id);
    integrityPeers.get(transport)?.responder.close();
    integrityPeers.delete(transport);
    if (id && typeof lockAuthority?.release === 'function') {
      Promise.resolve(lockAuthority.release({ clientId: id })).catch(() => undefined);
    }
    return true;
  };

  const broadcastCommit = async (commit) => {
    // Each transport already serializes its frames. Queue to every peer now;
    // awaiting one slow device here used to block all others and the writer's ack.
    for (const [peerId, transport] of peers.entries()) {
      const retire = () => {
        if (!removePeer(peerId, transport)) return;
        try { transport.close?.({ closeChannel: true }); } catch { /* retired */ }
      };
      try { Promise.resolve(transport.send('commit', commit)).catch(retire); }
      catch { retire(); }
    }
  };

  const sendSnapshot = async (peer) => {
    const loaded = await getSnapshot();
    const revision = safeRevision(loaded?.revision ?? authority.getRevision());
    const payload = JSON.stringify({ snapshot: loaded?.snapshot ?? null, revision, ...integrityFields(peer) });
    await peer.sendTextTransfer('snapshot', payload, {
      transferId: createTransferId(),
      writeTimeoutMs: snapshotTimeout,
    });
  };

  const sendSync = async (peer, fromRevision) => {
    const currentRevision = safeRevision(authority.getRevision());
    const knownRevision = safeRevision(fromRevision);
    if (knownRevision >= currentRevision) {
      await peer.send('head', { revision: currentRevision, ...integrityFields(peer) });
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
      await peer.send('head', { revision: currentRevision, ...integrityFields(peer) });
      return;
    }

    await sendSnapshot(peer);
  };

  const peerMayEdit = async (peerId) => Boolean(await canPeerEdit(String(peerId ?? '').trim()));

  const sendReadOnlyAck = async (peer, actionId) => {
    await peer.send('ack', {
      actionId: String(actionId ?? ''),
      revision: safeRevision(authority.getRevision()),
      accepted: false,
      duplicate: false,
      needsSync: false,
      changed: false,
      appliedOps: [],
      appliedBackground: null,
      skippedConflicts: [],
      rejectedObjectIds: [],
      error: 'Board is view-only',
    });
  };

  return {
    addPeer(peerId, transport) {
      const id = String(peerId ?? '').trim();
      if (!id) throw new Error('peerId is required');
      if (!transport?.send || !transport?.sendTextTransfer) throw new Error('peer transport is required');
      const previous = peers.get(id);
      if (previous && previous !== transport) {
        integrityPeers.get(previous)?.responder.close();
        integrityPeers.delete(previous);
      }
      peers.set(id, transport);
      return () => removePeer(id, transport);
    },

    removePeer,

    getPeerCount() {
      return peers.size;
    },

    broadcastCommit,

    broadcastIntegrityHint(ids, revision) {
      if (!validIntegrityIds(ids)) return;
      // Each peer has one in-flight hint and one bounded coalesced replacement.
      // The verifier supplies at most four batches/second; no heartbeat is added.
      for (const [peer, item] of integrityPeers) {
        item.nextHint = { revision: safeRevision(revision), integrity: { ...item.info, checkIds: ids } };
        if (item.hintBusy) continue;
        item.hintBusy = true;
        (async () => {
          try {
            while (integrityPeers.get(peer) === item && item.nextHint) {
              const payload = item.nextHint; item.nextHint = null;
              await peer.send('head', payload);
            }
          } catch (error) { try { onError(error); } catch { /* audit observer */ } }
          finally { item.hintBusy = false; }
        })();
      }
    },

    async handleMessage(peerId, message) {
      const safePeerId = String(peerId ?? '').trim();
      const peer = requirePeer(safePeerId);
      const type = String(message?.type ?? '');
      const payload = message?.payload && typeof message.payload === 'object' ? message.payload : {};

      if (type === 'integrity-request') {
        return integrityPeers.get(peer)?.responder.handle(message);
      }
      if (['head-request', 'snapshot-request', 'sync-request'].includes(type)) negotiateIntegrity(peer, payload);

      if (type === 'head-request') {
        await peer.send('head', { revision: safeRevision(authority.getRevision()), ...integrityFields(peer) });
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
        if ((operation === 'acquire' || operation === 'refresh') && !(await peerMayEdit(safePeerId))) {
          await peer.send('lock-result', {
            requestId: String(payload.requestId ?? ''),
            operation,
            granted: false,
            objectIds: operation === 'acquire'
              ? [...new Set((Array.isArray(payload.objectIds) ? payload.objectIds : []).map(String))]
              : [],
            conflicts: [],
            error: 'Board is view-only',
          });
          return;
        }
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

      if (!(await peerMayEdit(safePeerId))) {
        await sendReadOnlyAck(peer, payload.actionId);
        return;
      }

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
