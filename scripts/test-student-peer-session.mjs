import assert from 'node:assert/strict';
import test from 'node:test';
import { createStudentPeerSession } from '../src/lib/studentPeerSession.js';

function makeTransport() {
  return {
    sent: [],
    async send(type, payload) { this.sent.push({ type, payload }); },
  };
}

test('starts by requesting sync from the current local revision', async () => {
  const transport = makeTransport();
  const session = createStudentPeerSession({
    transport,
    getRevision: () => 12,
    applyCommit: async () => {},
    installSnapshot: async () => {},
  });
  await session.start();
  assert.deepEqual(transport.sent, [{ type: 'sync-request', payload: { revision: 12 } }]);
});

test('applies the next contiguous authoritative commit', async () => {
  const transport = makeTransport();
  let revision = 4;
  const applied = [];
  const session = createStudentPeerSession({
    transport,
    getRevision: () => revision,
    applyCommit: async (commit) => { applied.push(commit); revision = commit.revision; },
    installSnapshot: async () => {},
  });
  await session.handleMessage({ type: 'commit', payload: { actionId: 'a5', revision: 5, ops: [] } });
  assert.equal(applied.length, 1);
  assert.equal(revision, 5);
  assert.equal(transport.sent.length, 0);
});

test('requests resync when a commit arrives with a revision gap', async () => {
  const transport = makeTransport();
  const session = createStudentPeerSession({
    transport,
    getRevision: () => 4,
    applyCommit: async () => assert.fail('gap commit must not be applied'),
    installSnapshot: async () => {},
  });
  await session.handleMessage({ type: 'commit', payload: { actionId: 'a7', revision: 7, ops: [] } });
  assert.deepEqual(transport.sent, [{ type: 'sync-request', payload: { revision: 4 } }]);
});

test('ignores duplicate commits that are already applied', async () => {
  const transport = makeTransport();
  const session = createStudentPeerSession({
    transport,
    getRevision: () => 8,
    applyCommit: async () => assert.fail('duplicate commit must not be applied'),
    installSnapshot: async () => {},
  });
  await session.handleMessage({ type: 'commit', payload: { actionId: 'a8', revision: 8, ops: [] } });
  assert.equal(transport.sent.length, 0);
});

test('installs an authoritative snapshot transfer', async () => {
  const transport = makeTransport();
  const installed = [];
  const session = createStudentPeerSession({
    transport,
    getRevision: () => 2,
    applyCommit: async () => {},
    installSnapshot: async (snapshot, revision) => installed.push({ snapshot, revision }),
  });
  await session.handleTransfer({
    kind: 'snapshot',
    text: JSON.stringify({ snapshot: { version: 2, canvas: { objects: [] } }, revision: 15 }),
  });
  assert.deepEqual(installed, [{ snapshot: { version: 2, canvas: { objects: [] } }, revision: 15 }]);
});

test('proposes local actions against the current authoritative revision', async () => {
  const transport = makeTransport();
  const session = createStudentPeerSession({
    transport,
    getRevision: () => 22,
    applyCommit: async () => {},
    installSnapshot: async () => {},
  });
  await session.proposeAction({ actionId: 'student-action', clientId: 'student-a', ops: [{ type: 'delete', id: 'x' }] });
  assert.deepEqual(transport.sent, [{
    type: 'action-proposal',
    payload: {
      actionId: 'student-action',
      clientId: 'student-a',
      ops: [{ type: 'delete', id: 'x' }],
      baseRevision: 22,
    },
  }]);
});

test('waits for the matching durable ack before resolving a student proposal', async () => {
  const transport = makeTransport();
  const session = createStudentPeerSession({
    transport,
    getRevision: () => 22,
    applyCommit: async () => {},
    installSnapshot: async () => {},
  });

  let settled = false;
  const task = session.proposeActionAndWait({
    actionId: 'student-action-ack',
    clientId: 'student-a',
    ops: [{ type: 'delete', id: 'x' }],
  }).then((value) => {
    settled = true;
    return value;
  });

  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(transport.sent.at(-1)?.type, 'action-proposal');

  await session.handleMessage({
    type: 'ack',
    payload: { actionId: 'some-other-action', revision: 23, accepted: true },
  });
  await Promise.resolve();
  assert.equal(settled, false);

  await session.handleMessage({
    type: 'ack',
    payload: { actionId: 'student-action-ack', revision: 23, accepted: true, duplicate: false },
  });
  assert.deepEqual(await task, {
    actionId: 'student-action-ack',
    revision: 23,
    accepted: true,
    duplicate: false,
  });
});

test('returns rejected durable acks to the caller instead of hiding conflicts', async () => {
  const transport = makeTransport();
  const session = createStudentPeerSession({
    transport,
    getRevision: () => 9,
    applyCommit: async () => {},
    installSnapshot: async () => {},
  });

  const task = session.proposeActionAndWait({
    actionId: 'student-rejected-action',
    ops: [{ type: 'patch', id: 'locked', patch: { left: 10 } }],
  });
  await Promise.resolve();
  await session.handleMessage({
    type: 'ack',
    payload: {
      actionId: 'student-rejected-action',
      revision: 9,
      accepted: false,
      rejectedObjectIds: ['locked'],
      needsSync: false,
      error: 'Object locked by another participant',
    },
  });
  const result = await task;
  assert.equal(result.accepted, false);
  assert.deepEqual(result.rejectedObjectIds, ['locked']);
});

test('closing a student peer rejects pending durable and lock waiters', async () => {
  const transport = makeTransport();
  const session = createStudentPeerSession({
    transport,
    getRevision: () => 9,
    applyCommit: async () => {},
    installSnapshot: async () => {},
    createRequestId: () => 'lock-waiter-1',
  });

  const actionTask = session.proposeActionAndWait({
    actionId: 'pending-action',
    ops: [{ type: 'delete', id: 'x' }],
  });
  const lockTask = session.requestLock('acquire', {
    objectIds: ['x'],
    lockToken: 'lock-token',
    ttlMs: 5000,
  });
  await Promise.resolve();

  const closeError = new Error('Peer connection closed');
  session.close(closeError);

  await assert.rejects(actionTask, /Peer connection closed/);
  await assert.rejects(lockTask, /Peer connection closed/);
  await assert.rejects(
    session.proposeActionAndWait({ actionId: 'after-close', ops: [{ type: 'delete', id: 'y' }] }),
    /closed/i,
  );
});
