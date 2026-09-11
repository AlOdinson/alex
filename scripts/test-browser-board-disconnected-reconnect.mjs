import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserBoardSession } from '../src/lib/browserBoardSession.js';

test('student retires a disconnected runtime so the same teacher can reconnect immediately', async () => {
  const runtimes = [];
  const closed = [];
  let currentRegistered = null;

  const session = createBrowserBoardSession({
    boardId: 'board-reconnect',
    clientId: 'student-a',
    permission: 'edit',
    sendScreenShareSignal: async () => {},
    getReplica: () => ({ revision: 5 }),
    createStudentRuntime: (options) => {
      const number = runtimes.length + 1;
      const runtime = {
        number,
        teacherId: options.teacherId,
        start: async () => {},
        proposeActionAndWait: async () => ({ accepted: true, revision: 5 }),
        close() { closed.push(number); },
      };
      runtimes.push({ runtime, options });
      return runtime;
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

  runtimes[0].options.onState('disconnected');
  assert.equal(
    currentRegistered,
    null,
    'disconnected runtime must be retired because teacher already retires that peer state',
  );
  assert.deepEqual(closed, [1]);

  await session.updateParticipants(presence);
  const second = currentRegistered;
  assert.equal(second?.number, 2);
  assert.notEqual(second, first);
  assert.equal(second.teacherId, 'teacher-a');

  session.close();
});
