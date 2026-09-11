import {
  connectBoardRealtime as connectBrowserBoardRealtime,
  createAblyBrowserTransport,
  routeBrowserRealtimeEvent,
} from './browserAuthorityRealtime.js';

export { createAblyBrowserTransport, routeBrowserRealtimeEvent };

function schedulePageHideTeardown(callback) {
  if (typeof queueMicrotask === 'function') {
    queueMicrotask(callback);
    return;
  }
  Promise.resolve().then(callback);
}

export function connectBoardRealtime(options = {}, dependencies = {}) {
  const realtime = connectBrowserBoardRealtime(options, dependencies);
  if (options?.permission !== 'owner'
    || typeof window === 'undefined'
    || typeof window.addEventListener !== 'function') {
    return realtime;
  }

  const originalDisconnect = realtime.disconnect?.bind(realtime) ?? (async () => {});
  let pageHidden = false;
  let lifecycleInstalled = true;

  const removeLifecycle = () => {
    if (!lifecycleInstalled) return;
    lifecycleInstalled = false;
    window.removeEventListener?.('pagehide', handlePageHide);
    window.removeEventListener?.('pageshow', handlePageShow);
  };

  const handlePageHide = () => {
    pageHidden = true;
    // Board also has a pagehide handler that flushes its last deferred transform.
    // Run authority teardown at the microtask checkpoint so every same-turn Board
    // handler gets to flush first, but the Web Lock is still released before an
    // outgoing iPad page can remain frozen in BFCache.
    schedulePageHideTeardown(() => {
      try {
        Promise.resolve(originalDisconnect()).catch(() => undefined);
      } catch {
        // The page is leaving; teardown must never surface an unload error.
      }
    });
  };

  const handlePageShow = (event) => {
    if (!pageHidden || !event?.persisted) return;
    removeLifecycle();
    try {
      window.location?.reload?.();
    } catch {
      // A restored authority session was deliberately closed on pagehide. If a
      // host blocks reload, the existing durable edit gate remains fail-closed.
    }
  };

  window.addEventListener('pagehide', handlePageHide);
  window.addEventListener('pageshow', handlePageShow);

  realtime.disconnect = async () => {
    removeLifecycle();
    return originalDisconnect();
  };

  return realtime;
}
