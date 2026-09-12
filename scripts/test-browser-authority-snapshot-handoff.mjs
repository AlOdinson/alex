import assert from 'node:assert/strict';
import test from 'node:test';
import { connectBoardRealtime } from '../src/lib/browserAuthorityRealtime.js';

test('full authoritative snapshot is delivered to the board UI instead of being reduced to a revision-only sync', async () => {
  let sessionOptions = null;
  const receivedSnapshots = [];
  let revisionOnlySyncs = 0;

  const realtime = connectBoardRealtime({
    boardId: 'large-board',
    realtimeKey: 'room-key',
    clientId: 'student-a',
    name: 'Student',
    permission: 'edit',
    onSnapshot: async (snapshot, revision) => {
      receivedSnapshots.push({ snapshot, revision });
    },
    onSyncRequired: () => {
      revisionOnlySyncs += 1;
    },
  }, {
    createSession(options) {
      sessionOptions = options;
      return {
        async start() {},
        async updateParticipants() {},
        getRevision() { return 0; },
        handleRealtimeSignal() { return false; },
        close() {},
      };
    },
    createCore() {
      return {
        async disconnect() {},
      };
    },
    createTransport() {
      return {
        async start() {},
        async publish() { return 'ok'; },
        async refreshUsers() { return []; },
        async disconnect() {},
      };
    },
  });

  assert.ok(sessionOptions, 'browser board session was not created');
  const snapshot = {
    version: 2,
    background: 'grid',
    canvas: {
      objects: [
        { type: 'path', boardObjectId: 'teacher-old-1' },
        { type: 'path', boardObjectId: 'teacher-old-2' },
      ],
    },
  };

  await sessionOptions.onAuthoritativeSnapshot(snapshot, 317);

  assert.deepEqual(receivedSnapshots, [{ snapshot, revision: 317 }],
    'the exact teacher snapshot must reach the board UI');
  assert.equal(revisionOnlySyncs, 0,
    'a full snapshot must not be discarded and replaced by a journal-only sync request');

  await realtime.disconnect();
});
