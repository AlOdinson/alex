import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserBoardSession } from '../src/lib/browserBoardSession.js';

function createImmediateTeacherTabAuthority({ onChange = () => {} } = {}) {
  let authority = false;
  let release = null;
  return {
    start() {
      authority = true;
      onChange(true);
      return new Promise((resolve) => { release = resolve; });
    },
    stop() {
      if (authority) {
        authority = false;
        onChange(false);
      }
      release?.();
      release = null;
    },
    isAuthority() { return authority; },
  };
}

test('owner starts one teacher runtime, registers it, and routes remote durable commits to the board', async () => {
  const events = [];
  const teacherRuntime = {
    getRevision: () => 3,
    async commitTeacherAction(action) { return { ...action, revision: 4, changed: true, appliedOps: action.ops }; },
    handleRealtimeSignal(payload) { events.push(['signal', payload]); return true; },
    requestLock: async () => ({ granted: true }),
    close() { events.push(['close']); },
  };
  let teacherOptions;
  let registeredRuntime = null;
  const session = createBrowserBoardSession({
    boardId: 'board-a',
    clientId: 'teacher-a',
    permission: 'owner',
    sendScreenShareSignal: async () => {},
    onAuthoritativeCommit: async (commit) => events.push(['commit', commit.revision]),
    createTeacherTabAuthority: createImmediateTeacherTabAuthority,
    createTeacherRuntime: async (options) => { teacherOptions = options; return teacherRuntime; },
    registerRuntime: (_boardId, runtime) => {
      registeredRuntime = runtime;
      return () => { registeredRuntime = null; events.push(['unregister']); };
    },
  });

  await session.start();
  assert.equal(await session.whenRuntimeReady(), teacherRuntime);
  assert.equal(registeredRuntime, teacherRuntime);
  assert.equal(teacherOptions.boardId, 'board-a');
  assert.equal(teacherOptions.clientId, 'teacher-a');
  await teacherOptions.onRemoteCommit({ actionId: 'student-action', revision: 4, ops: [] });
  assert.deepEqual(events, [['commit', 4]]);

  const result = await session.sendOps([{ type: 'delete', id: 'x' }], { actionId: 'teacher-action' });
  assert.equal(result.revision, 4);
  assert.equal(result.accepted, true);

  session.handleRealtimeSignal({ protocol: 'peer' });
  assert.deepEqual(events.at(-1), ['signal', { protocol: 'peer' }]);
  session.close();
  assert.deepEqual(events.slice(-2), [['unregister'], ['close']]);
});

test('owner waits for exclusive tab authority before creating the teacher runtime', async () => {
  let authorityChange = null;
  let releaseLease = null;
  let authorityHeld = false;
  let runtimeStarts = 0;
  let leaseStops = 0;

  const session = createBrowserBoardSession({
    boardId: 'board-exclusive',
    clientId: 'teacher-exclusive',
    permission: 'owner',
    sendScreenShareSignal: async () => {},
    createTeacherTabAuthority: ({ boardId, onChange }) => {
      assert.equal(boardId, 'board-exclusive');
      authorityChange = onChange;
      return {
        start() {
          return new Promise((resolve) => { releaseLease = resolve; });
        },
        stop() {
          leaseStops += 1;
          authorityHeld = false;
          onChange(false);
          releaseLease?.();
        },
        isAuthority() { return authorityHeld; },
      };
    },
    createTeacherRuntime: async () => {
      runtimeStarts += 1;
      return {
        getRevision: () => 0,
        commitTeacherAction: async (action) => ({ ...action, revision: 1, changed: true, appliedOps: action.ops }),
        close() {},
      };
    },
    registerRuntime: () => () => {},
  });

  let started = false;
  const startTask = session.start().then((value) => {
    started = true;
    return value;
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(runtimeStarts, 0, 'teacher runtime must not exist before this tab owns the board lock');
  assert.equal(started, false);
  assert.equal(typeof authorityChange, 'function');

  authorityHeld = true;
  authorityChange(true);
  await startTask;
  assert.equal(runtimeStarts, 1);
  assert.equal(started, true);

  session.close();
  assert.equal(leaseStops, 1);
});

test('student waits for owner presence, creates a peer runtime, and applies all authority commits into replica before the board', async () => {
  const events = [];
  let studentOptions;
  let registeredRuntime = null;
  const replica = { revision: 0, snapshot: { version: 2, canvas: { objects: [] } } };
  const studentRuntime = {
    async start() { events.push(['start']); },
    async proposeActionAndWait(action) {
      events.push(['proposal', action.actionId, action.baseRevision]);
      return { actionId: action.actionId, revision: 3, accepted: true, changed: true, appliedOps: action.ops };
    },
    handleRealtimeSignal(payload) { events.push(['signal', payload]); return true; },
    requestLock: async () => ({ granted: true }),
    close() { events.push(['close']); },
  };

  const session = createBrowserBoardSession({
    boardId: 'board-a',
    clientId: 'student-a',
    permission: 'edit',
    sendScreenShareSignal: async () => {},
    getReplica: () => ({ ...replica }),
    applyReplicaCommit: (_boardId, commit) => {
      replica.revision = commit.revision;
      events.push(['replica-commit', commit.revision]);
      return { applied: true, needsSnapshot: false, revision: replica.revision };
    },
    installReplicaSnapshot: (_boardId, snapshot, revision) => {
      replica.snapshot = snapshot;
      replica.revision = revision;
      events.push(['replica-snapshot', revision]);
    },
    onAuthoritativeCommit: async (commit) => events.push(['board-commit', commit.revision]),
    onAuthoritativeSnapshot: async (_snapshot, revision) => events.push(['board-snapshot', revision]),
    createStudentRuntime: (options) => { studentOptions = options; return studentRuntime; },
    registerRuntime: (_boardId, runtime) => {
      registeredRuntime = runtime;
      return () => { registeredRuntime = null; events.push(['unregister']); };
    },
  });

  await session.start();
  let readySettled = false;
  const readyTask = session.whenRuntimeReady().then((value) => { readySettled = true; return value; });
  await Promise.resolve();
  assert.equal(readySettled, false);
  assert.equal(registeredRuntime, null);
  await session.updateParticipants([
    { clientId: 'student-a', permission: 'edit' },
    { clientId: 'teacher-a', permission: 'owner' },
  ]);
  assert.equal(await readyTask, studentRuntime);
  assert.equal(studentOptions.teacherId, 'teacher-a');
  assert.equal(registeredRuntime, studentRuntime);
  assert.deepEqual(events[0], ['start']);

  await studentOptions.installSnapshot({ version: 2, background: 'dots', canvas: { objects: [] } }, 1);
  assert.deepEqual(events.slice(-2), [['replica-snapshot', 1], ['board-snapshot', 1]]);
  await studentOptions.applyCommit({ actionId: 'teacher-action', clientId: 'teacher-a', revision: 2, ops: [] });
  assert.deepEqual(events.slice(-2), [['replica-commit', 2], ['board-commit', 2]]);

  await studentOptions.applyCommit({ actionId: 'student-own-action', clientId: 'student-a', revision: 3, ops: [] });
  assert.deepEqual(events.slice(-2), [['replica-commit', 3], ['board-commit', 3]]);
  assert.equal(events.filter((entry) => entry[0] === 'board-commit').length, 2);

  const result = await session.sendOps([{ type: 'delete', id: 'x' }], { actionId: 'student-action' });
  assert.equal(result.accepted, true);
  assert.deepEqual(events.at(-1), ['proposal', 'student-action', 3]);
});

test('student replaces the peer runtime when teacher presence changes and stale cleanup cannot remove the replacement', async () => {
  const closed = [];
  let runtimeNumber = 0;
  let currentRegistered = null;
  const session = createBrowserBoardSession({
    boardId: 'board-a',
    clientId: 'student-a',
    permission: 'edit',
    sendScreenShareSignal: async () => {},
    getReplica: () => ({ revision: 0 }),
    createStudentRuntime: ({ teacherId }) => {
      runtimeNumber += 1;
      const number = runtimeNumber;
      return {
        teacherId,
        start: async () => {},
        proposeActionAndWait: async () => ({ accepted: true, revision: 0 }),
        handleRealtimeSignal: () => true,
        close() { closed.push(number); },
      };
    },
    registerRuntime: (_boardId, runtime) => {
      currentRegistered = runtime;
      let active = true;
      return () => {
        if (!active) return false;
        active = false;
        if (currentRegistered !== runtime) return false;
        currentRegistered = null;
        return true;
      };
    },
  });

  await session.start();
  await session.updateParticipants([{ clientId: 'teacher-a', permission: 'owner' }]);
  const first = currentRegistered;
  await session.updateParticipants([{ clientId: 'teacher-b', permission: 'owner' }]);
  const second = currentRegistered;
  assert.notEqual(first, second);
  assert.equal(second.teacherId, 'teacher-b');
  assert.deepEqual(closed, [1]);
});

test('student can recreate a failed peer runtime for the same teacher after presence refresh', async () => {
  const runtimes = [];
  const closed = [];
  let currentRegistered = null;
  const session = createBrowserBoardSession({
    boardId: 'board-a',
    clientId: 'student-a',
    permission: 'edit',
    sendScreenShareSignal: async () => {},
    getReplica: () => ({ revision: 7 }),
    createStudentRuntime: (options) => {
      const number = runtimes.length + 1;
      const next = {
        number,
        teacherId: options.teacherId,
        start: async () => {},
        proposeActionAndWait: async () => ({ accepted: true, revision: 7 }),
        close() { closed.push(number); },
      };
      runtimes.push({ runtime: next, options });
      return next;
    },
    registerRuntime: (_boardId, runtime) => {
      currentRegistered = runtime;
      return () => {
        if (currentRegistered !== runtime) return false;
        currentRegistered = null;
        return true;
      };
    },
  });

  const presence = [{ clientId: 'teacher-a', permission: 'owner' }];
  await session.start();
  await session.updateParticipants(presence);
  const first = currentRegistered;
  assert.equal(first?.number, 1);

  runtimes[0].options.onState('failed');
  assert.equal(currentRegistered, null, 'failed student runtime must be unregistered before reconnect');
  assert.deepEqual(closed, [1]);

  await session.updateParticipants(presence);
  const second = currentRegistered;
  assert.equal(second?.number, 2);
  assert.notEqual(second, first);
  assert.equal(second.teacherId, 'teacher-a');
});


test('student enables WebRTC live only when both local opt-in and owner capability are present', async () => {
  const created = [];
  const session = createBrowserBoardSession({
    boardId: 'board-live-capability',
    clientId: 'student-live-capability',
    permission: 'edit',
    webrtcLiveV1: true,
    localCapabilities: { webrtcLiveV1: true },
    sendScreenShareSignal: async () => {},
    getReplica: () => ({ revision: 0 }),
    createStudentRuntime: (options) => {
      created.push(options);
      return {
        start: async () => {},
        proposeActionAndWait: async () => ({ accepted: true, revision: 0 }),
        close() {},
      };
    },
    registerRuntime: () => () => {},
  });

  await session.start();
  await session.updateParticipants([{
    clientId: 'teacher-new',
    permission: 'owner',
    capabilities: { webrtcLiveV1: true },
  }]);

  assert.equal(created.length, 1);
  assert.equal(created[0].boardId, 'board-live-capability');
  assert.equal(created[0].teacherId, 'teacher-new');
  assert.equal(created[0].webrtcLiveEnabled, true);
  assert.equal(session.getCollaborationMode('teacher-new'), 'webrtc-live-v1');
  session.close();
});

test('student keeps legacy transport when owner does not advertise WebRTC live capability', async () => {
  let studentOptions = null;
  const session = createBrowserBoardSession({
    boardId: 'board-live-legacy',
    clientId: 'student-live-legacy',
    permission: 'edit',
    webrtcLiveV1: true,
    localCapabilities: { webrtcLiveV1: true },
    sendScreenShareSignal: async () => {},
    getReplica: () => ({ revision: 0 }),
    createStudentRuntime: (options) => {
      studentOptions = options;
      return {
        start: async () => {},
        proposeActionAndWait: async () => ({ accepted: true, revision: 0 }),
        close() {},
      };
    },
    registerRuntime: () => () => {},
  });

  await session.start();
  await session.updateParticipants([{ clientId: 'teacher-legacy', permission: 'owner' }]);

  assert.equal(studentOptions.webrtcLiveEnabled, false);
  assert.equal(session.getCollaborationMode('teacher-legacy'), 'legacy');
  session.close();
});

test('student recreates the same-teacher runtime when live capability mode changes', async () => {
  const created = [];
  const closed = [];
  let current = null;
  const session = createBrowserBoardSession({
    boardId: 'board-live-upgrade',
    clientId: 'student-live-upgrade',
    permission: 'edit',
    webrtcLiveV1: true,
    localCapabilities: { webrtcLiveV1: true },
    sendScreenShareSignal: async () => {},
    getReplica: () => ({ revision: 4 }),
    createStudentRuntime: (options) => {
      const number = created.length + 1;
      const runtime = {
        number,
        start: async () => {},
        proposeActionAndWait: async () => ({ accepted: true, revision: 4 }),
        close() { closed.push(number); },
      };
      created.push({ options, runtime });
      return runtime;
    },
    registerRuntime: (_boardId, runtime) => {
      current = runtime;
      return () => { if (current === runtime) current = null; };
    },
  });

  await session.start();
  await session.updateParticipants([{ clientId: 'teacher-a', permission: 'owner' }]);
  assert.equal(created[0].options.webrtcLiveEnabled, false);

  await session.updateParticipants([{
    clientId: 'teacher-a',
    permission: 'owner',
    capabilities: { webrtcLiveV1: true },
  }]);

  assert.equal(created.length, 2);
  assert.equal(created[1].options.webrtcLiveEnabled, true);
  assert.deepEqual(closed, [1]);
  assert.equal(current?.number, 2);
  session.close();
});
