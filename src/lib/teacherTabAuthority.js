export function createTeacherTabAuthority({ boardId, lockManager, onChange = () => {} }) {
  const safeBoardId = String(boardId ?? '').trim();
  if (!safeBoardId) throw new Error('boardId is required');

  const locks = lockManager ?? globalThis.navigator?.locks;
  const lockName = `alex-board-authority:${safeBoardId}`;

  if (!locks?.request) {
    let started = false;
    let authority = false;
    return {
      start() {
        if (started) throw new Error('Teacher tab authority is already started');
        started = true;
        authority = true;
        onChange(true);
        return Promise.resolve();
      },
      stop() {
        if (!started) return;
        started = false;
        authority = false;
        onChange(false);
      },
      isAuthority() { return authority; },
      getLockName() { return lockName; },
      isBestEffortFallback() { return true; },
    };
  }
  let started = false;
  let stopped = false;
  let authority = false;
  let releaseCurrentLock = null;
  let abortController = null;
  let runningPromise = null;

  const setAuthority = (next) => {
    const value = Boolean(next);
    if (authority === value) return;
    authority = value;
    onChange(value);
  };

  return {
    start() {
      if (started) throw new Error('Teacher tab authority is already started');
      started = true;
      stopped = false;
      abortController = new AbortController();

      runningPromise = Promise.resolve(locks.request(
        lockName,
        { mode: 'exclusive', signal: abortController.signal },
        async (lock) => {
          if (!lock || stopped) return;
          setAuthority(true);
          await new Promise((resolve) => {
            releaseCurrentLock = resolve;
            if (stopped) resolve();
          });
          releaseCurrentLock = null;
          setAuthority(false);
        },
      )).catch((error) => {
        if (stopped && error?.name === 'AbortError') return;
        throw error;
      }).finally(() => {
        setAuthority(false);
        releaseCurrentLock = null;
        abortController = null;
        started = false;
      });

      return runningPromise;
    },
    stop() {
      if (!started) return;
      stopped = true;
      abortController?.abort();
      releaseCurrentLock?.();
    },
    isAuthority() {
      return authority;
    },
    getLockName() {
      return lockName;
    },
  };
}
