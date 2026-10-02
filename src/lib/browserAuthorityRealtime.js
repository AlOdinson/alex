import { createBrowserBoardSession } from './browserBoardSession.js';
import { createBrowserAuthorityRealtimeCore } from './browserAuthorityRealtimeCore.js';
import { supabase } from './supabase.js';
import { createLiveTransportRouter } from './liveTransportRouter.js';
import {
  COLLABORATION_LIVE_CAPABILITIES,
  normalizeCollaborationCapabilities,
} from './collaborationTransportFlags.js';

const CONNECT_TIMEOUT_MS = 10_000;
const LOCK_TTL = 12_000;
const ABLY_SIGNAL_EVENT = 'screen-share-signal';

import { CONNECTION_PROGRESS_EVENT, updateConnectionProgress } from './connectionProgress.js';
let defaultAblyRuntimePromise = null;

async function loadDefaultAblyRuntime() {
  if (!defaultAblyRuntimePromise) {
    defaultAblyRuntimePromise = import('ably')
      .then((module) => {
        const loaded = module?.Realtime ? module : module?.default;
        if (!loaded?.Realtime) throw new Error('Ably SDK did not load');
        return loaded;
      })
      .catch((error) => {
        // A transient chunk/network failure must not poison every later reconnect.
        defaultAblyRuntimePromise = null;
        throw error;
      });
  }
  return defaultAblyRuntimePromise;
}

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
  source = 'ably',
} = {}) {
  if (!payload || String(payload.clientId ?? '') === String(localClientId ?? '')) return false;
  // Ably is strictly the connection-assistance plane: presence is handled by the
  // transport itself and the only channel publication we accept is WebRTC signaling.
  // Board live/control/durable events are never consumed from Ably.
  if (source === 'ably' && event !== ABLY_SIGNAL_EVENT) return false;

  // Durable board state never arrives through Ably in browser-authority mode.
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
  capabilities = null,
  authorityReady = permission !== 'owner',
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
  loadAblyRuntime = loadDefaultAblyRuntime,
} = {}) {
  const safeBoardId = String(boardId ?? '').trim();
  const safeRoomKey = String(roomKey ?? '').trim();
  const safeClientId = String(clientId ?? '').trim();
  const safeCapabilities = capabilities && typeof capabilities === 'object'
    ? normalizeCollaborationCapabilities(capabilities)
    : null;
  if (!safeBoardId || !safeRoomKey || !safeClientId) throw new Error('Ably board identity is incomplete');

  let presenceState = {
    clientId: safeClientId,
    name,
    permission,
    color,
    authorityReady: Boolean(authorityReady),
    ...(safeCapabilities ? { capabilities: safeCapabilities } : {}),
  };
  let joinedAt = 0;

  let resolvedAblyRuntime = AblyRuntime;
  const resolveAblyRuntime = async () => {
    if (resolvedAblyRuntime?.Realtime) return resolvedAblyRuntime;
    if (typeof loadAblyRuntime !== 'function') throw new Error('Ably SDK loader is unavailable');
    const loaded = await loadAblyRuntime();
    const nextRuntime = loaded?.Realtime ? loaded : loaded?.default;
    if (!nextRuntime?.Realtime) throw new Error('Ably SDK did not load');
    resolvedAblyRuntime = nextRuntime;
    return resolvedAblyRuntime;
  };

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
        authorityReady: data.authorityReady !== false,
        color: data.color ?? participantColor(memberClientId),
        capabilities: normalizeCollaborationCapabilities(data.capabilities),
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
    const runtime = await resolveAblyRuntime();
    const attemptClient = new runtime.Realtime({
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
    joinedAt ||= Date.now();
    await withTimeout(attemptChannel.presence.enter({
      ...presenceState,
      joinedAt,
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
      if (String(event ?? '') !== ABLY_SIGNAL_EVENT) return 'blocked-board-event';
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

    async updatePresence(patch = {}) {
      if (closed) return 'closed';
      const source = patch && typeof patch === 'object' ? patch : {};
      presenceState = {
        ...presenceState,
        ...(Object.hasOwn(source, 'authorityReady') ? { authorityReady: Boolean(source.authorityReady) } : {}),
      };
      if (!channel?.presence?.update) return channel ? 'unsupported' : 'starting';
      joinedAt ||= Date.now();
      await withTimeout(channel.presence.update({
        ...presenceState,
        joinedAt,
      }), CONNECT_TIMEOUT_MS, 'Timed out while updating Ably board presence', lifetime.signal);
      return closed ? 'closed' : 'ok';
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
    webrtcLiveV1 = false,
    enableNotebookOperations = false,
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
  const localCapabilities = webrtcLiveV1 ? COLLABORATION_LIVE_CAPABILITIES : null;
  let transport = null;
  let core = null;
  let session = null;
  let liveRouter = null;
  let controlRouter = null;
  let disconnected = false;
  let desiredOwnerReady = false;
  let presenceVersion = 0;
  let presenceTask = null;
  let presenceRetryTimer = null;
  let presenceFailures = 0;
  const reconcileOwnerPresence = () => {
    if (disconnected || permission !== 'owner' || !transport?.updatePresence) return Promise.resolve();
    clearTimeout(presenceRetryTimer); presenceRetryTimer = null;
    if (presenceTask) return presenceTask;
    const version = presenceVersion;
    presenceTask = Promise.resolve().then(() => transport.updatePresence({ authorityReady: desiredOwnerReady }))
      .then((result) => {
        if (result === 'starting') throw new Error('Presence is still starting');
        presenceFailures = 0;
      }).catch(() => {
        if (disconnected || presenceFailures >= 5) return;
        const delay = Math.min(15000, 1000 * (2 ** presenceFailures++));
        presenceRetryTimer = setTimeout(reconcileOwnerPresence, delay);
        presenceRetryTimer?.unref?.();
      }).finally(() => {
        presenceTask = null;
        if (!disconnected && version !== presenceVersion) reconcileOwnerPresence();
      });
    return presenceTask;
  };
  const setOwnerReady = (ready) => {
    if (permission !== 'owner' || disconnected) return;
    if (desiredOwnerReady !== Boolean(ready)) {
      desiredOwnerReady = Boolean(ready); presenceVersion += 1; presenceFailures = 0;
    }
    reconcileOwnerPresence();
  };
  let progress = updateConnectionProgress(null);
  const connectionEvents = [];
  const recordConnection = (kind, fields = {}) => {
    const event = { at: Date.now(), kind };
    for (const key of ['step','detail','path','state','attempt','errorCode']) {
      if (typeof fields[key] === 'string' || typeof fields[key] === 'number') event[key] = fields[key];
    }
    connectionEvents.push(event);
    if (connectionEvents.length > 100) connectionEvents.shift();
  };
  const onProgress = (event) => {
    if (disconnected || permission === 'owner') return;
    progress = updateConnectionProgress(progress, event);
    recordConnection('progress', progress);
    try {
      if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(CONNECTION_PROGRESS_EVENT, {
        detail: { ...progress, boardId, permission },
      }));
    } catch { /* optional loading indicator */ }
  };
  onProgress(progress);

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

  session = createSession({
    enableNotebookOperations,
    onProgress,
    onRuntimeState: (state) => { recordConnection('runtime', {state}); setOwnerReady(state === 'ready'); },
    offlineCacheKey: realtimeKey,
    boardId,
    clientId,
    permission,
    webrtcLiveV1,
    localCapabilities,
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
    onLiveEvent: (event, payload) => routeBrowserRealtimeEvent(event, payload, {
      localClientId: clientId,
      session,
      callbacks,
      source: 'webrtc-live',
    }),
    onLiveState: (state) => {
      if (state === 'open') onStatus?.('LIVE_CONNECTED');
      else if (state === 'closed' || state === 'error') onStatus?.('LIVE_DEGRADED');
    },
    onBoardControl: (event, payload) => routeBrowserRealtimeEvent(event, payload, {
      localClientId: clientId,
      session,
      callbacks,
      source: 'webrtc-control',
    }),
    onPeerState: (peerOrState, ownerPeerState) => {
      const peerState = String(ownerPeerState ?? peerOrState ?? '');
      recordConnection('peer', {state: peerState});
      if (peerState === 'failed' || peerState === 'closed' || peerState === 'disconnected' || peerState === 'recovering') {
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

  liveRouter = createLiveTransportRouter({
    enabled: Boolean(webrtcLiveV1),
    sendWebRtcLive: (event, payload, options) => session?.sendLive?.(event, payload, options) ?? 'unavailable',
  });

  controlRouter = createLiveTransportRouter({
    enabled: Boolean(webrtcLiveV1),
    sendWebRtcLive: (event, payload) => session?.sendBoardControl?.(event, payload) ?? 'unavailable',
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
    publishLive: (event, payload, publishOptions) => liveRouter.send(event, payload, publishOptions),
    publishControl: (event, payload, publishOptions) => controlRouter.send(event, payload, publishOptions),
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
    capabilities: localCapabilities,
    authorityReady: permission !== 'owner',
    color,
    onEvent: (event, payload) => routeBrowserRealtimeEvent(event, payload, {
      localClientId: clientId,
      session,
      callbacks,
      source: 'ably',
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
      presenceFailures = 0;
      reconcileOwnerPresence();
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

  // Presence/signaling must not be blocked behind owner IndexedDB/Web-Lock startup.
  // Owners enter as authorityReady=false; students ignore them as authoritative
  // teachers until session.start() succeeds and presence is promoted to ready.
  Promise.resolve(transport.start?.()).catch((error) => {
    if (disconnected) return;
    console.error('Could not start Ably board transport', error);
    onStatus?.('CHANNEL_ERROR');
  });

  Promise.resolve(session.start?.())
    .then(() => {
      if (disconnected || permission !== 'owner') return;
      setOwnerReady(typeof session.getRuntimeState === 'function' ? session.getRuntimeState() === 'ready' : true);
    })
    .catch((error) => {
      if (disconnected) return;
      console.error('Could not start browser board authority session', error);
      onStatus?.('SAVE_ERROR');
    });

  let wakeTask = null;
  let lastWake = 0;
  return {
    ...core,
    getNotebookVersion: () => session.getNotebookVersion?.() ?? 0,
    getNotebookCheckpoint: () => session.getNotebookCheckpoint?.() ?? null,
    whenRuntimeReady: () => session.whenRuntimeReady?.(),
    recoverConnections() {
      if (disconnected) return Promise.resolve();
      if (wakeTask) return wakeTask;
      if (Date.now() - lastWake < 2000) return Promise.resolve();
      lastWake = Date.now(); recordConnection('wake');
      reconcileOwnerPresence();
      wakeTask = Promise.allSettled([Promise.resolve(session.recoverConnections?.()), Promise.resolve(transport.refreshUsers?.())])
        .finally(() => { wakeTask = null; });
      return wakeTask;
    },
    async getConnectionDiagnostics() {
      return { progress: { ...progress }, events: connectionEvents.map(event => ({ ...event })),
        peers: await session.getConnectionDiagnostics?.() ?? [] };
    },
    ensureMediaAsset: assetId => session.ensureMediaAsset(assetId),
    requestMediaAsset: (assetId, options) => session.requestMediaAsset(assetId, options),
    resumeVerification: () => session.resumeVerification?.(),
    getVerificationStats: () => session.getVerificationStats?.() ?? { enabled: false },
    getTransportDiagnostics() {
      const revision = Number(session?.getRevision?.() ?? getKnownRevision?.() ?? 0);
      return {
        revision: Number.isFinite(revision) && revision >= 0 ? revision : 0,
        routing: session?.getLiveRoutingState?.() ?? {
          enabled: Boolean(webrtcLiveV1),
          hasWebRtcLivePeers: false,
          hasLegacyPeers: false,
        },
        liveRouting: liveRouter?.stats?.() ?? null,
        controlRouting: controlRouter?.stats?.() ?? null,
      };
    },
    async disconnect() {
      if (disconnected) return;
      disconnected = true;
      clearTimeout(presenceRetryTimer);
      liveRouter?.close?.();
      controlRouter?.close?.();
      await core.disconnect?.();
      session.close?.();
      await transport.disconnect?.();
    },
  };
}
