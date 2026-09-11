import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserBoardSession } from '../src/lib/browserBoardSession.js';

function createRuntime() {
  return {
    getRevision: () => 0,
    commitTeacherAction: async (action) => ({
      ...action,
      revision: 1,
      changed: true,
      appliedOps: action.ops,
    }),
    close() {},
  };
}

test('owner reports waiting until the exclusive authority lock installs the runtime', async () => {
  const states = [];
  let authorityChange = null;
  let releaseLease = null;
  let authorityHeld = false;

  const session = createBrowserBoardSession({
    boardId: 'readiness-board',
    clientId: 'teacher-readiness',
    permission: 'owner',
    sendScreenShareSignal: async () => {},
    onRuntimeState: (state) => states.push(state),
    createTeacherTabAuthority: ({ onChange }) => {
      authorityChange = onChange;
      return {
        start() {
          return new Promise((resolve) => { releaseLease = resolve; });
        },
        stop() {
          authorityHeld = false;
          onChange(false);
          releaseLease?.();
        },
        isAuthority() { return authorityHeld; },
      };
    },
    createTeacherRuntime: async () => createRuntime(),
    registerRuntime: () => () => {},
  });

  const startTask = session.start();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(session.getRuntimeState?.(), 'waiting');
  assert.deepEqual(states, ['waiting']);

  authorityHeld = true;
  authorityChange(true);
  await startTask;
  assert.equal(session.getRuntimeState?.(), 'ready');
  assert.deepEqual(states, ['waiting', 'ready']);
  session.close();
});

test('runtime startup failure rejects readiness waiters instead of leaving durable writes pending forever', async () => {
  const states = [];
  const startupError = new Error('authority startup failed');
  const session = createBrowserBoardSession({
    boardId: 'failed-readiness-board',
    clientId: 'teacher-failed-readiness',
    permission: 'owner',
    sendScreenShareSignal: async () => {},
    onRuntimeState: (state) => states.push(state),
    createTeacherTabAuthority: ({ onChange }) => ({
      start() {
        onChange(true);
        return new Promise(() => {});
      },
      stop() { onChange(false); },
      isAuthority() { return true; },
    }),
    createTeacherRuntime: async () => { throw startupError; },
    registerRuntime: () => () => {},
  });

  const readyTask = session.whenRuntimeReady().then(
    () => 'resolved',
    (error) => error,
  );
  await assert.rejects(session.start(), /authority startup failed/);
  const readyResult = await Promise.race([
    readyTask,
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 60)),
  ]);

  assert.notEqual(readyResult, 'timeout', 'runtime readiness waiter must not hang after startup failure');
  assert.equal(readyResult, startupError);
  assert.equal(session.getRuntimeState?.(), 'error');
  assert.deepEqual(states, ['waiting', 'error']);
  session.close();
});
