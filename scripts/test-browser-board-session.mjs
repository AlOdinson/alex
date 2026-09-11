import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserBoardSession } from '../src/lib/browserBoardSession.js';

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

test('student waits for owner presence, creates a peer runtime, and applies teacher commits into replica before the board', async () => {
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
  assert.deepEqual(events.at(-1), ['replica-commit', 3]);
  assert.equal(events.filter((entry) => entry[0] === 'board-commit').length, 1);

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
