import assert from 'node:assert/strict';
import test from 'node:test';
import { createTeacherPeerHub } from '../src/lib/teacherPeerHub.js';

function makeTransport() {
  return {
    sent: [],
    async send(type, payload) { this.sent.push({ type, payload }); },
    async sendTextTransfer() {},
  };
}

function makeHub() {
  return createTeacherPeerHub({
    authority: { getRevision: () => 0, commitAction: async () => null },
    getSnapshot: async () => ({ snapshot: {}, revision: 0 }),
    getCommitsAfter: async () => [],
  });
}

async function lockRequest(hub, peerId, requestId, operation, payload = {}) {
  await hub.handleMessage(peerId, {
    type: 'lock-request',
    payload: { requestId, operation, ...payload },
  });
}

test('peer can refresh and release its teacher-authoritative lock lease', async () => {
  const peer = makeTransport();
  const hub = makeHub();
  hub.addPeer('student-a', peer);

  await lockRequest(hub, 'student-a', 'acquire-1', 'acquire', {
    lockToken: 'token-student-a', objectIds: ['shape-1'], ttlMs: 12_000,
  });
  assert.equal(peer.sent.at(-1)?.payload?.granted, true);

  await lockRequest(hub, 'student-a', 'refresh-1', 'refresh', {
    lockToken: 'token-student-a', ttlMs: 12_000,
  });
  const refreshed = peer.sent.at(-1);
  assert.equal(refreshed?.type, 'lock-result');
  assert.equal(refreshed?.payload?.operation, 'refresh');
  assert.equal(refreshed?.payload?.refreshed, true);
  assert.deepEqual(refreshed?.payload?.objectIds, ['shape-1']);

  await lockRequest(hub, 'student-a', 'release-1', 'release', {
    lockToken: 'token-student-a',
  });
  const released = peer.sent.at(-1);
  assert.equal(released?.type, 'lock-result');
  assert.equal(released?.payload?.operation, 'release');
  assert.equal(released?.payload?.released, 1);
  assert.deepEqual(released?.payload?.objectIds, ['shape-1']);
});

test('removing a peer immediately releases all of its locks', async () => {
  const peerA = makeTransport();
  const peerB = makeTransport();
  const hub = makeHub();
  hub.addPeer('student-a', peerA);
  hub.addPeer('student-b', peerB);

  await lockRequest(hub, 'student-a', 'a-1', 'acquire', {
    lockToken: 'token-student-a', objectIds: ['shape-1'], ttlMs: 12_000,
  });
  assert.equal(peerA.sent.at(-1)?.payload?.granted, true);

  hub.removePeer('student-a');

  await lockRequest(hub, 'student-b', 'b-1', 'acquire', {
    lockToken: 'token-student-b', objectIds: ['shape-1'], ttlMs: 12_000,
  });
  assert.equal(peerB.sent.at(-1)?.payload?.granted, true);
});
