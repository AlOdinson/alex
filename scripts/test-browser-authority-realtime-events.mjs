import assert from 'node:assert/strict';
import test from 'node:test';
import {
  connectBoardRealtime,
  routeBrowserRealtimeEvent,
} from '../src/lib/browserAuthorityRealtime.js';

test('routes transient events and never accepts durable action packets from Ably', async () => {
  const events = [];
  const callbacks = {
    onCursor: (payload) => events.push(['cursor', payload.x]),
    onMode: (mode) => events.push(['mode', mode]),
    onOps: () => events.push(['ops']),
    onSyncRequired: (revision) => events.push(['sync', revision]),
  };

  await routeBrowserRealtimeEvent('cursor', { clientId: 'student-b', x: 4 }, {
    localClientId: 'student-a', callbacks,
  });
  await routeBrowserRealtimeEvent('mode', { clientId: 'teacher-a', mode: 'view' }, {
    localClientId: 'student-a', callbacks,
  });
  await routeBrowserRealtimeEvent('actions', {
    clientId: 'teacher-a', actions: [{ revision: 9, ops: [{ type: 'delete', id: 'x' }] }],
  }, { localClientId: 'student-a', callbacks });
  await routeBrowserRealtimeEvent('action', {
    clientId: 'teacher-a', revision: 9, ops: [{ type: 'delete', id: 'x' }],
  }, { localClientId: 'student-a', callbacks });
  await routeBrowserRealtimeEvent('sync', { clientId: 'teacher-a', revision: 9 }, {
    localClientId: 'student-a', callbacks });

  assert.deepEqual(events, [['cursor', 4], ['mode', 'view'], ['sync', 9]]);
});

test('board peer signaling is consumed by browser session and still offered to screen-share handler', async () => {
  const events = [];
  const payload = {
    clientId: 'teacher-a',
    protocol: 'alex-board-peer-signal-v1',
    type: 'board-peer-signal',
    sessionId: 'teacher-a:student-a',
  };
  await routeBrowserRealtimeEvent('screen-share-signal', payload, {
    localClientId: 'student-a',
    session: { handleRealtimeSignal: async (value) => events.push(['session', value.protocol]) },
    callbacks: { onScreenShareSignal: (value) => events.push(['screen', value.protocol]) },
  });
  assert.deepEqual(events, [
    ['session', 'alex-board-peer-signal-v1'],
    ['screen', 'alex-board-peer-signal-v1'],
  ]);
});

test('ignores own echoed transient events', async () => {
  let calls = 0;
  await routeBrowserRealtimeEvent('cursor', { clientId: 'student-a', x: 3 }, {
    localClientId: 'student-a',
    callbacks: { onCursor: () => { calls += 1; } },
  });
  assert.equal(calls, 0);
});

test('Ably continuity recovery wakes durable work and asks Board to reconcile peer authority', async () => {
  let transportOptions = null;
  let flushCalls = 0;
  const syncRevisions = [];

  const realtime = connectBoardRealtime({
    boardId: 'board-a',
    realtimeKey: 'room-key-12345678901234567890',
    clientId: 'student-a',
    permission: 'edit',
    getKnownRevision: () => 7,
    onSyncRequired: (revision) => syncRevisions.push(revision),
  }, {
    createSession: () => ({
      async start() {},
      async updateParticipants() {},
      async handleRealtimeSignal() {},
      close() {},
    }),
    createCore: () => ({
      async flushPending() { flushCalls += 1; },
      async disconnect() {},
      async sendScreenShareSignal() {},
    }),
    createTransport: (options) => {
      transportOptions = options;
      return {
        async start() {},
        async publish() { return 'ok'; },
        async disconnect() {},
      };
    },
  });

  await Promise.resolve();
  assert.equal(typeof transportOptions?.onRecover, 'function');
  await transportOptions.onRecover({ reason: 'connection-reconnected' });
  assert.equal(flushCalls, 1);
  assert.deepEqual(syncRevisions, [7]);
  await realtime.disconnect();
});
