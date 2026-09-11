import assert from 'node:assert/strict';
import test from 'node:test';
import {
  connectBoardRealtime,
  createAblyBrowserTransport,
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

test('transient Ably publishes are harmless while an owner tab is still waiting for authority', async () => {
  const transport = createAblyBrowserTransport({
    boardId: 'board-starting',
    roomKey: 'room-key-starting-1234567890',
    clientId: 'teacher-starting',
    permission: 'owner',
    AblyRuntime: null,
  });

  assert.equal(
    await transport.publish('cursor', { clientId: 'teacher-starting', x: 1, y: 2 }),
    'starting',
    'transient UI events before transport startup must be dropped rather than becoming page errors',
  );
  await transport.disconnect();
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

test('terminal student peer failure refreshes Ably presence so the same teacher can be reconnected', async () => {
  let sessionOptions = null;
  let refreshCalls = 0;
  const statuses = [];

  const realtime = connectBoardRealtime({
    boardId: 'board-a',
    realtimeKey: 'room-key-12345678901234567890',
    clientId: 'student-a',
    permission: 'edit',
    onStatus: (status) => statuses.push(status),
  }, {
    createSession: (options) => {
      sessionOptions = options;
      return {
        async start() {},
        async updateParticipants() {},
        async handleRealtimeSignal() {},
        close() {},
      };
    },
    createCore: () => ({
      async flushPending() {},
      async disconnect() {},
      async sendScreenShareSignal() {},
    }),
    createTransport: () => ({
      async start() {},
      async publish() { return 'ok'; },
      async refreshUsers() { refreshCalls += 1; },
      async disconnect() {},
    }),
  });

  await Promise.resolve();
  sessionOptions.onPeerState('disconnected');
  await Promise.resolve();
  assert.equal(refreshCalls, 0, 'temporary disconnected state must be allowed to heal naturally');

  sessionOptions.onPeerState('failed');
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(refreshCalls, 1, 'terminal student peer failure must force an owner presence refresh');
  assert.ok(statuses.includes('RECOVERING'));
  await realtime.disconnect();
});

test('owner Ably transport starts only after exclusive teacher session startup resolves', async () => {
  let resolveSessionStart;
  let transportStarts = 0;
  const sessionStarted = new Promise((resolve) => { resolveSessionStart = resolve; });

  const realtime = connectBoardRealtime({
    boardId: 'board-exclusive',
    realtimeKey: 'room-key-exclusive-1234567890',
    clientId: 'teacher-exclusive',
    permission: 'owner',
  }, {
    createSession: () => ({
      start() { return sessionStarted; },
      async updateParticipants() {},
      async handleRealtimeSignal() {},
      getRevision: () => 0,
      close() {},
    }),
    createCore: () => ({
      async flushPending() {},
      async disconnect() {},
      async sendScreenShareSignal() {},
    }),
    createTransport: () => ({
      async start() { transportStarts += 1; },
      async publish() { return 'ok'; },
      async disconnect() {},
    }),
  });

  await Promise.resolve();
  await Promise.resolve();
  assert.equal(transportStarts, 0, 'owner presence must not start before this tab owns teacher authority');

  resolveSessionStart();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(transportStarts, 1);
  await realtime.disconnect();
});
