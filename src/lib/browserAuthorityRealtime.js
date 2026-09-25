import { createBrowserBoardSession } from './browserBoardSession.js';
import { createBrowserAuthorityRealtimeCore } from './browserAuthorityRealtimeCore.js';
import { supabase } from './supabase.js';

const CONNECT_TIMEOUT_MS = 10_000;
const LOCK_TTL = 12_000;

function participantColor(clientId) {
  const palette = ['#2563eb', '#db2777', '#059669', '#d97706', '#7c3aed', '#0891b2', '#dc2626'];
  let hash = 0;
  for (const character of String(clientId)) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  return palette[Math.abs(hash) % palette.length];
}

function withTimeout(promise, milliseconds, message, signal = null) {
  let timer = null;
  let onAbort = null;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      onAbort = () => reject(new Error('Ably transport is closed'));
      if (signal?.aborted) { onAbort(); return; }
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    }),
  ]).finally(() => {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  });
}

export async function routeBrowserRealtimeEvent(event, payload, {
  localClientId = '',
  session = null,
  callbacks = {},
} = {}) {
  if (!payload || String(payload.clientId ?? '') === String(localClientId ?? '')) return false;

  // Durable board state never arrives through Ably in browser-authority mode.
  // These names are intentionally ignored so an old/stale publisher cannot bypass
  // teacher authority or make Ably a second source of truth.
  if (event === 'action' || event === 'actions') return false;

  const {
    onMode,
    onSettings,
    onBackgroundLive,
    onSyncRequired,
    onCursor,
    onLock,
    onTransform,
    onDraw,
    onPreview,
    onObjectLive,
    onDeletePreview,
    onSelectionTransaction,
    onView,
    onViewJump,
    onViewRequest,
    onGameLibraryVisibility,
    onScreenShareSignal,
  } = callbacks;

  if (event === 'mode') onMode?.(payload.mode);
  else if (event === 'settings') onSettings?.(payload.settings ?? {}, Number(payload.revision ?? 0), Boolean(payload.needsSync));
  else if (event === 'background-live') onBackgroundLive?.(payload.background, payload);
  else if (event === 'sync') onSyncRequired?.(Number(payload.revision ?? 0));
  else if (event === 'cursor') onCursor?.({ ...payload, receivedAt: Date.now() });
  else if (event === 'lock') onLock?.({ ...payload, expiresAt: Number(payload.expiresAt ?? Date.now() + LOCK_TTL) });
  else if (event === 'transform') onTransform?.({ ...payload, receivedAt: Date.now() });
  else if (event === 'draw') onDraw?.({ ...payload, receivedAt: Date.now() });
  else if (event === 'preview') onPreview?.({ ...payload, receivedAt: Date.now() });
  else if (event === 'object-live') onObjectLive?.({ ...payload, receivedAt: Date.now() });
  else if (event === 'delete-preview') onDeletePreview?.({ ...payload, receivedAt: Date.now() });
  else if (event === 'selection-transaction') onSelectionTransaction?.({ ...payload, receivedAt: Date.now() });
  else if (event === 'view') onView?.({ ...payload, receivedAt: Date.now() });
  else if (event === 'view-jump') onViewJump?.({ ...payload, receivedAt: Date.now() });
  else if (event === 'view-request') onViewRequest?.({ ...payload, receivedAt: Date.now() });
  else if (event === 'game-library-visibility') {
    onGameLibraryVisibility?.({ ...payload, visible: Boolean(payload.visible), receivedAt: Date.now() });
  } else if (event === 'screen-share-signal') {
    await session?.handleRealtimeSignal?.(payload);
    onScreenShareSignal?.({ ...payload, receivedAt: Date.now() });
  } else {
    return false;
  }
  return true;
}

export function createAblyBrowserTransport({
  boardId,
  roomKey,
  clientId,
  name,
  permission,
  color = participantColor(clientId),
  onEvent = () => {},
  onUsers = () => {},
  onStatus = () => {},
  onRecover = async () => {},
  onError = () => {},
  tokenRequest = async ({ boardId: tokenBoardId, roomKey: tokenRoomKey, clientId: tokenClientId }) => {
    const { data, error } = await supabase.functions.invoke('ably-browser-token', {
      body: { boardId: tokenBoardId, roomKey: tokenRoomKey, clientId: tokenClientId },
    });
    if (error) throw error;
    if (!data?.token) throw new Error('Token endpoint returned no token');
    return data;
  },
  AblyRuntime = typeof window !== 'undefined' ? window.Ably : null,
} = {}) {
  const safeBoardId = String(boardId ?? '').trim();
  const safeRoomKey = String(roomKey ?? '').trim();
  const safeClientId = String(clientId ?? '').trim();
  if (!safeBoardId || !safeRoomKey || !safeClientId) throw new Error('Ably board identity is incomplete');

  let client = null;
  let channel = null;
  let closed = false;
  let remoteParticipantCount = 0;
  let presenceRefresh = Promise.resolve();
  let recoveryPromise = null;
  let connectedOnce = false;
  let attachedOnce = false;
  let startTask = null;
  let retryTimer = null;
  let resumeRetry = null;
  const lifetime = new AbortController();

  const retireClient = () => {
    const previous = client;
    client = null;
    channel = null;
    remoteParticipantCount = 0;
    connectedOnce = false;
    attachedOnce = false;
    // close() leaves Ably presence too. Awaiting presence.leave() first can hang
    // forever on the very connection we are trying to retire.
    try { previous?.close?.(); } catch { /* already disconnected */ }
  };

  const refreshUsers = async () => {
    if (!channel || closed) return [];
    const currentChannel = channel;
    const members = await withTimeout(currentChannel.presence.get(), CONNECT_TIMEOUT_MS,
      'Timed out while reading Ably board presence', lifetime.signal);
    if (closed || channel !== currentChannel) return [];
    const users = new Map();
    members.forEach((member) => {
      const data = member?.data ?? {};
      const memberClientId = String(member?.clientId ?? data.clientId ?? '').trim();
      if (!memberClientId) return;
      users.set(memberClientId, {
        clientId: memberClientId,
        name: data.name ?? 'Участник',
        permission: data.permission ?? 'view',
        color: data.color ?? participantColor(memberClientId),
      });
    });
    const list = [...users.values()];
    remoteParticipantCount = list.filter((user) => user.clientId !== safeClientId).length;
    onUsers(list);
    return list;
  };

  const recoverContinuity = (reason) => {
    if (closed) return Promise.resolve();
    if (recoveryPromise) return recoveryPromise;
    onStatus('RECOVERING');
    recoveryPromise = Promise.resolve()
      .then(refreshUsers)
      .then(() => onRecover({ reason }))
      .then(() => {
        if (!closed) onStatus('RECOVERED');
      })
      .catch((error) => {
        if (!closed) {
          onError(error);
          onStatus('CHANNEL_ERROR');
        }
      })
      .finally(() => {
        recoveryPromise = null;
      });
    return recoveryPromise;
  };

  const startAttempt = async () => {
    const attemptClient = new AblyRuntime.Realtime({
      clientId: safeClientId,
      useTokenAuth: true,
      echoMessages: false,
      authCallback: async (_params, callback) => {
        try {
          const token = await tokenRequest({ boardId: safeBoardId, roomKey: safeRoomKey, clientId: safeClientId });
          if (closed || client !== attemptClient) throw new Error('Ably transport is closed');
          callback(null, token);
        } catch (error) {
          callback(error, null);
        }
      },
      disconnectedRetryTimeout: 5000,
      suspendedRetryTimeout: 15000,
    });
    client = attemptClient;
    const current = () => !closed && client === attemptClient;
    const assertCurrent = () => { if (!current()) throw new Error('Ably transport is closed'); };
    attemptClient.connection.on((change) => {
      if (!current()) return;
      const state = change?.current ?? attemptClient.connection.state;
      if (state === 'connected') {
        const shouldRecover = connectedOnce;
        connectedOnce = true;
        onStatus('SUBSCRIBED');
        if (shouldRecover) recoverContinuity('connection-reconnected');
      } else if (state === 'disconnected') onStatus('TIMED_OUT');
      else if (state === 'suspended' || state === 'failed') onStatus('CHANNEL_ERROR');
      else if (state === 'closed') onStatus('CLOSED');
    });

    await withTimeout(
      attemptClient.connection.state === 'connected' ? Promise.resolve() : attemptClient.connection.once('connected'),
      CONNECT_TIMEOUT_MS, 'Timed out while connecting to Ably', lifetime.signal,
    );
    assertCurrent();
    connectedOnce = true;
    const attemptChannel = attemptClient.channels.get(`board:${safeBoardId}:${safeRoomKey}`);
    channel = attemptChannel;
    attemptChannel.on?.('attached', (change) => {
      if (!current()) return;
      const shouldRecover = attachedOnce && change?.resumed === false;
      attachedOnce = true;
      if (shouldRecover) recoverContinuity('channel-reattached-without-continuity');
    });
    attemptChannel.on?.('update', (change) => {
      if (current() && change?.resumed === false) recoverContinuity('channel-continuity-update');
    });

    await withTimeout(
      attemptChannel.subscribe((message) => {
        if (!current()) return;
        return Promise.resolve(onEvent(message?.name, message?.data)).catch(onError);
      }),
      CONNECT_TIMEOUT_MS, 'Timed out while attaching Ably board channel', lifetime.signal,
    );
    assertCurrent();
    attachedOnce = true;
    await withTimeout(attemptChannel.presence.subscribe(() => {
      if (!current()) return;
      presenceRefresh = presenceRefresh.catch(() => undefined).then(() => current() ? refreshUsers() : []).catch(onError);
    }), CONNECT_TIMEOUT_MS, 'Timed out while subscribing to Ably board presence', lifetime.signal);
    assertCurrent();
    await withTimeout(attemptChannel.presence.enter({
      clientId: safeClientId, name, permission, color, joinedAt: Date.now(),
    }), CONNECT_TIMEOUT_MS, 'Timed out while entering Ably board presence', lifetime.signal);
    assertCurrent();
    await refreshUsers();
    assertCurrent();
    onStatus('SUBSCRIBED');
    return true;
  };

  return {
    start() {
      if (closed) return Promise.reject(new Error('Ably transport is closed'));
      if (startTask) return startTask;
      if (!AblyRuntime?.Realtime) return Promise.reject(new Error('Ably SDK did not load'));
      // SDK reconnection alone cannot finish a start() abandoned before channel /
      // presence setup. Retire that partial client and retry the entire bootstrap.
      startTask = (async () => {
        let failures = 0;
        while (!closed) {
          try { return await startAttempt(); }
          catch (error) {
            retireClient();
            if (closed) throw error;
            try { onError(error); } catch { /* observer errors are ignored */ }
            try { onStatus('CHANNEL_ERROR'); } catch { /* observer errors are ignored */ }
            const delay = Math.min(15_000, 1000 * (2 ** Math.min(failures++, 4)));
            await new Promise((resolve) => {
              resumeRetry = resolve;
              retryTimer = setTimeout(resolve, delay);
            });
            clearTimeout(retryTimer);
            retryTimer = null;
            resumeRetry = null;
            if (!closed) onStatus('RECOVERING');
          }
        }
        throw new Error('Ably transport is closed');
      })();
      return startTask;
    },

    async publish(event, payload, { force = false } = {}) {
      if (closed) return 'closed';
      if (!channel) return 'starting';
      if (!force && remoteParticipantCount === 0) return 'solo';
      try {
        await channel.publish(event, payload);
        return closed ? 'closed' : 'ok';
      } catch (error) {
        // Navigation/reload deliberately closes Ably while a transient preview
        // may still be awaiting its receipt. This is cancellation, not a live
        // failure. Never suppress errors from a transport that is still active.
        if (closed) return 'closed';
        throw error;
      }
    },

    async refreshUsers() {
      return refreshUsers();
    },

    async disconnect() {
      if (closed) return;
      closed = true;
      lifetime.abort();
      clearTimeout(retryTimer);
      resumeRetry?.();
      resumeRetry = null;
      retireClient();
    },
  };
}

export function connectBoardRealtime(options = {}, dependencies = {}) {
  const {
    boardId,
    realtimeKey,
    clientId,
    name = 'Участник',
    permission = 'view',
    getKnownRevision = () => 0,
    onOps,
    onUsers,
    onMode,
    onSettings,
    onBackgroundLive,
    onCursor,
    onLock,
    onTransform,
    onDraw,
    onPreview,
    onObjectLive,
    onDeletePreview,
    onSelectionTransaction,
    onView,
    onViewJump,
    onViewRequest,
    onGameLibraryVisibility,
    onScreenShareSignal,
    onSyncRequired,
    onSnapshot,
    onVerificationRecords,
    readVerificationCanvasIds,
    canVerifyCanvas,
    onCommit,
    onPendingChange,
    onStatus,
  } = options;

  const createSession = dependencies.createSession ?? createBrowserBoardSession;
  const createCore = dependencies.createCore ?? createBrowserAuthorityRealtimeCore;
  const createTransport = dependencies.createTransport ?? createAblyBrowserTransport;
  const color = participantColor(clientId);
  let transport = null;
  let core = null;
  let disconnected = false;

  const callbacks = {
    onMode,
    onSettings,
    onBackgroundLive,
    onSyncRequired,
    onCursor,
    onLock,
    onTransform,
    onDraw,
    onPreview,
    onObjectLive,
    onDeletePreview,
    onSelectionTransaction,
    onView,
    onViewJump,
    onViewRequest,
    onGameLibraryVisibility,
    onScreenShareSignal,
  };

  const session = createSession({
    offlineCacheKey: realtimeKey,
    boardId,
    clientId,
    permission,
    onVerificationRecords, readVerificationCanvasIds, canVerifyCanvas,
    sendScreenShareSignal: (signal) => core?.sendScreenShareSignal?.(signal) ?? Promise.reject(new Error('Realtime core is not ready')),
    onAuthoritativeCommit: (commit) => onOps?.(
      Array.isArray(commit?.appliedOps) ? commit.appliedOps : (Array.isArray(commit?.ops) ? commit.ops : []),
      Number(commit?.revision ?? 0),
      // needsSync describes the proposer, not this receiver. onOps checks its own revision.
      false,
      commit?.appliedBackground ?? commit?.background ?? null,
      commit?.actionId ?? null,
      commit?.clientId ?? '',
    ),
    onAuthoritativeSnapshot: (snapshot, revision) => {
      const safeRevision = Number(revision ?? 0);
      if (typeof onSnapshot === 'function') return onSnapshot(snapshot, safeRevision);
      return onSyncRequired?.(safeRevision);
    },
    onPeerState: (state) => {
      const peerState = String(state ?? '');
      if (peerState === 'failed' || peerState === 'closed' || peerState === 'disconnected') {
        onStatus?.('RECOVERING');
      }
      if (permission !== 'owner' && (peerState === 'failed' || peerState === 'closed')) {
        Promise.resolve(transport?.refreshUsers?.()).catch((error) => {
          console.warn('Could not refresh owner presence after terminal peer failure', error);
          onStatus?.('CHANNEL_ERROR');
        });
      }
      if (peerState === 'connected') onStatus?.('RECOVERED');
    },
    onError: (error) => {
      console.warn('Browser board peer runtime error', error);
      onStatus?.('RECOVERING');
    },
  });

  core = createCore({
    session,
    clientId,
    name,
    color,
    permission,
    getKnownRevision,
    publish: (event, payload, publishOptions) => {
      if (!transport) throw new Error('Ably board transport is not ready');
      return transport.publish(event, payload, publishOptions);
    },
    onCommit,
    onPendingChange: typeof canVerifyCanvas === 'function' ? (count) => {
      onPendingChange?.(count);
      if (Number(count) === 0) session.resumeVerification?.();
    } : onPendingChange,
    onStatus,
    onSyncRequired,
  });

  transport = createTransport({
    boardId,
    roomKey: realtimeKey,
    clientId,
    name,
    permission,
    color,
    onEvent: (event, payload) => routeBrowserRealtimeEvent(event, payload, {
      localClientId: clientId,
      session,
      callbacks,
    }),
    onUsers: (users) => {
      onUsers?.(users);
      Promise.resolve(session.updateParticipants?.(users)).catch((error) => {
        console.warn('Could not update browser board participants', error);
        onStatus?.('RECOVERING');
      });
    },
    onStatus,
    onRecover: async () => {
      // Presence refresh has already run inside the transport. Wake durable work without
      // blocking recovery on a possibly-reconnecting DataChannel, then ask Board to
      // reconcile against the teacher authority / local replica at its current revision.
      Promise.resolve(core?.flushPending?.()).catch((error) => {
        console.warn('Could not flush browser authority work after Ably recovery', error);
      });
      const revision = Number(session.getRevision?.() ?? getKnownRevision?.() ?? 0);
      onSyncRequired?.(Number.isFinite(revision) && revision >= 0 ? revision : 0);
    },
    onError: (error) => {
      console.warn('Ably board transport error', error);
      onStatus?.('CHANNEL_ERROR');
    },
  });

  Promise.resolve(session.start?.())
    .then(() => {
      if (disconnected) return;
      return Promise.resolve(transport.start?.()).catch((error) => {
        if (disconnected) return;
        console.error('Could not start Ably board transport', error);
        onStatus?.('CHANNEL_ERROR');
      });
    })
    .catch((error) => {
      if (disconnected) return;
      console.error('Could not start browser board authority session', error);
      onStatus?.('SAVE_ERROR');
    });

  return {
    ...core,
    resumeVerification: () => session.resumeVerification?.(),
    getVerificationStats: () => session.getVerificationStats?.() ?? { enabled: false },
    async disconnect() {
      if (disconnected) return;
      disconnected = true;
      await core.disconnect?.();
      session.close?.();
      await transport.disconnect?.();
    },
  };
}
