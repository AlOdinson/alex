import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserPeerConnection } from '../src/lib/browserPeerConnection.js';
import { createBrowserBoardSession } from '../src/lib/browserBoardSession.js';

const flush = async () => { for (let i = 0; i < 40; i += 1) await Promise.resolve(); };
const presence = [{ clientId: 'teacher-a', permission: 'owner' }];

function makePeer() {
  const added = [];
  const peer = {
    remoteDescription: null,
    localDescription: null,
    async setRemoteDescription(description) { this.remoteDescription = description; },
    async createAnswer() { return { type: 'answer', sdp: 'v=0\r\na=ice-ufrag:local\r\n' }; },
    async setLocalDescription(description) { this.localDescription = description; },
    async addIceCandidate(candidate) {
      const ufrag = candidate.usernameFragment;
      if (ufrag && !this.remoteDescription.sdp.includes(`a=ice-ufrag:${ufrag}\r\n`)) {
        throw Object.assign(new Error('ICE candidate belongs to a retired connection'), { name: 'OperationError' });
      }
      added.push(candidate);
    },
    close() {},
  };
  return { peer, added };
}

function sessionOptions(overrides = {}) {
  return {
    boardId: 'board-reconnect', clientId: 'student-a', permission: 'edit',
    sendScreenShareSignal: async () => {},
    getReplica: () => ({ revision: 3 }),
    applyReplicaCommit: () => ({ applied: true }),
    installReplicaSnapshot: () => {},
    registerRuntime: () => () => {},
    ...overrides,
  };
}

function readyRuntime() {
  return { start: async () => {}, close() {}, getRevision: () => 3 };
}

test('late ICE from a retired attempt must not fail the current offer', async (t) => {
  const { peer, added } = makePeer();
  const sent = [];
  const connection = createBrowserPeerConnection({
    createPeerConnection: () => peer, sendSignal: async (s) => sent.push(s),
  });
  t.after(() => connection.close());
  await connection.handleSignal({ type: 'ice', candidate: { usernameFragment: 'old', candidate: 'candidate:old' } });
  await connection.handleSignal({ type: 'ice', candidate: { usernameFragment: 'new', candidate: 'candidate:new' } });
  await assert.doesNotReject(connection.handleSignal({
    type: 'offer', description: { type: 'offer', sdp: 'v=0\r\na=ice-ufrag:new\r\n' },
  }));
  assert.deepEqual(added.map((c) => c.usernameFragment), ['new']);
  assert.equal(sent.filter((s) => s.type === 'answer').length, 1);
});

test('late ICE after remote description is installed must not kill the current attempt', async (t) => {
  const { peer, added } = makePeer();
  const connection = createBrowserPeerConnection({ createPeerConnection: () => peer, sendSignal: async () => {} });
  t.after(() => connection.close());
  await connection.handleSignal({ type: 'offer', description: { type: 'offer', sdp: 'v=0\r\na=ice-ufrag:new\r\n' } });
  await assert.doesNotReject(connection.handleSignal({ type: 'ice', candidate: { usernameFragment: 'old', candidate: 'candidate:old' } }));
  await connection.handleSignal({ type: 'ice', candidate: { usernameFragment: 'new', candidate: 'candidate:new' } });
  assert.equal(added.length, 1);
});

test('candidates without a username fragment remain compatible', async (t) => {
  const { peer, added } = makePeer();
  const connection = createBrowserPeerConnection({ createPeerConnection: () => peer, sendSignal: async () => {} });
  t.after(() => connection.close());
  await connection.handleSignal({ type: 'offer', description: { type: 'offer', sdp: 'v=0\r\na=ice-ufrag:new\r\n' } });
  const candidate = { candidate: 'candidate:legacy', sdpMid: '0' };
  await connection.handleSignal({ type: 'ice', candidate });
  assert.deepEqual(added, [candidate]);
});

test('student retries a failed startup even when presence never changes again', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let starts = 0;
  const working = readyRuntime();
  const session = createBrowserBoardSession(sessionOptions({
    createStudentRuntime: () => ({
      ...working,
      start: async () => { if (++starts === 1) throw new Error('temporary connection failure'); },
    }),
  }));
  t.after(() => session.close());
  await session.start();
  await assert.rejects(session.updateParticipants(presence), /temporary connection failure/);
  assert.equal(session.getRuntime(), null);
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(starts, 2, 'retry must not depend on another Ably presence event');
  assert.equal(session.getRuntimeState(), 'ready');
});

test('a disconnected student retries without another presence notification', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const options = [];
  const session = createBrowserBoardSession(sessionOptions({ createStudentRuntime: (opts) => { options.push(opts); return readyRuntime(); } }));
  t.after(() => session.close());
  await session.start();
  await session.updateParticipants(presence);
  options[0].onState('failed');
  assert.equal(session.getRuntime(), null);
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(options.length, 2);
  assert.equal(session.getRuntimeState(), 'ready');
});

test('startup rejected after closure must not overwrite the closed state', async () => {
  let rejectStart;
  const events = [];
  const session = createBrowserBoardSession(sessionOptions({
    onRuntimeState: (state) => events.push(state),
    createStudentRuntime: () => ({
      start: () => new Promise((_, reject) => { rejectStart = reject; }), close() {},
    }),
  }));
  await session.start();
  const task = session.updateParticipants(presence);
  const rejected = assert.rejects(task, /retired/);
  await flush();
  session.close();
  rejectStart(new Error('retired'));
  await rejected;
  assert.equal(session.getRuntimeState(), 'closed');
  assert.equal(events.at(-1), 'closed');
});

test('a queued presence update does not start a new runtime after session closure', async () => {
  let creates = 0;
  const session = createBrowserBoardSession(sessionOptions({ createStudentRuntime: () => { creates++; return readyRuntime(); } }));
  await session.start();
  const pending = session.updateParticipants(presence);
  session.close();
  await pending;
  assert.equal(creates, 0);
  assert.equal(session.getRuntimeState(), 'closed');
});

test('retry stops when the teacher leaves before the retry timer fires', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let creates = 0;
  const session = createBrowserBoardSession(sessionOptions({ createStudentRuntime: () => {
    creates++;
    return { start: async () => { throw new Error('temporary'); }, close() {} };
  } }));
  t.after(() => session.close());
  await session.start();
  await assert.rejects(session.updateParticipants(presence), /temporary/);
  await session.updateParticipants([]);
  t.mock.timers.tick(60000);
  await flush();
  assert.equal(creates, 1);
  assert.equal(session.getRuntimeState(), 'teacher-offline');
});

test('closing a failed session cancels its automatic retry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let creates = 0;
  const session = createBrowserBoardSession(sessionOptions({ createStudentRuntime: () => {
    creates++;
    return { start: async () => { throw new Error('temporary'); }, close() {} };
  } }));
  await session.start();
  await assert.rejects(session.updateParticipants(presence), /temporary/);
  session.close();
  t.mock.timers.tick(60000);
  await flush();
  assert.equal(creates, 1);
  assert.equal(session.getRuntimeState(), 'closed');
});

test('a future-generation candidate is retained until its SDP arrives', async (t) => {
  const { peer, added } = makePeer();
  const connection = createBrowserPeerConnection({ createPeerConnection: () => peer, sendSignal: async () => {} });
  t.after(() => connection.close());
  await connection.handleSignal({ type: 'offer', description: { type: 'offer', sdp: 'v=0\r\na=ice-ufrag:first\r\n' } });
  await connection.handleSignal({ type: 'ice', candidate: { usernameFragment: 'next', candidate: 'candidate:next' } });
  assert.equal(added.length, 0);
  await connection.handleSignal({ type: 'offer', description: { type: 'offer', sdp: 'v=0\r\na=ice-ufrag:next\r\n' } });
  assert.equal(added[0].usernameFragment, 'next');
});

test('a genuine current-generation ICE error is not hidden by recovery', async (t) => {
  const { peer } = makePeer();
  peer.addIceCandidate = async () => { throw new TypeError('malformed current candidate'); };
  const connection = createBrowserPeerConnection({ createPeerConnection: () => peer, sendSignal: async () => {} });
  t.after(() => connection.close());
  await connection.handleSignal({ type: 'offer', description: { type: 'offer', sdp: 'v=0\r\na=ice-ufrag:new\r\n' } });
  await assert.rejects(connection.handleSignal({ type: 'ice', candidate: { usernameFragment: 'new', candidate: 'bad' } }), /malformed current candidate/);
});

test('automatic retries back off instead of spinning on a persistently unavailable peer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let starts = 0;
  const session = createBrowserBoardSession(sessionOptions({ createStudentRuntime: () => ({
    start: async () => { starts++; throw new Error('still unavailable'); }, close() {},
  }) }));
  t.after(() => session.close());
  await session.start();
  await assert.rejects(session.updateParticipants(presence), /still unavailable/);
  for (const delay of [1000, 2000, 4000, 8000, 15000, 15000]) {
    const previous = starts;
    t.mock.timers.tick(delay - 1);
    await flush();
    assert.equal(starts, previous);
    t.mock.timers.tick(1);
    await flush();
    assert.equal(starts, previous + 1);
  }
});

test('a runtime construction failure can recover without reloading the page', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let creates = 0;
  const session = createBrowserBoardSession(sessionOptions({ createStudentRuntime: () => {
    if (++creates === 1) throw new Error('temporary construction failure');
    return readyRuntime();
  } }));
  t.after(() => session.close());
  await session.start();
  await assert.rejects(session.updateParticipants(presence), /temporary construction failure/);
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(session.getRuntimeState(), 'ready');
  assert.equal(creates, 2);
});

test('multiple presence notifications do not create parallel student runtimes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let creates = 0;
  let finish;
  const session = createBrowserBoardSession(sessionOptions({ createStudentRuntime: () => {
    creates++;
    return { ...readyRuntime(), start: () => new Promise((resolve) => { finish = resolve; }) };
  } }));
  t.after(() => session.close());
  await session.start();
  const first = session.updateParticipants(presence);
  const second = session.updateParticipants(presence);
  await flush();
  t.mock.timers.tick(60000);
  await flush();
  assert.equal(creates, 1);
  finish();
  await Promise.all([first, second]);
  assert.equal(creates, 1);
  assert.equal(session.getRuntimeState(), 'ready');
});

test('a stale failed callback must not disturb a replacement runtime', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const options = [];
  const peerStates = [];
  const session = createBrowserBoardSession(sessionOptions({
    onPeerState: (state) => peerStates.push(state),
    createStudentRuntime: (opts) => { options.push(opts); return readyRuntime(); },
  }));
  t.after(() => session.close());
  await session.start();
  await session.updateParticipants(presence);
  options[0].onState('failed');
  await session.updateParticipants(presence);
  const current = session.getRuntime();
  const count = peerStates.length;
  options[0].onState('failed');
  assert.equal(session.getRuntime(), current);
  assert.equal(session.getRuntimeState(), 'ready');
  assert.equal(peerStates.length, count, 'retired callbacks must not trigger external recovery observers');
  t.mock.timers.tick(60000);
  await flush();
  assert.equal(options.length, 2);
});

test('retry uses the latest teacher rather than stale presence from a failed attempt', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const teachers = [];
  const session = createBrowserBoardSession(sessionOptions({ createStudentRuntime: ({ teacherId }) => {
    teachers.push(teacherId);
    return { ...readyRuntime(), start: async () => { if (teacherId === 'teacher-a') throw new Error('left'); } };
  } }));
  t.after(() => session.close());
  await session.start();
  await assert.rejects(session.updateParticipants(presence), /left/);
  await session.updateParticipants([{ clientId: 'teacher-b', permission: 'owner' }]);
  t.mock.timers.tick(60000);
  await flush();
  assert.deepEqual(teachers, ['teacher-a', 'teacher-b']);
  assert.equal(session.getRuntimeState(), 'ready');
});
