import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserBoardSession } from '../src/lib/browserBoardSession.js';

test('student applies its own accepted authority commit back into the board UI', async () => {
  const events = [];
  let studentOptions = null;
  const replica = { revision: 0 };

  const session = createBrowserBoardSession({
    boardId: 'board-self-commit',
    clientId: 'student-a',
    permission: 'edit',
    sendScreenShareSignal: async () => {},
    getReplica: () => ({ ...replica }),
    applyReplicaCommit: (_boardId, commit) => {
      replica.revision = Number(commit.revision ?? replica.revision);
      events.push(['replica-commit', commit.actionId, commit.revision]);
      return { applied: true, needsSnapshot: false, revision: replica.revision };
    },
    onAuthoritativeCommit: async (commit) => {
      events.push(['board-commit', commit.actionId, commit.revision, commit.clientId]);
    },
    createStudentRuntime: (options) => {
      studentOptions = options;
      return {
        async start() {},
        async proposeActionAndWait(action) {
          return {
            actionId: action.actionId,
            clientId: 'student-a',
            revision: 1,
            accepted: true,
            changed: true,
            appliedOps: action.ops,
          };
        },
        handleRealtimeSignal() { return true; },
        close() {},
      };
    },
    registerRuntime: () => () => {},
  });

  await session.start();
  await session.updateParticipants([
    { clientId: 'student-a', permission: 'edit' },
    { clientId: 'teacher-a', permission: 'owner' },
  ]);

  assert.ok(studentOptions, 'student runtime must be created after teacher presence');

  const selfCommit = {
    actionId: 'student-delete',
    clientId: 'student-a',
    revision: 1,
    ops: [{ type: 'delete', id: 'teacher-object' }],
  };
  await studentOptions.applyCommit(selfCommit);

  assert.deepEqual(events, [
    ['replica-commit', 'student-delete', 1],
    ['board-commit', 'student-delete', 1, 'student-a'],
  ], 'the authority commit must be the final UI state even on the originating student');

  session.close();
});
