import assert from 'node:assert/strict';
import test from 'node:test';
import { createTeacherPeerHub } from '../src/lib/teacherPeerHub.js';

function makeTransport() {
  return {
    sent: [],
    transfers: [],
    async send(type, payload) { this.sent.push({ type, payload }); },
    async sendTextTransfer(kind, text, options) { this.transfers.push({ kind, text, options }); },
  };
}

test('answers head requests from the teacher authority revision', async () => {
  const transport = makeTransport();
  const hub = createTeacherPeerHub({
    authority: { getRevision: () => 42, commitAction: async () => null },
    getSnapshot: async () => ({ snapshot: {}, revision: 42 }),
    getCommitsAfter: async () => [],
  });
  hub.addPeer('student-a', transport);
  await hub.handleMessage('student-a', { type: 'head-request', payload: {} });
  assert.deepEqual(transport.sent, [{ type: 'head', payload: { revision: 42 } }]);
});

test('persists a new proposal before broadcasting commit and ack', async () => {
  const order = [];
  const peerA = makeTransport();
  const peerB = makeTransport();
  peerA.send = async function send(type, payload) { order.push(`A:${type}`); this.sent.push({ type, payload }); };
  peerB.send = async function send(type, payload) { order.push(`B:${type}`); this.sent.push({ type, payload }); };
  const authority = {
    revision: 5,
    getRevision() { return this.revision; },
    async commitAction(action) {
      order.push('persist');
      this.revision += 1;
      return { ...action, revision: this.revision, duplicate: false, needsSync: false };
    },
  };
  const hub = createTeacherPeerHub({
    authority,
    getSnapshot: async () => ({ snapshot: {}, revision: authority.revision }),
    getCommitsAfter: async () => [],
  });
  hub.addPeer('student-a', peerA);
  hub.addPeer('student-b', peerB);
  await hub.handleMessage('student-a', {
    type: 'action-proposal',
    payload: { actionId: 'action-1', clientId: 'student-a', baseRevision: 5, ops: [{ type: 'delete', id: 'x' }] },
  });
  assert.equal(order[0], 'persist');
  assert.deepEqual(order.slice(1), ['A:commit', 'B:commit', 'A:ack']);
  assert.equal(peerA.sent[0].payload.revision, 6);
  assert.equal(peerB.sent[0].payload.revision, 6);
  assert.deepEqual(peerA.sent[1], {
    type: 'ack',
    payload: { actionId: 'action-1', revision: 6, accepted: true, duplicate: false, needsSync: false },
  });
});

test('a duplicate proposal is not rebroadcast to unrelated peers', async () => {
  const peerA = makeTransport();
  const peerB = makeTransport();
  const hub = createTeacherPeerHub({
    authority: {
      getRevision: () => 9,
      commitAction: async (action) => ({ ...action, revision: 9, duplicate: true, needsSync: false }),
    },
    getSnapshot: async () => ({ snapshot: {}, revision: 9 }),
    getCommitsAfter: async () => [],
  });
  hub.addPeer('student-a', peerA);
  hub.addPeer('student-b', peerB);
  await hub.handleMessage('student-a', {
    type: 'action-proposal', payload: { actionId: 'action-old', baseRevision: 8, ops: [] },
  });
  assert.equal(peerB.sent.length, 0);
  assert.equal(peerA.sent[0].type, 'commit');
  assert.equal(peerA.sent[1].type, 'ack');
  assert.equal(peerA.sent[1].payload.duplicate, true);
});

test('sync request sends a contiguous journal instead of a snapshot', async () => {
  const transport = makeTransport();
  const commits = [
    { actionId: 'a6', revision: 6, ops: [] },
    { actionId: 'a7', revision: 7, ops: [] },
  ];
  const hub = createTeacherPeerHub({
    authority: { getRevision: () => 7, commitAction: async () => null },
    getSnapshot: async () => ({ snapshot: { full: true }, revision: 7 }),
    getCommitsAfter: async () => commits,
  });
  hub.addPeer('student-a', transport);
  await hub.handleMessage('student-a', { type: 'sync-request', payload: { revision: 5 } });
  assert.deepEqual(transport.sent.map((entry) => entry.type), ['commit', 'commit', 'head']);
  assert.equal(transport.transfers.length, 0);
});

test('sync request falls back to a snapshot when the journal has a gap', async () => {
  const transport = makeTransport();
  const hub = createTeacherPeerHub({
    authority: { getRevision: () => 8, commitAction: async () => null },
    getSnapshot: async () => ({ snapshot: { full: true }, revision: 8 }),
    getCommitsAfter: async () => [{ actionId: 'a8', revision: 8, ops: [] }],
    createTransferId: () => 'snapshot-transfer',
  });
  hub.addPeer('student-a', transport);
  await hub.handleMessage('student-a', { type: 'sync-request', payload: { revision: 5 } });
  assert.equal(transport.sent.length, 0);
  assert.equal(transport.transfers.length, 1);
  assert.equal(transport.transfers[0].kind, 'snapshot');
  assert.equal(transport.transfers[0].options.transferId, 'snapshot-transfer');
  assert.deepEqual(JSON.parse(transport.transfers[0].text), { snapshot: { full: true }, revision: 8 });
});

test('broadcasts a teacher-originated durable commit to every connected peer', async () => {
  const peerA = makeTransport();
  const peerB = makeTransport();
  const hub = createTeacherPeerHub({
    authority: { getRevision: () => 11, commitAction: async () => null },
    getSnapshot: async () => ({ snapshot: {}, revision: 11 }),
    getCommitsAfter: async () => [],
  });
  hub.addPeer('student-a', peerA);
  hub.addPeer('student-b', peerB);
  const commit = { actionId: 'teacher-action', clientId: 'teacher', revision: 11, ops: [] };
  await hub.broadcastCommit(commit);
  assert.deepEqual(peerA.sent, [{ type: 'commit', payload: commit }]);
  assert.deepEqual(peerB.sent, [{ type: 'commit', payload: commit }]);
});

test('routes peer lock requests through teacher authority without trusting payload clientId', async () => {
  const transport = makeTransport();
  const requests = [];
  const lockAuthority = {
    acquire(request) {
      requests.push(request);
      return {
        granted: true,
        objectIds: request.objectIds,
        lockToken: request.lockToken,
        expiresAt: 12345,
        conflicts: [],
      };
    },
  };
  const hub = createTeacherPeerHub({
    authority: { getRevision: () => 0, commitAction: async () => null },
    getSnapshot: async () => ({ snapshot: {}, revision: 0 }),
    getCommitsAfter: async () => [],
    lockAuthority,
  });
  hub.addPeer('student-a', transport);

  await hub.handleMessage('student-a', {
    type: 'lock-request',
    payload: {
      requestId: 'request-1',
      operation: 'acquire',
      clientId: 'spoofed-client',
      lockToken: 'lock-token-123',
      objectIds: ['shape-1'],
      ttlMs: 12000,
    },
  });

  assert.deepEqual(requests, [{
    clientId: 'student-a',
    lockToken: 'lock-token-123',
    objectIds: ['shape-1'],
    ttlMs: 12000,
  }]);
  assert.deepEqual(transport.sent, [{
    type: 'lock-result',
    payload: {
      requestId: 'request-1',
      operation: 'acquire',
      granted: true,
      objectIds: ['shape-1'],
      lockToken: 'lock-token-123',
      expiresAt: 12345,
      conflicts: [],
    },
  }]);
});

test('default teacher lock authority rejects conflicts atomically and releases replaced selection', async () => {
  const peerA = makeTransport();
  const peerB = makeTransport();
  const hub = createTeacherPeerHub({
    authority: { getRevision: () => 0, commitAction: async () => null },
    getSnapshot: async () => ({ snapshot: {}, revision: 0 }),
    getCommitsAfter: async () => [],
  });
  hub.addPeer('student-a', peerA);
  hub.addPeer('student-b', peerB);

  await hub.handleMessage('student-a', {
    type: 'lock-request',
    payload: {
      requestId: 'a-1', operation: 'acquire', lockToken: 'token-student-a',
      objectIds: ['shape-1'], ttlMs: 12000,
    },
  });
  const first = peerA.sent.at(-1)?.payload;
  assert.equal(first?.granted, true);
  assert.deepEqual(first?.objectIds, ['shape-1']);

  await hub.handleMessage('student-b', {
    type: 'lock-request',
    payload: {
      requestId: 'b-1', operation: 'acquire', lockToken: 'token-student-b',
      objectIds: ['shape-1'], ttlMs: 12000,
    },
  });
  const conflict = peerB.sent.at(-1)?.payload;
  assert.equal(conflict?.granted, false);
  assert.deepEqual(conflict?.objectIds, ['shape-1']);
  assert.equal(conflict?.conflicts?.[0]?.objectId, 'shape-1');
  assert.equal(conflict?.conflicts?.[0]?.clientId, 'student-a');

  await hub.handleMessage('student-a', {
    type: 'lock-request',
    payload: {
      requestId: 'a-2', operation: 'acquire', lockToken: 'token-student-a',
      objectIds: ['shape-2'], ttlMs: 12000,
    },
  });
  assert.equal(peerA.sent.at(-1)?.payload?.granted, true);

  await hub.handleMessage('student-b', {
    type: 'lock-request',
    payload: {
      requestId: 'b-2', operation: 'acquire', lockToken: 'token-student-b',
      objectIds: ['shape-1'], ttlMs: 12000,
    },
  });
  assert.equal(peerB.sent.at(-1)?.payload?.granted, true);
});
