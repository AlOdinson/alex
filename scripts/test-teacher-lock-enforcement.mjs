import assert from 'node:assert/strict';
import test from 'node:test';
import { createTeacherObjectLockAuthority } from '../src/lib/teacherObjectLocks.js';
import { createTeacherPeerHub } from '../src/lib/teacherPeerHub.js';

function makeTransport() {
  return {
    sent: [],
    async send(type, payload) { this.sent.push({ type, payload }); },
    async sendTextTransfer() {},
  };
}

test('teacher lock authority reports conflicts for durable mutations', () => {
  const locks = createTeacherObjectLockAuthority({ now: () => 1_000 });
  locks.acquire({
    clientId: 'student-a', lockToken: 'token-student-a', objectIds: ['shape-1'], ttlMs: 12_000,
  });

  assert.equal(typeof locks.getConflicts, 'function');
  assert.deepEqual(locks.getConflicts({
    clientId: 'student-a', objectIds: ['shape-1'],
  }), []);
  assert.deepEqual(locks.getConflicts({
    clientId: 'student-b', objectIds: ['shape-1', 'shape-2'],
  }), [{ objectId: 'shape-1', clientId: 'student-a', expiresAt: 13_000 }]);
});

test('teacher hub rejects a peer durable action that touches another clients lock', async () => {
  const peer = makeTransport();
  let commitCalls = 0;
  const lockAuthority = {
    getConflicts({ clientId, objectIds }) {
      assert.equal(clientId, 'student-b');
      assert.deepEqual(objectIds, ['shape-1']);
      return [{ objectId: 'shape-1', clientId: 'student-a', expiresAt: 13_000 }];
    },
  };
  const hub = createTeacherPeerHub({
    authority: {
      getRevision: () => 7,
      async commitAction() { commitCalls += 1; return null; },
    },
    getSnapshot: async () => ({ snapshot: {}, revision: 7 }),
    getCommitsAfter: async () => [],
    lockAuthority,
  });
  hub.addPeer('student-b', peer);

  await hub.handleMessage('student-b', {
    type: 'action-proposal',
    payload: {
      actionId: 'blocked-action',
      clientId: 'student-a',
      baseRevision: 7,
      ops: [{ type: 'delete', id: 'shape-1' }],
    },
  });

  assert.equal(commitCalls, 0);
  assert.deepEqual(peer.sent, [{
    type: 'ack',
    payload: {
      actionId: 'blocked-action',
      revision: 7,
      accepted: false,
      duplicate: false,
      needsSync: false,
      changed: false,
      appliedOps: [],
      appliedBackground: null,
      skippedConflicts: [],
      rejectedObjectIds: ['shape-1'],
      error: 'Object locked by another participant',
    },
  }]);
});

test('teacher hub derives action clientId from the authenticated peer identity', async () => {
  const peer = makeTransport();
  const committed = [];
  const hub = createTeacherPeerHub({
    authority: {
      getRevision: () => 0,
      async commitAction(action) {
        committed.push(action);
        return { ...action, revision: 1, duplicate: false, needsSync: false };
      },
    },
    getSnapshot: async () => ({ snapshot: {}, revision: 0 }),
    getCommitsAfter: async () => [],
    lockAuthority: { getConflicts: () => [] },
  });
  hub.addPeer('student-real', peer);

  await hub.handleMessage('student-real', {
    type: 'action-proposal',
    payload: {
      actionId: 'identity-action',
      clientId: 'student-spoofed',
      baseRevision: 0,
      ops: [{ type: 'delete', id: 'shape-1' }],
    },
  });

  assert.equal(committed.length, 1);
  assert.equal(committed[0].clientId, 'student-real');
});
