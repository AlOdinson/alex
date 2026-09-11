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

function withTimeout(promise, milliseconds, message) {
  let timer = null;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
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

  const refreshUsers = async () => {
    if (!channel || closed) return [];
    const members = await channel.presence.get();
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

  return {
    async start() {
      if (closed) throw new Error('Ably transport is closed');
      if (!AblyRuntime?.Realtime) throw new Error('Ably SDK did not load');
      client = new AblyRuntime.Realtime({
        clientId: safeClientId,
        useTokenAuth: true,
        echoMessages: false,
        authCallback: async (_params, callback) => {
          try {
            callback(null, await tokenRequest({ boardId: safeBoardId, roomKey: safeRoomKey, clientId: safeClientId }));
          } catch (error) {
            callback(error, null);
          }
        },
        disconnectedRetryTimeout: 5000,
        suspendedRetryTimeout: 15000,
      });

      client.connection.on((change) => {
        const state = change?.current ?? client?.connection?.state;
        if (state === 'connected') {
          const shouldRecover = connectedOnce;
          connectedOnce = true;
          onStatus('SUBSCRIBED');
          if (shouldRecover) recoverContinuity('connection-reconnected');
        } else if (state === 'disconnected') onStatus('TIMED_OUT');
        else if (state === 'suspended' || state === 'failed') onStatus('CHANNEL_ERROR');
        else if (state === 'closed') onStatus('CLOSED');
      });

      await withTimeout(client.connection.once('connected'), CONNECT_TIMEOUT_MS, 'Timed out while connecting to Ably');
      connectedOnce = true;
      if (closed) throw new Error('Ably transport is closed');

      channel = client.channels.get(`board:${safeBoardId}:${safeRoomKey}`);
      channel.on?.('attached', (change) => {
        const shouldRecover = attachedOnce && change?.resumed === false;
        attachedOnce = true;
        if (shouldRecover) recoverContinuity('channel-reattached-without-continuity');
      });
      channel.on?.('update', (change) => {
        if (change?.resumed === false) recoverContinuity('channel-continuity-update');
      });

      await withTimeout(
        channel.subscribe((message) => Promise.resolve(onEvent(message?.name, message?.data)).catch(onError)),
        CONNECT_TIMEOUT_MS,
        'Timed out while attaching Ably board channel',
      );
      // A resolved subscribe means the initial attach completed. A later ATTACHED event
      // with resumed=false is therefore a real continuity loss rather than first attach.
      attachedOnce = true;
      await channel.presence.subscribe(() => {
        presenceRefresh = presenceRefresh.catch(() => undefined).then(refreshUsers).catch(onError);
      });
      await channel.presence.enter({
        clientId: safeClientId,
        name,
        permission,
        color,
        joinedAt: Date.now(),
      });
      await refreshUsers();
      onStatus('SUBSCRIBED');
      return true;
    },

    async publish(event, payload, { force = false } = {}) {
      if (closed) return 'closed';
      if (!channel) throw new Error('Ably board channel is not ready');
      if (!force && remoteParticipantCount === 0) return 'solo';
      await channel.publish(event, payload);
      return 'ok';
    },

    async refreshUsers() {
      return refreshUsers();
    },

    async disconnect() {
      if (closed) return;
      closed = true;
      if (channel) {
        try { await channel.presence.leave(); } catch { /* connection may already be closed */ }
      }
      try { client?.close?.(); } catch { /* ignore close errors */ }
      channel = null;
      client = null;
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
    boardId,
    clientId,
    permission,
    sendScreenShareSignal: (signal) => core?.sendScreenShareSignal?.(signal) ?? Promise.reject(new Error('Realtime core is not ready')),
    onAuthoritativeCommit: (commit) => onOps?.(
      Array.isArray(commit?.appliedOps) ? commit.appliedOps : (Array.isArray(commit?.ops) ? commit.ops : []),
      Number(commit?.revision ?? 0),
      Boolean(commit?.needsSync),
      commit?.appliedBackground ?? commit?.background ?? null,
      commit?.actionId ?? null,
      commit?.clientId ?? '',
    ),
    onAuthoritativeSnapshot: (_snapshot, revision) => onSyncRequired?.(Number(revision ?? 0)),
    onPeerState: (state) => {
      if (state === 'failed' || state === 'disconnected') onStatus?.('RECOVERING');
      if (state === 'connected') onStatus?.('RECOVERED');
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
    onPendingChange,
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

  Promise.resolve(session.start?.()).catch((error) => {
    console.error('Could not start browser board authority session', error);
    onStatus?.('SAVE_ERROR');
  });
  Promise.resolve(transport.start?.()).catch((error) => {
    console.error('Could not start Ably board transport', error);
    onStatus?.('CHANNEL_ERROR');
  });

  return {
    ...core,
    async disconnect() {
      if (disconnected) return;
      disconnected = true;
      await core.disconnect?.();
      session.close?.();
      await transport.disconnect?.();
    },
  };
}
