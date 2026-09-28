// Authority acquisition is bounded so presence can distinguish pending from ready.
const WEB_LOCK_PROBE_TIMEOUT_MS = 1_500;
const WEB_LOCK_RETRY_MS = 750;
const FALLBACK_LEASE_TTL_MS = 6_000;
const FALLBACK_HEARTBEAT_MS = 2_000;
const FALLBACK_RETRY_MS = 750;

function safeStorage(storage) {
  if (storage) return storage;
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

function leaseToken() {
  try { return globalThis.crypto?.randomUUID?.() ?? `lease-${Date.now()}-${Math.random().toString(36).slice(2)}`; }
  catch { return `lease-${Date.now()}-${Math.random().toString(36).slice(2)}`; }
}

function readLease(storage, key) {
  if (!storage?.getItem) return null;
  try {
    const value = JSON.parse(storage.getItem(key) ?? 'null');
    return value && typeof value === 'object' ? value : null;
  } catch { return null; }
}

function writeLease(storage, key, value) {
  if (!storage?.setItem) return false;
  try {
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch { return false; }
}

function removeOwnLease(storage, key, token) {
  if (!storage?.removeItem) return;
  try {
    const current = readLease(storage, key);
    if (String(current?.token ?? '') === token) storage.removeItem(key);
  } catch { /* best effort */ }
}

export function createTeacherTabAuthority({
  boardId,
  lockManager,
  storage = null,
  onChange = () => {},
  webLockProbeTimeoutMs = WEB_LOCK_PROBE_TIMEOUT_MS,
  webLockRetryMs = WEB_LOCK_RETRY_MS,
  fallbackLeaseTtlMs = FALLBACK_LEASE_TTL_MS,
  fallbackHeartbeatMs = FALLBACK_HEARTBEAT_MS,
  fallbackRetryMs = FALLBACK_RETRY_MS,
} = {}) {
  const safeBoardId = String(boardId ?? '').trim();
  if (!safeBoardId) throw new Error('boardId is required');

  const locks = lockManager ?? globalThis.navigator?.locks;
  const probeTimeout = Math.max(1, Number(webLockProbeTimeoutMs) || WEB_LOCK_PROBE_TIMEOUT_MS);
  const lockRetry = Math.max(1, Number(webLockRetryMs) || WEB_LOCK_RETRY_MS);
  const leaseTtl = Math.max(100, Number(fallbackLeaseTtlMs) || FALLBACK_LEASE_TTL_MS);
  const heartbeat = Math.max(10, Number(fallbackHeartbeatMs) || FALLBACK_HEARTBEAT_MS);
  const fallbackRetry = Math.max(10, Number(fallbackRetryMs) || FALLBACK_RETRY_MS);
  const lockName = `alex-board-authority:${safeBoardId}`;
  const leaseKey = `alex-board-authority-lease:${safeBoardId}`;
  const fallbackStorage = safeStorage(storage);
  const token = leaseToken();

  let started = false;
  let stopped = false;
  let authority = false;
  let runningPromise = null;
  let releaseCurrentLock = null;
  let activeAbortController = null;
  let retryTimer = null;
  let heartbeatTimer = null;
  let resolveRetryWait = null;
  let resolveActiveProbe = null;
  let usingFallback = false;

  const setAuthority = (next) => {
    const value = Boolean(next);
    if (authority === value) return;
    authority = value;
    onChange(value);
  };

  const clearTimers = () => {
    clearTimeout(retryTimer);
    clearTimeout(heartbeatTimer);
    retryTimer = null;
    heartbeatTimer = null;
    resolveRetryWait?.();
    resolveRetryWait = null;
  };

  const fallbackAcquire = () => {
    if (stopped) return;
    const now = Date.now();
    const current = readLease(fallbackStorage, leaseKey);
    const currentToken = String(current?.token ?? '');
    const expiresAt = Number(current?.expiresAt ?? 0);

    if (!fallbackStorage?.setItem || !currentToken || currentToken === token || expiresAt <= now) {
      const lease = { token, expiresAt: now + leaseTtl };
      const written = fallbackStorage?.setItem ? writeLease(fallbackStorage, leaseKey, lease) : true;
      const verified = !fallbackStorage?.getItem || String(readLease(fallbackStorage, leaseKey)?.token ?? token) === token;
      if (written && verified) {
        setAuthority(true);
        heartbeatTimer = setTimeout(fallbackAcquire, heartbeat);
        return;
      }
    }

    setAuthority(false);
    retryTimer = setTimeout(fallbackAcquire, fallbackRetry);
  };

  const startFallback = () => {
    if (usingFallback || stopped) return;
    usingFallback = true;
    fallbackAcquire();
  };

  const webLockLoop = async () => {
    while (!stopped && !usingFallback) {
      const controller = new AbortController();
      activeAbortController = controller;
      let decide;
      const decision = new Promise((resolve) => { decide = resolve; });
      let decisionSettled = false;
      const settleDecision = (value) => {
        if (decisionSettled) return;
        decisionSettled = true;
        if (resolveActiveProbe === settleDecision) resolveActiveProbe = null;
        decide(value);
      };
      resolveActiveProbe = settleDecision;

      const requestTask = Promise.resolve().then(() => locks.request(
        lockName,
        { mode: 'exclusive', ifAvailable: true, signal: controller.signal },
        async (lock) => {
          if (stopped) {
            settleDecision('stopped');
            return;
          }
          if (!lock) {
            settleDecision('busy');
            return;
          }
          setAuthority(true);
          settleDecision('acquired');
          await new Promise((resolve) => {
            releaseCurrentLock = resolve;
            if (stopped) resolve();
          });
          releaseCurrentLock = null;
          setAuthority(false);
        },
      )).catch((error) => {
        if (stopped && error?.name === 'AbortError') return;
        settleDecision({ error });
      });

      let watchdogTimer = null;
      const watchdog = new Promise((resolve) => {
        watchdogTimer = setTimeout(() => resolve('timeout'), probeTimeout);
      });
      const outcome = await Promise.race([decision, watchdog]);
      clearTimeout(watchdogTimer);

      if (outcome === 'timeout') {
        try { controller.abort(); } catch { /* ignored */ }
        startFallback();
        requestTask.catch(() => undefined);
        return;
      }
      if (outcome && typeof outcome === 'object' && outcome.error) {
        try { controller.abort(); } catch { /* ignored */ }
        startFallback();
        requestTask.catch(() => undefined);
        return;
      }
      if (outcome === 'acquired') {
        await requestTask;
        return;
      }
      if (outcome === 'stopped') {
        try { controller.abort(); } catch { /* ignored */ }
        requestTask.catch(() => undefined);
        return;
      }
      await requestTask.catch(() => undefined);
      if (stopped) return;
      await new Promise((resolve) => {
        const finish = () => {
          if (resolveRetryWait === finish) resolveRetryWait = null;
          retryTimer = null;
          resolve();
        };
        resolveRetryWait = finish;
        retryTimer = setTimeout(finish, lockRetry);
      });
    }
  };

  return {
    start() {
      if (started) throw new Error('Teacher tab authority is already started');
      started = true;
      stopped = false;

      if (!locks?.request) {
        startFallback();
        runningPromise = Promise.resolve();
        return runningPromise;
      }

      runningPromise = webLockLoop().finally(() => {
        if (!usingFallback) {
          setAuthority(false);
          activeAbortController = null;
          releaseCurrentLock = null;
          started = false;
        }
      });
      return runningPromise;
    },

    stop() {
      if (!started) return;
      stopped = true;
      clearTimers();
      try { activeAbortController?.abort(); } catch { /* ignored */ }
      resolveActiveProbe?.('stopped');
      resolveActiveProbe = null;
      releaseCurrentLock?.();
      releaseCurrentLock = null;
      if (usingFallback) {
        removeOwnLease(fallbackStorage, leaseKey, token);
        setAuthority(false);
        usingFallback = false;
        started = false;
      }
    },

    isAuthority() { return authority; },
    getLockName() { return lockName; },
    isBestEffortFallback() { return usingFallback || !locks?.request; },
  };
}
