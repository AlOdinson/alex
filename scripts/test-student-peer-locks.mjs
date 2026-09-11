import assert from 'node:assert/strict';
import test from 'node:test';
import { createStudentPeerSession } from '../src/lib/studentPeerSession.js';

function makeTransport() {
  return {
    sent: [],
    async send(type, payload) { this.sent.push({ type, payload }); },
  };
}

function makeSession(transport) {
  let sequence = 0;
  return createStudentPeerSession({
    transport,
    getRevision: () => 0,
    applyCommit: async () => {},
    installSnapshot: async () => {},
    createRequestId: () => `lock-request-${++sequence}`,
  });
}

test('student lock request resolves only after the matching teacher response', async () => {
  const transport = makeTransport();
  const session = makeSession(transport);

  assert.equal(typeof session.requestLock, 'function');
  const pending = session.requestLock('acquire', {
    lockToken: 'token-student-a',
    objectIds: ['shape-1'],
    ttlMs: 12_000,
  });

  assert.deepEqual(transport.sent, [{
    type: 'lock-request',
    payload: {
      requestId: 'lock-request-1',
      operation: 'acquire',
      lockToken: 'token-student-a',
      objectIds: ['shape-1'],
      ttlMs: 12_000,
    },
  }]);

  let settled = false;
  pending.then(() => { settled = true; });
  await session.handleMessage({
    type: 'lock-result',
    payload: {
      requestId: 'other-request', operation: 'acquire', granted: false, objectIds: ['shape-1'],
    },
  });
  await Promise.resolve();
  assert.equal(settled, false);

  const expected = {
    requestId: 'lock-request-1',
    operation: 'acquire',
    granted: true,
    objectIds: ['shape-1'],
    lockToken: 'token-student-a',
    expiresAt: 13_000,
    conflicts: [],
  };
  await session.handleMessage({ type: 'lock-result', payload: expected });
  assert.deepEqual(await pending, expected);
});

test('student uses separate request ids for refresh and release', async () => {
  const transport = makeTransport();
  const session = makeSession(transport);

  const refresh = session.requestLock('refresh', {
    lockToken: 'token-student-a', ttlMs: 12_000,
  });
  const release = session.requestLock('release', {
    lockToken: 'token-student-a',
  });

  assert.equal(transport.sent[0].payload.requestId, 'lock-request-1');
  assert.equal(transport.sent[0].payload.operation, 'refresh');
  assert.equal(transport.sent[1].payload.requestId, 'lock-request-2');
  assert.equal(transport.sent[1].payload.operation, 'release');

  await session.handleMessage({
    type: 'lock-result',
    payload: { requestId: 'lock-request-2', operation: 'release', released: 1, objectIds: ['shape-1'] },
  });
  await session.handleMessage({
    type: 'lock-result',
    payload: { requestId: 'lock-request-1', operation: 'refresh', refreshed: true, objectIds: ['shape-1'] },
  });

  assert.equal((await refresh).refreshed, true);
  assert.equal((await release).released, 1);
});
