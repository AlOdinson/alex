import { randomToken } from './ids.js';

/**
 * A durable outbox belongs to a stable tab/board actor. sessionStorage survives
 * reload but can be copied by "duplicate tab"; a lifetime Web Lock prevents two
 * live writers from sharing that actor. Browser teardown releases the lock.
 */
export async function acquireNotebookClientIdentity({ boardId, storage = globalThis.sessionStorage,
  locks = globalThis.navigator?.locks, newId = () => randomToken(24), signal } = {}) {
  if (!boardId) throw new TypeError('Notebook actor requires a board');
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
  if (!locks?.request) throw new Error('Notebook recovery requires Web Locks; update your browser');
  if (!storage?.getItem || !storage?.setItem) throw new Error('Notebook recovery requires session storage');
  const key = `alex:notebook-actor:v1:${boardId}`;
  let candidate = storage.getItem(key) || String(newId());
  for (let attempt = 0; attempt < 4; attempt++) {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    let resolveReady, rejectReady;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const request = Promise.resolve().then(() => locks.request(`alex:notebook-actor:${candidate}`, {
      // Web Locks forbids signal + ifAvailable. This request never queues;
      // cancellation is handled before acquisition and by the lifetime below.
      mode: 'exclusive', ifAvailable: true,
    }, async lock => {
      if (!lock) { resolveReady(null); return; }
      let finish, released = false;
      const lifetime = new Promise(resolve => { finish = resolve; });
      const release = () => {
        if (released) return;
        released = true; signal?.removeEventListener('abort', release); finish();
      };
      signal?.addEventListener('abort', release, { once: true });
      if (signal?.aborted) release();
      resolveReady({ clientId: candidate, release });
      await lifetime;
    }));
    request.catch(rejectReady);
    const identity = await ready;
    if (!identity) { candidate = String(newId()); continue; }
    try {
      if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      storage.setItem(key, identity.clientId);
      return identity;
    } catch (error) { identity.release(); throw error; }
  }
  throw new Error('Could not allocate an exclusive notebook actor; reload the tab');
}
