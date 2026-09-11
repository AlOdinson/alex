import { randomToken } from './ids.js';

const LOCK_TTL = 12_000;
const MAX_BROADCAST_CHARS = 48_000;

function safeArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function safeRevision(value) {
  const revision = Number(value ?? 0);
  return Number.isInteger(revision) && revision >= 0 ? revision : 0;
}

function cloneAction(action) {
  if (typeof structuredClone === 'function') return structuredClone(action);
  return JSON.parse(JSON.stringify(action));
}

export function createBrowserAuthorityRealtimeCore({
  session,
  clientId,
  name = 'Участник',
  color = null,
  permission = 'view',
  getKnownRevision = () => 0,
  publish = async () => 'ok',
  onCommit = () => {},
  onPendingChange = () => {},
  onStatus = () => {},
  onSyncRequired = () => {},
  createActionId = () => randomToken(24),
} = {}) {
  const safeClientId = String(clientId ?? '').trim();
  if (!safeClientId) throw new Error('clientId is required');
  if (!session?.sendOps) throw new Error('browser board session is required');
  if (typeof publish !== 'function') throw new Error('publish is required');

  const pending = new Map();
  const queue = [];
  const idleWaiters = [];
  let active = false;
  let paused = false;
  let closed = false;
  let lastCursorSignature = '';
  let lastViewSignature = '';

  const emitPending = () => {
    try { onPendingChange(pending.size); } catch { /* observer errors are ignored */ }
  };

  const resolveIdle = () => {
    if (active || queue.length || pending.size) return;
    while (idleWaiters.length) idleWaiters.shift()?.();
  };

  const executeEntry = async (entry) => {
    try {
      await session.whenRuntimeReady?.();
      if (closed) throw new Error('Realtime connection is closed');
      onStatus?.('SAVING');
      const result = await session.sendOps(entry.action.ops, {
        actionId: entry.action.actionId,
        background: entry.action.background,
      });
      try { onCommit(result, entry.action, { batchIndex: 0, batchCount: 1, actions: [entry.action], results: [result] }); } catch { /* observer errors are ignored */ }
      onStatus?.('ACTION_CONFIRMED');
      entry.resolve(result);
    } catch (error) {
      onStatus?.('SAVE_ERROR');
      entry.reject(error);
    } finally {
      pending.delete(entry.action.actionId);
      emitPending();
    }
  };

  const drain = async () => {
    if (active || paused || closed) return;
    const entry = queue.shift();
    if (!entry) {
      resolveIdle();
      return;
    }
    active = true;
    await executeEntry(entry);
    active = false;
    if (!paused && !closed) queueMicrotask(() => { drain(); });
    resolveIdle();
  };

  const enqueueDurable = (ops, background = null, options = {}) => {
    if (closed) return Promise.reject(new Error('Realtime connection is closed'));
    const safeOps = safeArray(ops);
    if (!safeOps.length && background == null) return Promise.resolve(null);
    const actionId = String(options?.actionId ?? createActionId()).trim();
    if (!actionId) return Promise.reject(new Error('actionId is required'));
    const action = {
      actionId,
      clientId: safeClientId,
      baseRevision: safeRevision(session?.getRevision?.() ?? getKnownRevision?.()),
      ops: safeOps,
      background,
      createdAt: Date.now(),
      serializedSize: Number.isFinite(Number(options?.serializedSize)) ? Number(options.serializedSize) : null,
      atomic: Boolean(options?.atomic),
    };
    const task = new Promise((resolve, reject) => {
      const entry = { action, resolve, reject };
      pending.set(actionId, action);
      queue.push(entry);
      emitPending();
      drain();
    });
    return task;
  };

  const publishRealtime = (event, payload, options = {}) => {
    if (closed) return Promise.resolve('closed');
    return Promise.resolve(publish(event, payload, options));
  };

  return {
    sendOps(ops, options = {}) {
      if (!Array.isArray(ops) || !ops.length) return Promise.resolve(null);
      return enqueueDurable(ops, null, options);
    },

    sendMode(mode) {
      return publishRealtime('mode', { clientId: safeClientId, mode });
    },

    sendSettings(settings) {
      const background = settings?.background ?? null;
      publishRealtime('background-live', {
        clientId: safeClientId,
        background,
        baseRevision: safeRevision(getKnownRevision?.()),
        timestamp: Date.now(),
      }).catch(() => undefined);
      return enqueueDurable([], background, {});
    },

    sendCursor(cursor) {
      if (!Number.isFinite(Number(cursor?.x)) || !Number.isFinite(Number(cursor?.y))) return Promise.resolve('ignored');
      const x = Number(Number(cursor.x).toFixed(2));
      const y = Number(Number(cursor.y).toFixed(2));
      const signature = `${x}:${y}`;
      if (signature === lastCursorSignature) return Promise.resolve('duplicate');
      lastCursorSignature = signature;
      return publishRealtime('cursor', {
        clientId: safeClientId, name, color, x, y, timestamp: Date.now(),
      });
    },

    sendLock(objectIds, locked = true) {
      return publishRealtime('lock', {
        clientId: safeClientId,
        name,
        color,
        objectIds: safeArray(objectIds).map(String),
        locked: Boolean(locked),
        expiresAt: Date.now() + LOCK_TTL,
      });
    },

    sendTransform(transform) {
      const hasObjectFrames = Array.isArray(transform?.objects) && transform.objects.length > 0;
      const hasGroupFrame = transform?.mode === 'group'
        && Array.isArray(transform?.objectIds) && transform.objectIds.length > 0
        && Array.isArray(transform?.deltaMatrix) && transform.deltaMatrix.length === 6;
      if (!hasObjectFrames && !hasGroupFrame) return Promise.resolve('ignored');
      return publishRealtime('transform', {
        clientId: safeClientId,
        name,
        color,
        baseRevision: safeRevision(getKnownRevision?.()),
        ...transform,
        timestamp: Date.now(),
      });
    },

    sendDraw(draw) {
      if (!draw?.objectId || !Array.isArray(draw?.points)) return Promise.resolve('ignored');
      if (draw.phase === 'update' && draw.points.length === 0) return Promise.resolve('ignored');
      const requested = Number(draw.baseRevision);
      return publishRealtime('draw', {
        clientId: safeClientId,
        name,
        color,
        ...draw,
        baseRevision: Number.isFinite(requested) && requested >= 0 ? requested : safeRevision(getKnownRevision?.()),
        timestamp: Date.now(),
      });
    },

    sendPreview(records, batch = null) {
      const safeRecords = safeArray(records);
      if (!safeRecords.length) return Promise.resolve('ignored');
      try {
        if (JSON.stringify(safeRecords).length > MAX_BROADCAST_CHARS) return Promise.resolve('too-large');
      } catch {
        return Promise.resolve('invalid');
      }
      return publishRealtime('preview', {
        clientId: safeClientId,
        name,
        color,
        records: safeRecords,
        batchId: batch?.batchId ?? null,
        chunkIndex: Number(batch?.chunkIndex ?? 0),
        chunkCount: Math.max(1, Number(batch?.chunkCount ?? 1)),
        timestamp: Date.now(),
      });
    },

    sendObjectLive(record) {
      if (!record?.object?.boardObjectId) return Promise.resolve('ignored');
      try {
        if (JSON.stringify(record).length > MAX_BROADCAST_CHARS) return Promise.resolve('too-large');
      } catch {
        return Promise.resolve('invalid');
      }
      return publishRealtime('object-live', {
        clientId: safeClientId,
        name,
        color,
        baseRevision: safeRevision(getKnownRevision?.()),
        record,
        timestamp: Date.now(),
      });
    },

    sendDeletePreview(ids, { expectDurable = true } = {}) {
      const safeIds = [...new Set(safeArray(ids).map(String))];
      if (!safeIds.length) return Promise.resolve('ignored');
      return publishRealtime('delete-preview', {
        clientId: safeClientId,
        name,
        color,
        baseRevision: safeRevision(getKnownRevision?.()),
        ids: safeIds,
        expectDurable: Boolean(expectDurable),
        mutationId: randomToken(16),
        timestamp: Date.now(),
      });
    },

    sendSelectionTransaction(transaction) {
      const phase = transaction?.phase;
      if (!['start', 'style', 'operation', 'commit', 'cancel'].includes(phase)) return Promise.resolve('ignored');
      if (phase !== 'operation' && !transaction?.transactionId) return Promise.resolve('ignored');
      return publishRealtime('selection-transaction', {
        clientId: safeClientId,
        name,
        color,
        baseRevision: safeRevision(getKnownRevision?.()),
        ...transaction,
        timestamp: Date.now(),
      });
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
        clientId: safeClientId, name, color, permission, ...view, centerX, centerY, zoom, timestamp: Date.now(),
      }, { force });
    },

    sendViewJump(view) {
      return publishRealtime('view-jump', {
        clientId: safeClientId, name, color, permission, ...view, timestamp: Date.now(),
      }, { force: true });
    },

    requestView() {
      return publishRealtime('view-request', {
        clientId: safeClientId, name, color, permission, timestamp: Date.now(),
      }, { force: true });
    },

    requestSync(revision = safeRevision(getKnownRevision?.())) {
      try { onSyncRequired(revision); } catch { /* observer errors are ignored */ }
      return Promise.resolve('peer-authority');
    },

    sendGameLibraryVisibility(visible) {
      return publishRealtime('game-library-visibility', {
        clientId: safeClientId, name, permission, visible: Boolean(visible), timestamp: Date.now(),
      });
    },

    sendScreenShareSignal(signal) {
      if (!signal?.protocol || !signal?.type || !signal?.sessionId) return Promise.resolve('ignored');
      return publishRealtime('screen-share-signal', {
        ...signal,
        clientId: safeClientId,
        name,
        permission,
        timestamp: Date.now(),
      }, { force: true });
    },

    flushPending() {
      if (!paused) drain();
      if (!active && !queue.length && !pending.size) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.push(resolve));
    },

    getPendingActions() {
      return Promise.resolve([...pending.values()].map(cloneAction));
    },

    pauseWrites() {
      paused = true;
    },

    resumeWrites() {
      if (closed) return;
      paused = false;
      drain();
    },

    async disconnect() {
      if (closed) return;
      closed = true;
      while (queue.length) {
        const entry = queue.shift();
        pending.delete(entry.action.actionId);
        entry.reject(new Error('Realtime connection is closed'));
      }
      emitPending();
      resolveIdle();
    },
  };
}
