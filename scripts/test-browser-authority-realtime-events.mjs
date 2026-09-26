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

const flushStartup = async () => { for (let i = 0; i < 40; i += 1) await Promise.resolve(); };
function observeStartup(task) {
  const state = { status: 'pending', error: null };
  state.done = task.then(() => { state.status = 'fulfilled'; }, (error) => {
    state.status = 'rejected'; state.error = error;
  });
  return state;
}
function startupFixture(t, first = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const clients = [], users = [], statuses = [], errors = [];
  const transport = createAblyBrowserTransport({
    boardId: 'startup-recovery', roomKey: 'startup-room', clientId: 'student',
    name: 'Student', permission: 'edit',
    onUsers: (value) => users.push(value), onStatus: (value) => statuses.push(value),
    onError: (error) => errors.push(error), tokenRequest: async () => ({ token: 'test' }),
    AblyRuntime: { Realtime: class {
      constructor() {
        const plan = clients.length === 0 ? first : {};
        this.closes = 0;
        this.connection = {
          state: 'connecting',
          on: (listener) => { this.stateListener = listener; },
          once: async () => { await plan.connect?.(); this.connection.state = 'connected'; },
        };
        this.channel = {
          on() {}, subscribe: async () => { await plan.subscribe?.(); },
          presence: {
            subscribe: async () => { await plan.presenceSubscribe?.(); },
            enter: async () => { await plan.enter?.(); },
            get: async () => plan.get ? plan.get() : [{ clientId: 'teacher', data: { permission: 'owner' } }],
            leave: () => plan.leave?.(),
          },
        };
        this.channels = { get: () => this.channel };
        clients.push(this);
      }
      close() { this.closes += 1; this.connection.state = 'closed'; this.stateListener?.({ current: 'closed' }); }
    } },
  });
  t.after(() => { void transport.disconnect(); });
  return { transport, clients, users, statuses, errors };
}

test('failed initial signaling startup recreates its client and joins without a page reload', async (t) => {
  const failure = new Error('The network connection was lost');
  const f = startupFixture(t, { connect: async () => { throw failure; } });
  const starting = observeStartup(f.transport.start());
  await flushStartup();
  assert.equal(starting.status, 'pending', 'a temporary network error must not abandon initial startup');
  assert.equal(f.clients[0].closes, 1, 'retire the failed connection before retrying');
  assert.ok(f.errors.includes(failure));
  t.mock.timers.tick(1001);
  await flushStartup();
  assert.equal(starting.status, 'fulfilled');
  assert.equal(f.clients.length, 2);
  assert.equal(f.users.at(-1)[0].clientId, 'teacher');
  assert.equal(f.statuses.at(-1), 'SUBSCRIBED');
});

for (const phase of ['connect', 'subscribe', 'presenceSubscribe', 'enter', 'get']) {
  test(`silent initial ${phase} has a deadline and recovers on the next client`, async (t) => {
    let finishOld;
    const blocked = new Promise((resolve) => { finishOld = resolve; });
    const f = startupFixture(t, { [phase]: () => blocked });
    const starting = observeStartup(f.transport.start());
    await flushStartup();
    t.mock.timers.tick(10001);
    await flushStartup();
    assert.equal(f.clients[0].closes, 1, `${phase} must not leave a half-started SDK client`);
    t.mock.timers.tick(1001);
    await flushStartup();
    assert.equal(starting.status, 'fulfilled');
    assert.equal(f.clients.length, 2);
    const count = f.users.length;
    finishOld(phase === 'get' ? [{ clientId: 'stale-teacher', data: {} }] : undefined);
    await flushStartup();
    assert.equal(f.users.length, count, 'late completion from a retired attempt must not publish stale presence');
    const statusCount = f.statuses.length;
    f.clients[0].stateListener({ current: 'connected' });
    await flushStartup();
    assert.equal(f.statuses.length, statusCount, 'retired SDK state events must be ignored');
  });
}

test('simultaneous startup callers share one signaling client', async (t) => {
  const f = startupFixture(t);
  await Promise.all([f.transport.start(), f.transport.start()]);
  assert.equal(f.clients.length, 1);
});

test('closing a board cancels a pending initial connection immediately', async (t) => {
  const f = startupFixture(t, { connect: () => new Promise(() => {}) });
  const starting = observeStartup(f.transport.start());
  await flushStartup();
  await f.transport.disconnect();
  await flushStartup();
  assert.equal(starting.status, 'rejected');
  assert.match(starting.error.message, /closed/i);
  t.mock.timers.tick(60000);
  await flushStartup();
  assert.equal(f.clients.length, 1);
});

test('closing a connected board never waits indefinitely for presence leave', async (t) => {
  const f = startupFixture(t, { leave: () => new Promise(() => {}) });
  await f.transport.start();
  const closing = observeStartup(f.transport.disconnect());
  await flushStartup();
  assert.equal(closing.status, 'fulfilled');
  assert.equal(f.clients[0].closes, 1);
});

test('closing during startup backoff stops every future reconnect', async (t) => {
  const f = startupFixture(t, { connect: async () => { throw new Error('offline'); } });
  const starting = observeStartup(f.transport.start());
  await flushStartup();
  await f.transport.disconnect();
  await flushStartup();
  t.mock.timers.tick(60000);
  await flushStartup();
  assert.equal(starting.status, 'rejected');
  assert.equal(f.clients.length, 1);
  assert.equal(f.clients[0].closes, 1);
});

test('a preview publish interrupted by deliberate board shutdown settles as closed', async (t) => {
  const f = startupFixture(t);
  await f.transport.start();
  let rejectPublish;
  f.clients[0].channel.publish = () => new Promise((_resolve, reject) => { rejectPublish = reject; });
  const result = f.transport.publish('cursor', { x: 1, y: 2 })
    .then(value => ({ value }), error => ({ error }));
  await f.transport.disconnect();
  rejectPublish(new Error('Connection closed'));
  assert.deepEqual(await result, { value: 'closed' }, 'intentional route teardown must not leak an unhandled preview rejection');
});

test('a live Ably publication failure is still rejected, not hidden as shutdown', async (t) => {
  const f = startupFixture(t);
  await f.transport.start();
  const error = new Error('Connection closed');
  f.clients[0].channel.publish = async () => { throw error; };
  await assert.rejects(f.transport.publish('cursor', { x: 1, y: 2 }), failure => failure === error);
});


test('WebRTC-live opt-in advertises capability to Ably transport without changing permission', async () => {
  let transportOptions = null;
  const realtime = connectBoardRealtime({
    boardId: 'board-capability',
    realtimeKey: 'room-key-capability-1234567890',
    clientId: 'student-capability',
    permission: 'edit',
    webrtcLiveV1: true,
  }, {
    createSession: () => ({
      async start() {},
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
  await Promise.resolve();
  assert.equal(transportOptions.permission, 'edit');
  assert.deepEqual(transportOptions.capabilities, { webrtcLiveV1: true });
  await realtime.disconnect();
});


test('ignores legacy Ably live echo from a peer already using WebRTC live while accepting its WebRTC frame', async () => {
  const seen = [];
  const payload = { clientId: 'student-new', x: 4, y: 5 };
  const session = {
    getCollaborationMode: (peerId) => peerId === 'student-new' ? 'webrtc-live-v1' : 'legacy',
  };
  const callbacks = { onCursor: (value) => seen.push(value.x) };

  assert.equal(await routeBrowserRealtimeEvent('cursor', payload, {
    localClientId: 'teacher-a', session, callbacks, source: 'ably',
  }), false);
  assert.deepEqual(seen, []);

  assert.equal(await routeBrowserRealtimeEvent('cursor', payload, {
    localClientId: 'teacher-a', session, callbacks, source: 'webrtc-live',
  }), true);
  assert.deepEqual(seen, [4]);
});

test('legacy peer Ably live event is still routed during mixed-client rollout', async () => {
  const seen = [];
  const session = { getCollaborationMode: () => 'legacy' };
  await routeBrowserRealtimeEvent('cursor', { clientId: 'student-old', x: 7 }, {
    localClientId: 'teacher-a',
    session,
    callbacks: { onCursor: (value) => seen.push(value.x) },
    source: 'ably',
  });
  assert.deepEqual(seen, [7]);
});


test('new-capability peer board-control ignores Ably copy and accepts WebRTC control frame', async () => {
  const seen = [];
  const payload = { clientId: 'student-new', mode: 'edit' };
  const session = { getCollaborationMode: () => 'webrtc-live-v1' };
  const callbacks = { onMode: (mode) => seen.push(mode) };

  assert.equal(await routeBrowserRealtimeEvent('mode', payload, {
    localClientId: 'teacher-a', session, callbacks, source: 'ably',
  }), false);
  assert.deepEqual(seen, []);

  assert.equal(await routeBrowserRealtimeEvent('mode', payload, {
    localClientId: 'teacher-a', session, callbacks, source: 'webrtc-control',
  }), true);
  assert.deepEqual(seen, ['edit']);
});
