import { applyBoardActionBatch, isSupabaseConfigured } from './boardRepository.js';
import {
  confirmPendingActions,
  countPendingActions,
  enqueuePendingAction,
  getOldestPendingActions,
  getPendingActions,
  removePendingActions,
} from './idb.js';
import { randomToken } from './ids.js';
import { supabase } from './supabase.js';

// Keep live packets comfortably below typical realtime message limits.
const MAX_BROADCAST_CHARS = 48_000;
const LOCK_TTL = 7000;
const TRANSPORT_CONNECT_TIMEOUT = 10_000;
const PERSIST_BATCH_DELAY = 60;
const PERSIST_BATCH_LIMIT = 32;
const PERSIST_BATCH_MAX_BYTES = 700_000;
const PENDING_UI_INTERVAL = 250;
const SOLO_REALTIME_GRACE_MS = 3000;
const NORMAL_COMMIT_TIMEOUT = 45_000;
const LARGE_COMMIT_TIMEOUT = 120_000;

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



function estimateActionBytes(value) {
  try {
    return JSON.stringify(value).length * 2;
  } catch {
    return PERSIST_BATCH_MAX_BYTES;
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
  onBackgroundLive,
  onSyncRequired,
  onCommit,
  onPendingChange,
  onStatus,
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
}) {
  const topic = `board:${boardId}:${realtimeKey}`;
  const color = participantColor(clientId);
  let disconnected = false;
  let drainingWrites = false;
  let writesPaused = false;
  let drainPromise = Promise.resolve();
  let writeFlushTimer = null;
  let actionSequence = 0;
  let pendingCount = 0;
  let pendingUiTimer = null;
  let pendingUiLastAt = 0;
  const inMemoryPending = new Map();
  const actionWaiters = new Map();
  let lastCursorSignature = '';
  let lastViewSignature = '';
  let participantCount = 1;
  let realtimeFanoutEnabled = false;
  let soloRealtimeTimer = null;

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

  const enableRealtimeFanout = () => {
    if (realtimeFanoutEnabled || disconnected) return;
    realtimeFanoutEnabled = true;
    lastCursorSignature = '';
    lastViewSignature = '';

    // A newly joined participant loads the durable board from Supabase. Flush any
    // local writes first, then ask connected peers to verify their revision once.
    Promise.resolve()
      .then(() => flushPending())
      .then(() => {
        if (!disconnected && participantCount > 1) {
          return publishRealtime('sync', {
            clientId,
            revision: Number(getKnownRevision?.() ?? 0),
          });
        }
        return null;
      })
      .catch((error) => {
        if (!disconnected) console.warn('Could not start collaborative realtime fanout', error);
      });
  };

  const disableRealtimeFanout = () => {
    realtimeFanoutEnabled = false;
    lastCursorSignature = '';
    lastViewSignature = '';
  };

  const emitUsers = (users) => {
    const uniqueUsers = new Map();
    (Array.isArray(users) ? users : []).forEach((user) => {
      const id = String(user?.clientId ?? '');
      if (id) uniqueUsers.set(id, user);
    });

    const nextUsers = [...uniqueUsers.values()];
    participantCount = Math.max(1, nextUsers.length);
    onUsers?.(nextUsers);

    if (participantCount > 1) {
      window.clearTimeout(soloRealtimeTimer);
      soloRealtimeTimer = null;
      enableRealtimeFanout();
      return;
    }

    // Keep realtime active briefly after a peer disappears so a short mobile
    // reconnect does not repeatedly switch the board between solo and shared modes.
    if (!realtimeFanoutEnabled || soloRealtimeTimer) return;
    soloRealtimeTimer = window.setTimeout(() => {
      soloRealtimeTimer = null;
      if (!disconnected && participantCount <= 1) disableRealtimeFanout();
    }, SOLO_REALTIME_GRACE_MS);
  };

  const getAllPendingActions = async () => {
    // Full reads are intentionally reserved for reload recovery and explicit board copy.
    // The hot write path below always uses a bounded IndexedDB cursor.
    const persisted = await getPendingActions(boardId);
    const merged = new Map(persisted.map((action) => [action.actionId, action]));
    inMemoryPending.forEach((action, actionId) => merged.set(actionId, action));
    return [...merged.values()].sort(
      (a, b) => Number(a.createdAt ?? 0) - Number(b.createdAt ?? 0),
    );
  };

  const emitPendingCount = (force = false) => {
    const now = Date.now();
    const publish = () => {
      pendingUiTimer = null;
      pendingUiLastAt = Date.now();
      onPendingChange?.(Math.max(0, pendingCount));
    };
    if (force || now - pendingUiLastAt >= PENDING_UI_INTERVAL) {
      window.clearTimeout(pendingUiTimer);
      publish();
      return;
    }
    if (!pendingUiTimer) pendingUiTimer = window.setTimeout(publish, PENDING_UI_INTERVAL);
  };

  const initializePendingCount = async () => {
    const persistedCount = await countPendingActions(boardId);
    pendingCount = Math.max(pendingCount, persistedCount);
    emitPendingCount(true);
  };
  const pendingReadyPromise = initializePendingCount();

  const getNextPendingBatch = async () => {
    const persisted = await getOldestPendingActions(
      boardId,
      PERSIST_BATCH_LIMIT,
      PERSIST_BATCH_MAX_BYTES,
    );
    if (persisted.length) return persisted;
    // IndexedDB can be unavailable in private mode. Only then use the volatile map.
    return [...inMemoryPending.values()]
      .sort((a, b) => Number(a.createdAt ?? 0) - Number(b.createdAt ?? 0))
      .slice(0, PERSIST_BATCH_LIMIT);
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

    if (event === 'actions') {
      const items = Array.isArray(payload.actions) ? payload.actions : [];
      Promise.resolve().then(async () => {
        for (const item of items) {
          // Revisions in one transport packet are still separate logical actions.
          // Await each apply so the next revision never looks like a journal gap.
          // eslint-disable-next-line no-await-in-loop
          await onOps?.(
            Array.isArray(item.ops) ? item.ops : [],
            Number(item.revision ?? 0),
            Boolean(item.needsSync),
            item.background ?? null,
            item.actionId ?? null,
            payload.clientId ?? item.clientId ?? '',
          );
        }
      }).catch((error) => {
        console.warn('Could not apply realtime action batch', error);
        onSyncRequired?.(Number(items.at(-1)?.revision ?? 0));
      });
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
    if (event === 'background-live') onBackgroundLive?.(payload.background);
    if (event === 'sync') onSyncRequired?.(Number(payload.revision ?? 0));
    if (event === 'cursor') onCursor?.({ ...payload, receivedAt: Date.now() });
    if (event === 'lock') {
      onLock?.({ ...payload, expiresAt: Number(payload.expiresAt ?? Date.now() + LOCK_TTL) });
    }
    if (event === 'transform') onTransform?.({ ...payload, receivedAt: Date.now() });
    if (event === 'draw') onDraw?.({ ...payload, receivedAt: Date.now() });
    if (event === 'preview') onPreview?.({ ...payload, receivedAt: Date.now() });
    if (event === 'object-live') onObjectLive?.({ ...payload, receivedAt: Date.now() });
    if (event === 'delete-preview') onDeletePreview?.({ ...payload, receivedAt: Date.now() });
    if (event === 'selection-transaction') {
      onSelectionTransaction?.({ ...payload, receivedAt: Date.now() });
    }
    if (event === 'view') onView?.({ ...payload, receivedAt: Date.now() });
    if (event === 'view-jump') onViewJump?.({ ...payload, receivedAt: Date.now() });
    if (event === 'view-request') onViewRequest?.({ ...payload, receivedAt: Date.now() });
    if (event === 'game-library-visibility') {
      onGameLibraryVisibility?.({ ...payload, visible: Boolean(payload.visible), receivedAt: Date.now() });
    }
  };

  const publishRealtime = async (event, payload, { force = false } = {}) => {
    if (disconnected) return 'closed';

    // With no remote participant, Fabric continues rendering locally at full FPS
    // and durable operations still go to Supabase, but transient board packets are
    // not published. Presence itself is handled directly by the transport below.
    if (!force && !realtimeFanoutEnabled) return 'solo';

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

  const mergeAppliedOpsWithClientIntent = (actionOps, appliedOps) => {
    const requestedOps = Array.isArray(actionOps) ? actionOps : [];
    const authoritativeOps = Array.isArray(appliedOps) ? appliedOps : [];
    if (!authoritativeOps.length) return requestedOps;

    const requestedUpserts = new Map(requestedOps
      .filter((op) => op?.type === 'upsert' && op.object?.boardObjectId)
      .map((op) => [String(op.object.boardObjectId), op]));

    return authoritativeOps.map((op) => {
      if (op?.type !== 'upsert' || !op.object?.boardObjectId) return op;
      const requested = requestedUpserts.get(String(op.object.boardObjectId));
      if (!requested) return op;
      return {
        ...op,
        // These flags describe how receiving clients must apply an authoritative
        // upsert. Some server RPC versions normalize applied_ops and omit them.
        // Losing `restore` leaves a delete tombstone active on every other client,
        // so an Undo appears only on the device that performed it.
        restore: Boolean(op.restore || requested.restore),
        reorder: Boolean(op.reorder || requested.reorder),
        preserveOrder: Boolean(op.preserveOrder || requested.preserveOrder),
      };
    });
  };

  const broadcastCommittedActions = async (actions, results) => {
    const items = actions.map((action, index) => {
      const result = results[index] ?? {};
      const rejected = Array.isArray(result.rejectedObjectIds)
        && result.rejectedObjectIds.length > 0;
      const ops = rejected
        ? []
        : mergeAppliedOpsWithClientIntent(action.ops, result.appliedOps);
      return {
        actionId: action.actionId,
        revision: result.revision,
        needsSync: Boolean(result.needsSync) || rejected,
        ops,
        background: result.appliedBackground ?? action.background ?? null,
      };
    });
    let includeOps = true;
    try {
      includeOps = JSON.stringify(items).length <= MAX_BROADCAST_CHARS;
    } catch {
      includeOps = false;
    }
    const latestRevision = Math.max(0, ...results.map((result) => Number(result?.revision ?? 0)));
    try {
      const delivery = await publishRealtime('actions', {
        clientId,
        actions: includeOps ? items : items.map((item) => ({
          actionId: item.actionId,
          revision: item.revision,
          needsSync: true,
          ops: [],
          background: null,
        })),
      });
      if (delivery === 'solo') return;
      if (!includeOps || delivery !== 'ok') {
        await publishRealtime('sync', { clientId, revision: latestRevision });
      }
    } catch (error) {
      console.warn('Realtime batch broadcast failed after server commit', error);
    }
  };

  const resolveActionWaiter = (action, result) => {
    const waiter = actionWaiters.get(action.actionId);
    actionWaiters.delete(action.actionId);
    waiter?.resolve?.(result);
  };

  const commitActionBatch = async (actions, { announceSaving = true } = {}) => {
    if (disconnected || writesPaused || !actions.length) return null;
    if (announceSaving) onStatus?.('SAVING');
    try {
      const batchBytes = actions.reduce(
        (total, action) => total + Math.max(0, Number(action?.byteSize ?? 0)),
        0,
      );
      const commitTimeout = batchBytes > 400_000
        ? LARGE_COMMIT_TIMEOUT
        : NORMAL_COMMIT_TIMEOUT;
      const resultRows = await commitWithRetry(() => withTimeout(
        applyBoardActionBatch(
          boardId,
          boardKey,
          actions.map((action) => ({ ...action, clientId })),
          Number(getKnownRevision?.() ?? 0),
        ),
        commitTimeout,
        'Сервер слишком долго подтверждает очередь изменений',
      ), { attempts: 3 });
      const rows = Array.isArray(resultRows) ? resultRows : [];
      const byId = new Map(rows.map((result) => [result.actionId, result]));
      const processedActions = [];
      const results = [];
      for (const action of actions) {
        const result = byId.get(action.actionId);
        if (!result) break;
        processedActions.push(action);
        results.push(result);
      }
      if (!processedActions.length) throw new Error('Сервер не подтвердил ни одного действия пакета');

      const finalResult = results[results.length - 1];
      const stoppedOnRejection = Array.isArray(finalResult?.rejectedObjectIds)
        && finalResult.rejectedObjectIds.length > 0;
      if (processedActions.length < actions.length && !stoppedOnRejection) {
        throw new Error('Сервер вернул неполное подтверждение пакета');
      }

      const confirmedEntries = [];
      const rejectedIds = [];
      processedActions.forEach((action, index) => {
        const result = results[index];
        inMemoryPending.delete(action.actionId);
        if (Array.isArray(result?.rejectedObjectIds) && result.rejectedObjectIds.length) {
          rejectedIds.push(action.actionId);
        } else {
          confirmedEntries.push({ action, result });
        }
      });
      await Promise.all([
        confirmPendingActions(confirmedEntries),
        removePendingActions(rejectedIds),
      ]);

      pendingCount = Math.max(0, pendingCount - processedActions.length);
      emitPendingCount();
      processedActions.forEach((action, index) => {
        const result = results[index];
        onCommit?.(result, action);
        resolveActionWaiter(action, result);
      });
      // Realtime fanout must not hold the durable write queue. Ably is only the
      // immediate display channel; Supabase has already accepted this batch.
      broadcastCommittedActions(processedActions, results).catch((error) => {
        console.warn('Realtime confirmation fanout failed', error);
      });

      onStatus?.(stoppedOnRejection ? 'ACTION_REJECTED' : 'ACTION_CONFIRMED');
      const latest = results[results.length - 1];
      if (results.some((result) => result?.needsSync) && !stoppedOnRejection) {
        onSyncRequired?.(Number(latest?.revision ?? 0));
      }
      return { results, stoppedOnRejection };
    } catch (error) {
      console.error(error);
      if (typeof navigator !== 'undefined' && navigator.onLine === false) onStatus?.('OFFLINE');
      else onStatus?.('SAVE_ERROR');
      actions.forEach((action) => resolveActionWaiter(action, null));
      return null;
    }
  };

  const drainPendingWrites = async ({ recovering = false } = {}) => {
    await pendingReadyPromise;
    if (drainingWrites || disconnected) return drainPromise;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      onStatus?.('OFFLINE');
      emitPendingCount(true);
      return null;
    }
    drainingWrites = true;
    if (recovering) onStatus?.('RECOVERING');
    drainPromise = (async () => {
      let committedAny = false;
      let batchFailed = false;
      let latestRevision = Number(getKnownRevision?.() ?? 0);
      try {
        while (!disconnected && !writesPaused) {
          const batch = await getNextPendingBatch();
          if (!batch.length) break;
          const outcome = await commitActionBatch(batch, { announceSaving: !recovering });
          if (!outcome) {
            batchFailed = true;
            break;
          }
          committedAny = true;
          latestRevision = Math.max(
            latestRevision,
            ...outcome.results.map((item) => Number(item?.revision ?? 0)),
          );
          if (outcome.stoppedOnRejection) break;
        }
        const remainingCount = Math.max(0, pendingCount);
        if (recovering && remainingCount === 0) {
          onStatus?.('RECOVERED');
          if (committedAny) onSyncRequired?.(latestRevision);
        }
      } finally {
        drainingWrites = false;
        emitPendingCount(true);
        const remainingCount = Math.max(0, pendingCount);
        if (!disconnected && !writesPaused && remainingCount > 0 && navigator.onLine !== false) {
          window.clearTimeout(writeFlushTimer);
          writeFlushTimer = window.setTimeout(
            () => drainPendingWrites(),
            batchFailed ? 1500 : PERSIST_BATCH_DELAY,
          );
        }
      }
      return null;
    })();
    return drainPromise;
  };

  const flushPending = async () => {
    window.clearTimeout(writeFlushTimer);
    writeFlushTimer = null;
    if (writesPaused) return null;
    return drainPendingWrites({ recovering: true });
  };

  const scheduleWriteDrain = () => {
    if (disconnected || writesPaused || drainingWrites || writeFlushTimer) return;
    writeFlushTimer = window.setTimeout(() => {
      writeFlushTimer = null;
      drainPendingWrites();
    }, PERSIST_BATCH_DELAY);
  };

  const enqueueAction = (ops, background = null) => {
    const safeOps = Array.isArray(ops) ? ops : [];
    const action = {
      actionId: randomToken(24),
      boardId,
      clientId,
      ops: safeOps,
      background,
      knownRevision: Number(getKnownRevision?.() ?? 0),
      createdAt: Date.now() * 1000 + (actionSequence++ % 1000),
      byteSize: estimateActionBytes({ ops: safeOps, background }),
    };

    inMemoryPending.set(action.actionId, action);
    pendingCount += 1;
    emitPendingCount();
    const task = new Promise((resolve) => {
      actionWaiters.set(action.actionId, { resolve });
    });
    enqueuePendingAction(action)
      .then((stored) => {
        if (stored) inMemoryPending.delete(action.actionId);
      })
      .catch(() => false)
      .finally(() => scheduleWriteDrain());
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
        emitUsers([...users.values()]);
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
      .on('broadcast', { event: 'actions' }, ({ payload }) => handleRealtimeEvent('actions', payload))
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
      .on('broadcast', { event: 'delete-preview' }, ({ payload }) => handleRealtimeEvent('delete-preview', payload))
      .on('broadcast', { event: 'selection-transaction' }, ({ payload }) => handleRealtimeEvent('selection-transaction', payload))
      .on('broadcast', { event: 'view' }, ({ payload }) => handleRealtimeEvent('view', payload))
      .on('broadcast', { event: 'view-jump' }, ({ payload }) => handleRealtimeEvent('view-jump', payload))
      .on('broadcast', { event: 'view-request' }, ({ payload }) => handleRealtimeEvent('view-request', payload))
      .on('broadcast', { event: 'game-library-visibility' }, ({ payload }) => handleRealtimeEvent('game-library-visibility', payload))
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
        emitUsers(users);
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
      emitUsers([...peers.values()]);
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


  return {
    sendOps(ops) {
      if (!Array.isArray(ops) || !ops.length) return Promise.resolve(null);
      return enqueueAction(ops, null);
    },
    sendMode(mode) {
      return publishRealtime('mode', { clientId, mode });
    },
    sendSettings(settings) {
      const background = settings?.background ?? null;
      publishRealtime('background-live', {
        clientId,
        background,
        timestamp: Date.now(),
      }).catch?.(() => undefined);
      return enqueueAction([], background);
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
    sendPreview(records, batch = null) {
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
        batchId: batch?.batchId ?? null,
        chunkIndex: Number(batch?.chunkIndex ?? 0),
        chunkCount: Math.max(1, Number(batch?.chunkCount ?? 1)),
        timestamp: Date.now(),
      };
      return publishRealtime('preview', payload);
    },
    sendObjectLive(record) {
      if (!record?.object?.boardObjectId) return Promise.resolve('ignored');
      try {
        if (JSON.stringify(record).length > MAX_BROADCAST_CHARS) return Promise.resolve('too-large');
      } catch {
        return Promise.resolve('invalid');
      }
      return publishRealtime('object-live', {
        clientId,
        name,
        color,
        record,
        timestamp: Date.now(),
      });
    },
    sendDeletePreview(ids) {
      const safeIds = [...new Set((Array.isArray(ids) ? ids : []).filter(Boolean).map(String))];
      if (!safeIds.length) return Promise.resolve('ignored');
      return publishRealtime('delete-preview', {
        clientId,
        name,
        color,
        ids: safeIds,
        mutationId: randomToken(16),
        timestamp: Date.now(),
      });
    },
    sendSelectionTransaction(transaction) {
      const phase = transaction?.phase;
      const validPhases = ['start', 'style', 'operation', 'commit', 'cancel'];
      if (!validPhases.includes(phase)) return Promise.resolve('ignored');
      if (phase !== 'operation' && !transaction?.transactionId) return Promise.resolve('ignored');
      if (phase === 'operation') {
        const objectIds = Array.isArray(transaction?.objectIds)
          ? transaction.objectIds.filter(Boolean)
          : [];
        const sourceIds = Array.isArray(transaction?.sourceIds)
          ? transaction.sourceIds.filter(Boolean)
          : [];
        if (!objectIds.length && !sourceIds.length) return Promise.resolve('ignored');
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
    sendView(view, { force = false } = {}) {
      const centerX = Number(Number(view?.centerX).toFixed(3));
      const centerY = Number(Number(view?.centerY).toFixed(3));
      const zoom = Number(Number(view?.zoom).toFixed(4));
      if (![centerX, centerY, zoom].every(Number.isFinite)) return Promise.resolve('ignored');
      const signature = `${centerX}:${centerY}:${zoom}`;
      if (!force && signature === lastViewSignature) return Promise.resolve('duplicate');
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
      }, { force });
    },
    sendViewJump(view) {
      const payload = { clientId, name, color, permission, ...view, timestamp: Date.now() };
      return publishRealtime('view-jump', payload, { force: true });
    },
    requestView() {
      const payload = { clientId, name, color, permission, timestamp: Date.now() };
      return publishRealtime('view-request', payload, { force: true });
    },
    requestSync(revision = Number(getKnownRevision?.() ?? 0)) {
      return publishRealtime('sync', { clientId, revision });
    },
    sendGameLibraryVisibility(visible) {
      return publishRealtime('game-library-visibility', {
        clientId,
        name,
        permission,
        visible: Boolean(visible),
        timestamp: Date.now(),
      });
    },
    flushPending,
    getPendingActions() {
      return getAllPendingActions();
    },
    pauseWrites() {
      writesPaused = true;
      window.clearTimeout(writeFlushTimer);
      writeFlushTimer = null;
    },
    resumeWrites() {
      if (disconnected) return;
      writesPaused = false;
      scheduleWriteDrain();
    },
    async disconnect() {
      disconnected = true;
      window.clearTimeout(writeFlushTimer);
      writeFlushTimer = null;
      window.clearTimeout(soloRealtimeTimer);
      window.clearTimeout(pendingUiTimer);
      soloRealtimeTimer = null;
      await drainPromise.catch(() => undefined);
      actionWaiters.forEach(({ resolve }) => resolve?.(null));
      actionWaiters.clear();
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
