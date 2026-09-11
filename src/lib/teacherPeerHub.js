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

export function createTeacherPeerHub({
  authority,
  getSnapshot,
  getCommitsAfter,
  createTransferId = defaultTransferId,
  maxJournalCommits = 256,
  onCommit = () => {},
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
      return () => peers.delete(id);
    },

    removePeer(peerId) {
      peers.delete(String(peerId ?? ''));
    },

    getPeerCount() {
      return peers.size;
    },

    async handleMessage(peerId, message) {
      const peer = requirePeer(peerId);
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

      if (type !== 'action-proposal') return;

      try {
        const commit = await authority.commitAction(payload);
        if (commit?.duplicate) {
          await peer.send('commit', commit);
        } else {
          for (const transport of peers.values()) {
            // eslint-disable-next-line no-await-in-loop
            await transport.send('commit', commit);
          }
          onCommit(commit);
        }
        await peer.send('ack', {
          actionId: String(commit?.actionId ?? payload.actionId ?? ''),
          revision: safeRevision(commit?.revision),
          accepted: true,
          duplicate: Boolean(commit?.duplicate),
          needsSync: Boolean(commit?.needsSync),
        });
      } catch (error) {
        await peer.send('ack', {
          actionId: String(payload.actionId ?? ''),
          revision: safeRevision(authority.getRevision()),
          accepted: false,
          duplicate: false,
          needsSync: true,
          error: String(error?.message ?? error ?? 'Commit rejected'),
        });
      }
    },
  };
}
