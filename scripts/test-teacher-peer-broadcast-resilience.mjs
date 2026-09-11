import assert from 'node:assert/strict';
import test from 'node:test';
import { createTeacherPeerHub } from '../src/lib/teacherPeerHub.js';

function makeTransport(send) {
  return {
    send,
    async sendTextTransfer() {},
  };
}

test('a stale peer transport cannot prevent a durable commit reaching healthy peers', async () => {
  const healthyMessages = [];
  const hub = createTeacherPeerHub({
    authority: { getRevision: () => 7, commitAction: async () => null },
    getSnapshot: async () => ({ snapshot: {}, revision: 7 }),
    getCommitsAfter: async () => [],
  });

  hub.addPeer('stale-student', makeTransport(async () => {
    throw new Error('Peer data channel is closed');
  }));
  hub.addPeer('healthy-student', makeTransport(async (type, payload) => {
    healthyMessages.push({ type, payload });
  }));

  const commit = {
    actionId: 'teacher-image-commit',
    clientId: 'teacher',
    revision: 7,
    ops: [{ type: 'upsert', object: { boardObjectId: 'image-1', type: 'image' } }],
  };

  await hub.broadcastCommit(commit);

  assert.deepEqual(healthyMessages, [{ type: 'commit', payload: commit }]);
});
