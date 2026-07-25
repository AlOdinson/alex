import { applyBoardAction, isSupabaseConfigured } from './boardRepository.js';
import {
  countPendingActions,
  enqueuePendingAction,
  getPendingActions,
  removePendingAction,
} from './idb.js';
import { randomToken } from './ids.js';
import { supabase } from './supabase.js';

const MAX_BROADCAST_CHARS = 120_000;
const LOCK_TTL = 7000;

function wait(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
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
  let channel = null;

  const updatePendingCount = async () => {
    const queued = await countPendingActions(boardId);
    onPendingChange?.(Math.max(queued, activeWrites));
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

    if (isSupabaseConfigured) {
      try {
        const delivery = await channel?.send({ type: 'broadcast', event: 'action', payload });
        if (!includeOps || delivery !== 'ok') {
          await channel?.send({
            type: 'broadcast',
            event: 'sync',
            payload: { clientId, revision: result.revision },
          });
        }
      } catch (error) {
        console.warn('Realtime broadcast failed after server commit', error);
      }
      return;
    }

    channel?.postMessage({ kind: 'action', ...payload });
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

  if (isSupabaseConfigured) {
    channel = supabase.channel(topic, {
      config: {
        broadcast: { self: false },
        presence: { key: clientId },
      },
    });

    channel
      .on('broadcast', { event: 'action' }, ({ payload }) => {
        if (!payload || payload.clientId === clientId) return;
        onOps?.(
          Array.isArray(payload.ops) ? payload.ops : [],
          Number(payload.revision ?? 0),
          Boolean(payload.needsSync),
          payload.background ?? null,
          payload.actionId ?? null,
          payload.clientId ?? '',
        );
      })
      .on('broadcast', { event: 'mode' }, ({ payload }) => {
        if (payload?.clientId !== clientId) onMode?.(payload?.mode);
      })
      .on('broadcast', { event: 'settings' }, ({ payload }) => {
        if (!payload || payload.clientId === clientId) return;
        onSettings?.(
          payload.settings ?? {},
          Number(payload.revision ?? 0),
          Boolean(payload.needsSync),
        );
      })
      .on('broadcast', { event: 'sync' }, ({ payload }) => {
        if (!payload || payload.clientId === clientId) return;
        onSyncRequired?.(Number(payload.revision ?? 0));
      })
      .on('broadcast', { event: 'cursor' }, ({ payload }) => {
        if (!payload || payload.clientId === clientId) return;
        onCursor?.({ ...payload, receivedAt: Date.now() });
      })
      .on('broadcast', { event: 'lock' }, ({ payload }) => {
        if (!payload || payload.clientId === clientId) return;
        onLock?.({ ...payload, expiresAt: Number(payload.expiresAt ?? Date.now() + LOCK_TTL) });
      })
      .on('broadcast', { event: 'transform' }, ({ payload }) => {
        if (!payload || payload.clientId === clientId) return;
        onTransform?.({ ...payload, receivedAt: Date.now() });
      })
      .on('broadcast', { event: 'draw' }, ({ payload }) => {
        if (!payload || payload.clientId === clientId) return;
        onDraw?.({ ...payload, receivedAt: Date.now() });
      })
      .on('broadcast', { event: 'preview' }, ({ payload }) => {
        if (!payload || payload.clientId === clientId) return;
        onPreview?.({ ...payload, receivedAt: Date.now() });
      })
      .on('broadcast', { event: 'selection-transaction' }, ({ payload }) => {
        if (!payload || payload.clientId === clientId) return;
        onSelectionTransaction?.({ ...payload, receivedAt: Date.now() });
      })
      .on('broadcast', { event: 'view' }, ({ payload }) => {
        if (!payload || payload.clientId === clientId) return;
        onView?.({ ...payload, receivedAt: Date.now() });
      })
      .on('broadcast', { event: 'view-jump' }, ({ payload }) => {
        if (!payload || payload.clientId === clientId) return;
        onViewJump?.({ ...payload, receivedAt: Date.now() });
      })
      .on('broadcast', { event: 'view-request' }, ({ payload }) => {
        if (!payload || payload.clientId === clientId) return;
        onViewRequest?.({ ...payload, receivedAt: Date.now() });
      })
      .on('presence', { event: 'sync' }, () => {
        const state = channel.presenceState();
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
          await channel.track({ clientId, name, permission, color, joinedAt: Date.now() });
          await flushPending();
          onSyncRequired?.(Number(getKnownRevision?.() ?? 0));
        }
      });
  } else {
    channel = new BroadcastChannel(topic);
    const peers = new Map();
    const publishPresence = () => {
      channel.postMessage({
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

    channel.onmessage = ({ data }) => {
      if (!data || data.clientId === clientId) return;
      if (data.kind === 'action') {
        onOps?.(data.ops ?? [], Number(data.revision ?? 0), Boolean(data.needsSync), data.background ?? null, data.actionId ?? null, data.clientId ?? '');
      }
      if (data.kind === 'mode') onMode?.(data.mode);
      if (data.kind === 'settings') onSettings?.(data.settings ?? {}, Number(data.revision ?? 0), Boolean(data.needsSync));
      if (data.kind === 'sync') onSyncRequired?.(Number(data.revision ?? 0));
      if (data.kind === 'cursor') onCursor?.({ ...data, receivedAt: Date.now() });
      if (data.kind === 'lock') onLock?.({ ...data, expiresAt: Number(data.expiresAt ?? Date.now() + LOCK_TTL) });
      if (data.kind === 'transform') onTransform?.({ ...data, receivedAt: Date.now() });
      if (data.kind === 'draw') onDraw?.({ ...data, receivedAt: Date.now() });
      if (data.kind === 'preview') onPreview?.({ ...data, receivedAt: Date.now() });
      if (data.kind === 'selection-transaction') onSelectionTransaction?.({ ...data, receivedAt: Date.now() });
      if (data.kind === 'view') onView?.({ ...data, receivedAt: Date.now() });
      if (data.kind === 'view-jump') onViewJump?.({ ...data, receivedAt: Date.now() });
      if (data.kind === 'view-request') onViewRequest?.({ ...data, receivedAt: Date.now() });
      if (data.kind === 'presence') {
        peers.set(data.clientId, data);
        refreshUsers();
      }
      if (data.kind === 'leave') {
        peers.delete(data.clientId);
        refreshUsers();
      }
    };

    publishPresence();
    refreshUsers();
    onStatus?.('SUBSCRIBED');
    flushPending();
    const heartbeat = window.setInterval(() => {
      publishPresence();
      refreshUsers();
    }, 5000);
    channel.__heartbeat = heartbeat;
  }

  updatePendingCount();

  return {
    sendOps(ops) {
      if (!Array.isArray(ops) || !ops.length) return Promise.resolve(null);
      return enqueueAction(ops, null);
    },
    sendMode(mode) {
      if (isSupabaseConfigured) {
        return channel.send({ type: 'broadcast', event: 'mode', payload: { clientId, mode } });
      }
      channel.postMessage({ kind: 'mode', clientId, mode });
      return Promise.resolve('ok');
    },
    sendSettings(settings) {
      return enqueueAction([], settings?.background ?? null);
    },
    sendCursor(cursor) {
      const payload = { clientId, name, color, ...cursor, timestamp: Date.now() };
      if (isSupabaseConfigured) {
        return channel.send({ type: 'broadcast', event: 'cursor', payload });
      }
      channel.postMessage({ kind: 'cursor', ...payload });
      return Promise.resolve('ok');
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
      if (isSupabaseConfigured) {
        return channel.send({ type: 'broadcast', event: 'lock', payload });
      }
      channel.postMessage({ kind: 'lock', ...payload });
      return Promise.resolve('ok');
    },
    sendTransform(transform) {
      const hasObjectFrames = Array.isArray(transform?.objects) && transform.objects.length > 0;
      const hasGroupFrame = transform?.mode === 'group'
        && Array.isArray(transform.objectIds)
        && transform.objectIds.length > 0
        && Array.isArray(transform.deltaMatrix)
        && transform.deltaMatrix.length === 6;
      if (!hasObjectFrames && !hasGroupFrame) return Promise.resolve('ignored');
      const payload = {
        clientId,
        name,
        color,
        ...transform,
        timestamp: Date.now(),
      };
      if (isSupabaseConfigured) {
        return channel.send({ type: 'broadcast', event: 'transform', payload });
      }
      channel.postMessage({ kind: 'transform', ...payload });
      return Promise.resolve('ok');
    },
    sendDraw(draw) {
      if (!draw || !draw.objectId || !Array.isArray(draw.points) || !draw.points.length) {
        return Promise.resolve('ignored');
      }
      const payload = {
        clientId,
        name,
        color,
        ...draw,
        timestamp: Date.now(),
      };
      if (isSupabaseConfigured) {
        return channel.send({ type: 'broadcast', event: 'draw', payload });
      }
      channel.postMessage({ kind: 'draw', ...payload });
      return Promise.resolve('ok');
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
      if (isSupabaseConfigured) {
        return channel.send({ type: 'broadcast', event: 'preview', payload });
      }
      channel.postMessage({ kind: 'preview', ...payload });
      return Promise.resolve('ok');
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
      if (isSupabaseConfigured) {
        return channel.send({ type: 'broadcast', event: 'selection-transaction', payload });
      }
      channel.postMessage({ kind: 'selection-transaction', ...payload });
      return Promise.resolve('ok');
    },
    sendView(view) {
      const payload = { clientId, name, color, permission, ...view, timestamp: Date.now() };
      if (isSupabaseConfigured) {
        return channel.send({ type: 'broadcast', event: 'view', payload });
      }
      channel.postMessage({ kind: 'view', ...payload });
      return Promise.resolve('ok');
    },
    sendViewJump(view) {
      const payload = { clientId, name, color, permission, ...view, timestamp: Date.now() };
      if (isSupabaseConfigured) {
        return channel.send({ type: 'broadcast', event: 'view-jump', payload });
      }
      channel.postMessage({ kind: 'view-jump', ...payload });
      return Promise.resolve('ok');
    },
    requestView() {
      const payload = { clientId, name, color, permission, timestamp: Date.now() };
      if (isSupabaseConfigured) {
        return channel.send({ type: 'broadcast', event: 'view-request', payload });
      }
      channel.postMessage({ kind: 'view-request', ...payload });
      return Promise.resolve('ok');
    },
    requestSync(revision = Number(getKnownRevision?.() ?? 0)) {
      if (isSupabaseConfigured) {
        return channel.send({
          type: 'broadcast', event: 'sync', payload: { clientId, revision },
        });
      }
      channel.postMessage({ kind: 'sync', clientId, revision });
      return Promise.resolve('ok');
    },
    flushPending,
    async disconnect() {
      await writeQueue.catch(() => undefined);
      disconnected = true;
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      if (isSupabaseConfigured) {
        await channel.untrack();
        await supabase.removeChannel(channel);
      } else {
        clearInterval(channel.__heartbeat);
        channel.postMessage({ kind: 'leave', clientId });
        channel.close();
      }
    },
  };
}
