import { buildVerificationReply } from './boundedVerificationProtocol.js';
import { verificationJson } from './boundedVerificationDigest.js';
import { operationObjectIds } from './operationProtocol.js';
import { createTeacherObjectLockAuthority } from './teacherObjectLocks.js';
import { normalizeBoardControl } from './boardControlProtocol.js';

const SNAPSHOT_WRITE_TIMEOUT_MS = 120_000;
const PEER_BOARD_CONTROL_ALWAYS_ALLOWED = new Set(['view-request']);
const PEER_BOARD_CONTROL_EDIT_REQUIRED = new Set([
  'background-live',
  'lock',
  'selection-transaction',
]);

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
  onBoardControl = () => {},
  lockAuthority = createTeacherObjectLockAuthority(),
  canPeerEdit = async () => true,
} = {}) {
  if (!authority?.getRevision || !authority?.commitAction) throw new Error('teacher authority is required');
  if (typeof getSnapshot !== 'function') throw new Error('getSnapshot is required');
  if (typeof getCommitsAfter !== 'function') throw new Error('getCommitsAfter is required');
  if (typeof canPeerEdit !== 'function') throw new Error('canPeerEdit must be a function');

  const peers = new Map();
  const verificationView = authority.getVerificationView?.() ?? null;
  const verificationEpoch = verificationView ? defaultTransferId() : '';
  const verificationPending = new Set();
  const verificationFields = () => verificationView
    ? { verificationVersion: 1, verificationEpoch } : {};

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
    const payload = JSON.stringify({ snapshot: loaded?.snapshot ?? null, revision, ...verificationFields() });
    await peer.sendTextTransfer('snapshot', payload, {
      transferId: createTransferId(),
      writeTimeoutMs: snapshotTimeout,
    });
  };

  const sendSync = async (peer, fromRevision) => {
    const currentRevision = safeRevision(authority.getRevision());
    const knownRevision = safeRevision(fromRevision);
    if (knownRevision >= currentRevision) {
      await peer.send('head', { revision: currentRevision, ...verificationFields() });
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
      await peer.send('head', { revision: currentRevision, ...verificationFields() });
      return;
    }

    await sendSnapshot(peer);
  };

  const verifyPeer = async (peerId, peer, request) => {
    if (!verificationView) return peer.send('head', { revision: safeRevision(authority.getRevision()) });
    if (verificationPending.has(peer)) return; // Never accumulate duplicate per-peer jobs.
    verificationPending.add(peer);
    const live = () => peers.get(peerId) === peer;
    try {
      const work = async (signal) => {
        let reply = await buildVerificationReply(verificationView, request, verificationEpoch, { signal, isCurrent: live });
        const stamp = verificationView.capture();
        try {
          return await verificationJson({ v: 1, type: 'head', payload: {
            revision: reply.revision, ...verificationFields(), verification: reply,
          } }, { signal, isCurrent: () => live() && verificationView.isCurrent(stamp)
            && (reply.status !== 'ok' || reply.revision === verificationView.revision()) });
        } catch (error) {
          if (error?.name !== 'AbortError') throw error;
          reply = { version: 1, requestId: request?.requestId ?? '', epoch: verificationEpoch,
            revision: verificationView.revision(), status: 'stale' };
          return JSON.stringify({ v: 1, type: 'head', payload: { revision: reply.revision,
            ...verificationFields(), verification: reply } });
        }
      };
      const encoded = typeof authority.runVerification === 'function'
        ? await authority.runVerification(peer, work) : await work();
      if (!live()) return;
      if (typeof peer.sendLowPriorityEncoded === 'function') await peer.sendLowPriorityEncoded(encoded);
      else await peer.send('head', JSON.parse(encoded).payload);
    } catch {
      if (live()) await peer.send('head', { revision: safeRevision(authority.getRevision()), ...verificationFields(),
        verification: { version: 1, requestId: request?.requestId ?? '', epoch: verificationEpoch, status: 'error' } });
    } finally { verificationPending.delete(peer); }
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


  const sendBoardControl = async (peerId, event, payload = {}) => {
    const peer = requirePeer(peerId);
    const control = normalizeBoardControl(event, payload);
    await peer.send('board-control', control);
    return true;
  };

  const broadcastBoardControl = async (event, payload = {}) => {
    const control = normalizeBoardControl(event, payload);
    const tasks = [];
    for (const [peerId, transport] of peers.entries()) {
      const task = Promise.resolve(transport.send('board-control', control)).catch((error) => {
        if (removePeer(peerId, transport)) {
          try { transport.close?.({ closeChannel: true }); } catch { /* retired */ }
        }
        throw error;
      });
      tasks.push(task);
    }
    await Promise.all(tasks);
    return tasks.length;
  };

  return {
    addPeer(peerId, transport) {
      const id = String(peerId ?? '').trim();
      if (!id) throw new Error('peerId is required');
      if (!transport?.send || !transport?.sendTextTransfer) throw new Error('peer transport is required');
      peers.set(id, transport);
      return () => removePeer(id, transport);
    },

    removePeer,

    getVerificationMode() { return verificationView ? { version: 1, epoch: verificationEpoch } : { version: 0, epoch: '' }; },

    getPeerCount() {
      return peers.size;
    },

    broadcastCommit,
    sendBoardControl,
    broadcastBoardControl,

    async handleMessage(peerId, message) {
      const safePeerId = String(peerId ?? '').trim();
      const peer = requirePeer(safePeerId);
      const type = String(message?.type ?? '');
      const payload = message?.payload && typeof message.payload === 'object' ? message.payload : {};

      if (type === 'head-request') {
        if (payload.verification) return verifyPeer(safePeerId, peer, payload.verification);
        await peer.send('head', { revision: safeRevision(authority.getRevision()), ...verificationFields() });
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

      if (type === 'board-control') {
        const control = normalizeBoardControl(payload.event, payload.payload);
        if (PEER_BOARD_CONTROL_ALWAYS_ALLOWED.has(control.event)) {
          await onBoardControl(safePeerId, control.event, control.payload);
          return;
        }
        if (PEER_BOARD_CONTROL_EDIT_REQUIRED.has(control.event) && await peerMayEdit(safePeerId)) {
          await onBoardControl(safePeerId, control.event, control.payload);
        }
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
