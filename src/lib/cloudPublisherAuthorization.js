const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{6,128}$/;

/** Screen-scoped guest publishing: the local owner, not a claimed network role,
 * authorizes editors. The server signs the permit and validates it on creation.
 * Owner keys never travel through the signaling channel.
 */
export function createCloudPublisherAuthorization({
  getContext,
  getOwnerBoard,
  authorizePublisher,
  sendSignal,
  timeoutMs = 12_000,
  createId = () => crypto.randomUUID(),
}) {
  const pending = new Map();
  let closed = false;
  const sameSession = (original) => {
    const current = getContext();
    return !closed && current?.boardId === original.boardId
      && current.sessionId === original.sessionId && current.hostId === original.hostId
      && current.sourceMode === 'screen';
  };
  const finish = (id, error, grant) => {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    if (error) entry.reject(error);
    else entry.resolve(grant);
  };
  const ownerAllows = (board, current) => board?.boardId === current.boardId
    && board.ownerKey === current.boardKey && board.shareKey === current.roomKey
    && board.guestMode === 'edit';

  return {
    request() {
      const current = getContext();
      if (closed) return Promise.reject(new Error('Cloud authorization is closed'));
      if (!current?.canEdit || current.role !== 'host' || current.clientId !== current.hostId
        || current.sourceMode !== 'screen' || !current.sessionId) {
        return Promise.reject(new Error('Publisher permission required'));
      }
      const requestId = createId();
      if (!REQUEST_ID_PATTERN.test(requestId) || pending.has(requestId)) {
        return Promise.reject(new Error('Invalid Cloud permission request id'));
      }
      const result = new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(requestId,
          new Error('Cloud owner authorization timed out')), Math.max(1, timeoutMs));
        pending.set(requestId, { resolve, reject, timer, context: { ...current } });
      });
      Promise.resolve().then(() => {
        if (!pending.has(requestId) || !sameSession(current)) return;
        return sendSignal('cloud-grant-request', { sessionId: current.sessionId, requestId });
      }).catch((error) => finish(requestId, error));
      return result;
    },

    async handleSignal(signal) {
      if (closed || !signal || !REQUEST_ID_PATTERN.test(String(signal.requestId ?? ''))) return false;
      const current = { ...getContext() };
      if (!current.sessionId || signal.sessionId !== current.sessionId || current.sourceMode !== 'screen') return false;
      if (signal.type === 'cloud-publisher-grant') {
        if (signal.targetId !== current.clientId) return false;
        const entry = pending.get(signal.requestId);
        if (!entry || !sameSession(entry.context)) return false;
        const grant = String(signal.publisherGrant ?? '');
        if (signal.error || !grant || grant.length > 4096) {
          finish(signal.requestId, new Error('Publisher permission required'));
        } else finish(signal.requestId, null, grant);
        // The backend still verifies signature, purpose, expiry and secret-room scope.
        return true;
      }
      if (signal.type !== 'cloud-grant-request' || !current.isOwner || current.role !== 'viewer'
        || signal.clientId !== current.hostId) return false;
      const reply = (details) => sendSignal('cloud-publisher-grant', {
        sessionId: current.sessionId, requestId: signal.requestId, targetId: signal.clientId, ...details,
      });
      try {
        const board = await getOwnerBoard(current.boardId);
        if (!sameSession(current)) return true;
        if (!ownerAllows(board, current)) { await reply({ error: 'Publisher permission required' }); return true; }
        const { publisherGrant } = await authorizePublisher(current.sessionId);
        if (!sameSession(current)) return true;
        // A guest-mode change while the request was in flight must not grant publication.
        if (!ownerAllows(await getOwnerBoard(current.boardId), current)) {
          if (sameSession(current)) await reply({ error: 'Publisher permission required' });
          return true;
        }
        if (sameSession(current)) await reply({ publisherGrant });
      } catch {
        if (sameSession(current)) await reply({ error: 'Could not authorize Cloud publisher' }).catch(() => {});
      }
      return true;
    },

    close() {
      closed = true;
      for (const id of pending.keys()) finish(id, new Error('Cloud authorization is closed'));
    },
  };
}
