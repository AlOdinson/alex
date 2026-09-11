import assert from 'node:assert/strict';
import test from 'node:test';
import { connectBoardRealtime } from '../src/lib/realtime.js';

function realtimeHarness({ onSessionClose = () => {} } = {}) {
  return connectBoardRealtime({
    boardId: 'pagehide-board',
    realtimeKey: 'room-key-pagehide-1234567890',
    clientId: 'pagehide-owner',
    permission: 'owner',
  }, {
    createSession: () => ({
      async start() {},
      async updateParticipants() {},
      async handleRealtimeSignal() {},
      getRevision: () => 0,
      close: onSessionClose,
    }),
    createCore: () => ({
      async flushPending() {},
      async disconnect() {},
      async sendScreenShareSignal() {},
    }),
    createTransport: () => ({
      async start() {},
      async publish() { return 'ok'; },
      async disconnect() {},
    }),
  });
}

test('pagehide releases authority after Board pagehide handlers and BFCache restore reloads', async () => {
  const previousWindow = globalThis.window;
  const fakeWindow = new EventTarget();
  let reloadCount = 0;
  Object.assign(fakeWindow, {
    location: { reload() { reloadCount += 1; } },
  });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });

  let sessionCloseCount = 0;

  try {
    const realtime = realtimeHarness({
      onSessionClose: () => { sessionCloseCount += 1; },
    });
    await Promise.resolve();
    await Promise.resolve();

    const closeStateSeenByLaterPagehideHandler = [];
    fakeWindow.addEventListener('pagehide', () => {
      closeStateSeenByLaterPagehideHandler.push(sessionCloseCount);
    });

    fakeWindow.dispatchEvent(new Event('pagehide'));
    assert.deepEqual(
      closeStateSeenByLaterPagehideHandler,
      [0],
      'authority teardown must wait until same-turn Board pagehide handlers can flush their final state',
    );

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(
      sessionCloseCount,
      1,
      'owner authority must be released before the page can remain frozen in BFCache',
    );

    const pageShow = new Event('pageshow');
    Object.defineProperty(pageShow, 'persisted', { configurable: true, value: true });
    fakeWindow.dispatchEvent(pageShow);
    assert.equal(reloadCount, 1, 'a BFCache-restored board must reload and create a fresh authority session');

    await realtime.disconnect();
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow });
  }
});
