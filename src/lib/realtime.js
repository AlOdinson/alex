import { applyBoardAction, isSupabaseConfigured } from './boardRepository.js';
import {
  countPendingActions,
  enqueuePendingAction,
  getPendingActions,
  removePendingAction,
} from './idb.js';
import { randomToken } from './ids.js';
import { supabase } from './supabase.js';

// Keep live packets comfortably below typical realtime message limits.
const MAX_BROADCAST_CHARS = 48_000;
const LOCK_TTL = 7000;
const TRANSPORT_CONNECT_TIMEOUT = 10_000;

function wait(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function withTimeout(promise, milliseconds, message) {
  return Promise.race([
    promise,
    wait(milliseconds).then(() => {
      throw new Error(message);
    }),
  ]);
}

function canBroadcastOperations(ops) {
  try {
    return JSON.stringify(ops).length <= MAX_BROADCAST_CHARS;
  } catch {
    return false;
  }
}

function participantColor(clientId) {
  const palette = ['#2563eb', '#db2777', '#059669', '#d97706', '#7c3aed', '#0891b2', '#dc2626'];
  let hash = 0;
  for (const character of String(clientId)) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  return palette[Math.abs(hash) % palette.length];
}

async function commitWithRetry(commit, { attempts = 5 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      throw new Error('Нет соединения');
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      return await commit();
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) {
        // eslint-disable-next-line no-await-in-loop
        await wait(Math.min(4200, 500 * (attempt + 1)));
      }
    }
  }
  throw lastError;
}

export function connectBoardRealtime({
  boardId,
  boardKey,
  realtimeKey,
  clientId,
  name,
  permission,
  getKnownRevision,
  onOps,
  onUsers,
  onMode,
  onSettings,
  onSyncRequired,
  onCommit,
  onPendingChange,
  onStatus,
  onCursor,
  onLock,
  onTransform,
  onDraw,
  onPreview,
  onSelectionTransaction,
  onView,
  onViewJump,
  onViewRequest,
}) {
  const topic = `board:${boardId}:${realtimeKey}`;
  const color = participantColor(clientId);
  let writeQueue = Promise.resolve();
  let disconnected = false;
  let flushing = false;
  let activeWrites = 0;
  let actionSequence = 0;
  let lastCursorSignature = '';
  let lastViewSignature = '';

  let transportKind = isSupabaseConfigured ? 'pending' : 'local';
  let transportReadyResolve;
  const transportReady = new Promise((resolve) => {
    transportReadyResolve = resolve;
  });
  let transportResolved = !isSupabaseConfigured;

  let ablyClient = null;
  let ablyChannel = null;
  let supabaseChannel = null;
  let localChannel = null;
  let localHeartbeat = null;
  let ablyPresenceRefresh = Promise.resolve();

  const resolveTransport = (kind) => {
    if (transportResolved) return;
    transportResolved = true;
    transportKind = kind;
    transportReadyResolve(kind);
  };

  const updatePendingCount = async () => {
    const queued = await countPendingActions(boardId);
    onPendingChange?.(Math.max(queued, activeWrites));
  };

  const handleRealtimeEvent = (event, payload) => {
    if (!payload || payload.clientId === clientId) return;

    if (event === 'live-batch') {
      const common = {
        clientId: payload.clientId,
        name: payload.n ?? 'Участник',
        color: payload.c ?? participantColor(payload.clientId),
        permission: payload.p ?? 'view',
        timestamp: Number(payload.ts ?? Date.now()),
      };
      if (Array.isArray(payload.u) && payload.u.length >= 2) {
        onCursor?.({ ...common, x: Number(payload.u[0]), y: Number(payload.u[1]), receivedAt: Date.now() });
      }
      if (payload.t && typeof payload.t === 'object') {
        const compact = payload.t;
        const objects = Array.isArray(compact.f)
          ? compact.f.map((frame) => ({
            id: frame?.[0],
            matrix: frame?.[1],
            creationSessionId: frame?.[2] ?? null,
            creationClientId: frame?.[3] ?? null,
            objectKind: frame?.[4] ?? null,
            objectType: frame?.[5] ?? null,
            zIndex: Number(frame?.[6] ?? -1),
          }))
          : [];
        onTransform?.({
          ...common,
          sessionId: compact.s,
          sessionOrder: Number(compact.o ?? 0),
          sequence: Number(compact.q ?? 0),
          phase: compact.h ?? 'update',
          mode: compact.m ?? 'objects',
          objects,
          objectIds: compact.i ?? [],
          deltaMatrix: compact.x ?? null,
          transactionId: compact.r ?? null,
          receivedAt: Date.now(),
        });
      }
      if (Array.isArray(payload.d)) {
        payload.d.forEach((draw) => {
          if (!Array.isArray(draw)) return;
          const flatPoints = Array.isArray(draw[8]) ? draw[8] : [];
          const points = [];
          for (let index = 0; index + 1 < flatPoints.length; index += 2) {
            points.push([Number(flatPoints[index]), Number(flatPoints[index + 1])]);
          }
          const style = Array.isArray(draw[9])
            ? { stroke: draw[9][0], width: Number(draw[9][1]), opacity: Number(draw[9][2]) }
            : {};
          onDraw?.({
            ...common,
            sessionId: draw[0],
            sessionOrder: Number(draw[1] ?? 0),
            sequence: Number(draw[2] ?? 0),
            phase: draw[3] ?? 'update',
            tool: draw[4] ?? 'pencil',
            objectId: draw[5],
            from: Number(draw[6] ?? 0),
            replace: Boolean(draw[7]),
            points,
            style,
            receivedAt: Date.now(),
          });
        });
      }
      if (Array.isArray(payload.v) && payload.v.length >= 3) {
        onView?.({
          ...common,
          centerX: Number(payload.v[0]),
          centerY: Number(payload.v[1]),
          zoom: Number(payload.v[2]),
          receivedAt: Date.now(),
        });
      }
      return;
    }

    if (event === 'action') {
      onOps?.(
        Array.isArray(payload.ops) ? payload.ops : [],
        Number(payload.revision ?? 0),
        Boolean(payload.needsSync),
        payload.background ?? null,
        payload.actionId ?? null,
        payload.clientId ?? '',
      );
      return;
    }
    if (event === 'mode') onMode?.(payload.mode);
    if (event === 'settings') {
      onSettings?.(
        payload.settings ?? {},
        Number(payload.revision ?? 0),
        Boolean(payload.needsSync),
      );
    }
    if (event === 'sync') onSyncRequired?.(Number(payload.revision ?? 0));
    if (event === 'cursor') onCursor?.({ ...payload, receivedAt: Date.now() });
    if (event === 'lock') {
      onLock?.({ ...payload, expiresAt: Number(payload.expiresAt ?? Date.now() + LOCK_TTL) });
    }
    if (event === 'transform') onTransform?.({ ...payload, receivedAt: Date.now() });
    if (event === 'draw') onDraw?.({ ...payload, receivedAt: Date.now() });
    if (event === 'preview') onPreview?.({ ...payload, receivedAt: Date.now() });
    if (event === 'selection-transaction') {
      onSelectionTransaction?.({ ...payload, receivedAt: Date.now() });
    }
    if (event === 'view') onView?.({ ...payload, receivedAt: Date.now() });
    if (event === 'view-jump') onViewJump?.({ ...payload, receivedAt: Date.now() });
    if (event === 'view-request') onViewRequest?.({ ...payload, receivedAt: Date.now() });
  };

  const publishRealtime = async (event, payload) => {
    if (disconnected) return 'closed';
    if (isSupabaseConfigured && transportKind === 'pending') await transportReady;
    if (disconnected) return 'closed';

    if (transportKind === 'ably' && ablyChannel) {
      await ablyChannel.publish(event, payload);
      return 'ok';
    }

    if (transportKind === 'supabase' && supabaseChannel) {
      return supabaseChannel.send({ type: 'broadcast', event, payload });
    }

    if (transportKind === 'local' && localChannel) {
      localChannel.postMessage({ kind: event, ...payload });
      return 'ok';
    }

    return 'unavailable';
  };

  const broadcastCommittedAction = async (action, result) => {
    const includeOps = canBroadcastOperations(action.ops);
    const payload = {
      clientId,
      actionId: action.actionId,
      revision: result.revision,
      needsSync: result.needsSync || !includeOps,
      ops: includeOps ? action.ops : [],
      background: action.background ?? null,
    };

    try {
      const delivery = await publishRealtime('action', payload);
      if (!includeOps || delivery !== 'ok') {
        await publishRealtime('sync', { clientId, revision: result.revision });
      }
    } catch (error) {
      console.warn('Realtime broadcast failed after server commit', error);
    }
  };

  const commitAction = async (action, { announceSaving = true } = {}) => {
    if (disconnected) return null;
    if (announceSaving) onStatus?.('SAVING');
    activeWrites += 1;
    await updatePendingCount();
    try {
      const result = await commitWithRetry(() => applyBoardAction(boardId, boardKey, {
        actionId: action.actionId,
        clientId,
        ops: action.ops,
        background: action.background,
        knownRevision: Number(getKnownRevision?.() ?? action.knownRevision ?? 0),
      }));
      await removePendingAction(action.actionId);
      onCommit?.(result, action);
      await broadcastCommittedAction(action, result);
      onStatus?.('ACTION_CONFIRMED');
      if (result.needsSync) onSyncRequired?.(result.revision);
      return result;
    } catch (error) {
      console.error(error);
      if (typeof navigator !== 'undefined' && navigator.onLine === false) onStatus?.('OFFLINE');
      else onStatus?.('SAVE_ERROR');
      return null;
    } finally {
      activeWrites = Math.max(0, activeWrites - 1);
      await updatePendingCount();
    }
  };

  const flushPending = async () => {
    if (flushing || disconnected) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      onStatus?.('OFFLINE');
      await updatePendingCount();
      return;
    }
    flushing = true;
    onStatus?.('RECOVERING');
    try {
      const pending = await getPendingActions(boardId);
      let committedAny = false;
      let latestRevision = Number(getKnownRevision?.() ?? 0);
      for (const action of pending) {
        if (disconnected) break;
        // eslint-disable-next-line no-await-in-loop
        const result = await commitAction(action, { announceSaving: false });
        if (!result) break;
        committedAny = true;
        latestRevision = Math.max(latestRevision, Number(result.revision ?? 0));
      }
      const remaining = await countPendingActions(boardId);
      if (remaining === 0) {
        onStatus?.('RECOVERED');
        if (committedAny) onSyncRequired?.(latestRevision);
      }
    } finally {
      flushing = false;
      await updatePendingCount();
    }
  };

  const enqueueAction = (ops, background = null) => {
    const action = {
      actionId: randomToken(24),
      boardId,
      clientId,
      ops: Array.isArray(ops) ? ops : [],
      background,
      knownRevision: Number(getKnownRevision?.() ?? 0),
      createdAt: Date.now() * 1000 + (actionSequence++ % 1000),
    };

    const persisted = enqueuePendingAction(action).then(updatePendingCount);
    const task = writeQueue
      .catch(() => undefined)
      .then(() => persisted)
      .then(() => commitAction(action));
    writeQueue = task;
    return task;
  };

  const handleOnline = () => {
    onStatus?.('RECOVERING');
    flushPending();
    onSyncRequired?.(Number(getKnownRevision?.() ?? 0));
  };
  const handleOffline = () => onStatus?.('OFFLINE');
  window.addEventListener('online', handleOnline);
  window.addEventListener('offline', handleOffline);

  const startAblyTransport = async () => {
    const Ably = window.Ably;
    if (!Ably?.Realtime) throw new Error('Ably SDK did not load');

    ablyClient = new Ably.Realtime({
      clientId,
      useTokenAuth: true,
      echoMessages: false,
      authCallback: async (_tokenParams, callback) => {
        try {
          const { data, error } = await supabase.functions.invoke('ably-token', {
            body: { boardId, boardKey, clientId },
          });
          if (error) throw error;
          if (!data?.token) throw new Error('Token endpoint returned no token');
          callback(null, data);
        } catch (error) {
          console.error('Could not obtain Ably token', error);
          callback(error, null);
        }
      },
      disconnectedRetryTimeout: 5000,
      suspendedRetryTimeout: 15000,
    });

    ablyClient.connection.on((change) => {
      const state = change?.current ?? ablyClient?.connection?.state;
      if (state === 'connected' && transportKind === 'ably') onStatus?.('SUBSCRIBED');
      if (state === 'disconnected') onStatus?.('TIMED_OUT');
      if (state === 'suspended' || state === 'failed') onStatus?.('CHANNEL_ERROR');
      if (state === 'closed') onStatus?.('CLOSED');
    });

    await withTimeout(
      ablyClient.connection.once('connected'),
      TRANSPORT_CONNECT_TIMEOUT,
      'Timed out while connecting to Ably',
    );

    if (disconnected) throw new Error('Connection was closed');

    ablyChannel = ablyClient.channels.get(topic);
    await withTimeout(
      ablyChannel.subscribe((message) => {
        handleRealtimeEvent(message?.name, message?.data);
      }),
      TRANSPORT_CONNECT_TIMEOUT,
      'Timed out while attaching Ably channel',
    );

    const refreshUsers = async () => {
      if (!ablyChannel || disconnected) return;
      try {
        const members = await ablyChannel.presence.get();
        const users = new Map();
        members.forEach((member) => {
          const data = member?.data ?? {};
          const memberClientId = String(member?.clientId ?? data.clientId ?? '');
          if (!memberClientId) return;
          users.set(memberClientId, {
            clientId: memberClientId,
            name: data.name ?? 'Участник',
            permission: data.permission ?? 'view',
            color: data.color ?? participantColor(memberClientId),
          });
        });
        onUsers?.([...users.values()]);
      } catch (error) {
        if (!disconnected) console.warn('Could not refresh Ably presence', error);
      }
    };

    await ablyChannel.presence.subscribe(() => {
      ablyPresenceRefresh = ablyPresenceRefresh
        .catch(() => undefined)
        .then(refreshUsers);
    });

    await ablyChannel.presence.enter({
      clientId,
      name,
      permission,
      color,
      joinedAt: Date.now(),
    });

    resolveTransport('ably');
    await refreshUsers();
    onStatus?.('SUBSCRIBED');
    await flushPending();
    onSyncRequired?.(Number(getKnownRevision?.() ?? 0));
  };

  const startSupabaseTransport = async () => {
    if (disconnected) return;
    supabaseChannel = supabase.channel(topic, {
      config: {
        broadcast: { self: false },
        presence: { key: clientId },
      },
    });

    supabaseChannel
      .on('broadcast', { event: 'action' }, ({ payload }) => handleRealtimeEvent('action', payload))
      .on('broadcast', { event: 'mode' }, ({ payload }) => handleRealtimeEvent('mode', payload))
      .on('broadcast', { event: 'settings' }, ({ payload }) => handleRealtimeEvent('settings', payload))
      .on('broadcast', { event: 'sync' }, ({ payload }) => handleRealtimeEvent('sync', payload))
      .on('broadcast', { event: 'cursor' }, ({ payload }) => handleRealtimeEvent('cursor', payload))
      .on('broadcast', { event: 'live-batch' }, ({ payload }) => handleRealtimeEvent('live-batch', payload))
      .on('broadcast', { event: 'lock' }, ({ payload }) => handleRealtimeEvent('lock', payload))
      .on('broadcast', { event: 'transform' }, ({ payload }) => handleRealtimeEvent('transform', payload))
      .on('broadcast', { event: 'draw' }, ({ payload }) => handleRealtimeEvent('draw', payload))
      .on('broadcast', { event: 'preview' }, ({ payload }) => handleRealtimeEvent('preview', payload))
      .on('broadcast', { event: 'selection-transaction' }, ({ payload }) => handleRealtimeEvent('selection-transaction', payload))
      .on('broadcast', { event: 'view' }, ({ payload }) => handleRealtimeEvent('view', payload))
      .on('broadcast', { event: 'view-jump' }, ({ payload }) => handleRealtimeEvent('view-jump', payload))
      .on('broadcast', { event: 'view-request' }, ({ payload }) => handleRealtimeEvent('view-request', payload))
      .on('presence', { event: 'sync' }, () => {
        const state = supabaseChannel.presenceState();
        const users = Object.values(state)
          .flat()
          .map((entry) => ({
            clientId: entry.clientId,
            name: entry.name,
            permission: entry.permission,
            color: entry.color ?? participantColor(entry.clientId),
          }));
        onUsers?.(users);
      })
      .subscribe(async (status) => {
        onStatus?.(status);
        if (status === 'SUBSCRIBED') {
          resolveTransport('supabase');
          await supabaseChannel.track({ clientId, name, permission, color, joinedAt: Date.now() });
          await flushPending();
          onSyncRequired?.(Number(getKnownRevision?.() ?? 0));
        }
      });
  };

  const startLocalTransport = () => {
    localChannel = new BroadcastChannel(topic);
    const peers = new Map();
    const publishPresence = () => {
      localChannel.postMessage({
        kind: 'presence', clientId, name, permission, color, timestamp: Date.now(),
      });
    };
    const refreshUsers = () => {
      const now = Date.now();
      peers.set(clientId, { clientId, name, permission, color, timestamp: now });
      for (const [id, peer] of peers) {
        if (now - peer.timestamp > 12000) peers.delete(id);
      }
      onUsers?.([...peers.values()]);
    };

    localChannel.onmessage = ({ data }) => {
      if (!data || data.clientId === clientId) return;
      if (data.kind === 'presence') {
        peers.set(data.clientId, data);
        refreshUsers();
        return;
      }
      if (data.kind === 'leave') {
        peers.delete(data.clientId);
        refreshUsers();
        return;
      }
      handleRealtimeEvent(data.kind, data);
    };

    publishPresence();
    refreshUsers();
    onStatus?.('SUBSCRIBED');
    flushPending();
    localHeartbeat = window.setInterval(() => {
      publishPresence();
      refreshUsers();
    }, 5000);
  };

  if (isSupabaseConfigured) {
    startAblyTransport().catch(async (error) => {
      if (disconnected) return;
      console.warn('Ably unavailable; switching to Supabase Realtime fallback', error);
      try {
        ablyClient?.close();
      } catch {
        // Ignore cleanup errors during fallback.
      }
      ablyClient = null;
      ablyChannel = null;
      onStatus?.('RECOVERING');
      await startSupabaseTransport();
    });
  } else {
    startLocalTransport();
  }

  updatePendingCount();

  return {
    sendOps(ops) {
      if (!Array.isArray(ops) || !ops.length) return Promise.resolve(null);
      return enqueueAction(ops, null);
    },
    sendMode(mode) {
      return publishRealtime('mode', { clientId, mode });
    },
    sendSettings(settings) {
      return enqueueAction([], settings?.background ?? null);
    },
    sendCursor(cursor) {
      if (!Number.isFinite(Number(cursor?.x)) || !Number.isFinite(Number(cursor?.y))) {
        return Promise.resolve('ignored');
      }
      const x = Number(Number(cursor.x).toFixed(2));
      const y = Number(Number(cursor.y).toFixed(2));
      const signature = `${x}:${y}`;
      if (signature === lastCursorSignature) return Promise.resolve('duplicate');
      lastCursorSignature = signature;
      return publishRealtime('cursor', {
        clientId,
        name,
        color,
        x,
        y,
        timestamp: Date.now(),
      });
    },
    sendLock(objectIds, locked = true) {
      const payload = {
        clientId,
        name,
        color,
        objectIds: Array.isArray(objectIds) ? objectIds : [],
        locked,
        expiresAt: Date.now() + LOCK_TTL,
      };
      return publishRealtime('lock', payload);
    },
    sendTransform(transform) {
      const hasObjectFrames = Array.isArray(transform?.objects) && transform.objects.length > 0;
      const hasGroupFrame = transform?.mode === 'group'
        && Array.isArray(transform.objectIds)
        && transform.objectIds.length > 0
        && Array.isArray(transform.deltaMatrix)
        && transform.deltaMatrix.length === 6;
      if (!hasObjectFrames && !hasGroupFrame) return Promise.resolve('ignored');
      return publishRealtime('transform', {
        clientId,
        name,
        color,
        ...transform,
        timestamp: Date.now(),
      });
    },
    sendDraw(draw) {
      if (!draw || !draw.objectId || !Array.isArray(draw.points)) {
        return Promise.resolve('ignored');
      }
      if (draw.phase === 'update' && draw.points.length === 0) return Promise.resolve('ignored');
      return publishRealtime('draw', {
        clientId,
        name,
        color,
        ...draw,
        timestamp: Date.now(),
      });
    },
    sendPreview(records) {
      const safeRecords = Array.isArray(records) ? records : [];
      if (!safeRecords.length) return Promise.resolve('ignored');
      try {
        if (JSON.stringify(safeRecords).length > MAX_BROADCAST_CHARS) return Promise.resolve('too-large');
      } catch {
        return Promise.resolve('invalid');
      }
      const payload = {
        clientId,
        name,
        color,
        records: safeRecords,
        timestamp: Date.now(),
      };
      return publishRealtime('preview', payload);
    },
    sendSelectionTransaction(transaction) {
      if (!transaction?.transactionId || !['start', 'style', 'commit', 'cancel'].includes(transaction.phase)) {
        return Promise.resolve('ignored');
      }
      const payload = {
        clientId,
        name,
        color,
        ...transaction,
        timestamp: Date.now(),
      };
      return publishRealtime('selection-transaction', payload);
    },
    sendView(view) {
      const centerX = Number(Number(view?.centerX).toFixed(3));
      const centerY = Number(Number(view?.centerY).toFixed(3));
      const zoom = Number(Number(view?.zoom).toFixed(4));
      if (![centerX, centerY, zoom].every(Number.isFinite)) return Promise.resolve('ignored');
      const signature = `${centerX}:${centerY}:${zoom}`;
      if (signature === lastViewSignature) return Promise.resolve('duplicate');
      lastViewSignature = signature;
      return publishRealtime('view', {
        clientId,
        name,
        color,
        permission,
        ...view,
        centerX,
        centerY,
        zoom,
        timestamp: Date.now(),
      });
    },
    sendViewJump(view) {
      const payload = { clientId, name, color, permission, ...view, timestamp: Date.now() };
      return publishRealtime('view-jump', payload);
    },
    requestView() {
      const payload = { clientId, name, color, permission, timestamp: Date.now() };
      return publishRealtime('view-request', payload);
    },
    requestSync(revision = Number(getKnownRevision?.() ?? 0)) {
      return publishRealtime('sync', { clientId, revision });
    },
    flushPending,
    async disconnect() {
      disconnected = true;
      await writeQueue.catch(() => undefined);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);

      if (ablyChannel) {
        try {
          await ablyChannel.presence.leave();
        } catch {
          // The connection may already be closed.
        }
      }
      try {
        ablyClient?.close();
      } catch {
        // Ignore close errors.
      }

      if (supabaseChannel) {
        try {
          await supabaseChannel.untrack();
        } catch {
          // Ignore cleanup errors.
        }
        await supabase.removeChannel(supabaseChannel);
      }

      if (localChannel) {
        window.clearInterval(localHeartbeat);
        localChannel.postMessage({ kind: 'leave', clientId });
        localChannel.close();
      }
    },
  };
}
