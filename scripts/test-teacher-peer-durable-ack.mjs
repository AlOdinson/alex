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

test('durable ack exposes the authoritative applied result needed by Board history', async () => {
  const transport = makeTransport();
  const appliedOps = [{ type: 'patch', id: 'shape-1', patch: { fill: '#fff' } }];
  const skippedConflicts = [{ objectId: 'shape-1', fields: ['left'] }];
  const hub = createTeacherPeerHub({
    authority: {
      getRevision: () => 11,
      async commitAction(action) {
        return {
          ...action,
          revision: 12,
          duplicate: false,
          needsSync: false,
          changed: true,
          appliedOps,
          appliedBackground: 'dots',
          skippedConflicts,
          rejectedObjectIds: [],
        };
      },
    },
    getSnapshot: async () => ({ snapshot: {}, revision: 12 }),
    getCommitsAfter: async () => [],
  });
  hub.addPeer('student-a', transport);

  await hub.handleMessage('student-a', {
    type: 'action-proposal',
    payload: { actionId: 'conditional-action', baseRevision: 11, ops: appliedOps },
  });

  const ack = transport.sent.find((entry) => entry.type === 'ack')?.payload;
  assert.deepEqual(ack, {
    actionId: 'conditional-action',
    revision: 12,
    accepted: true,
    duplicate: false,
    needsSync: false,
    changed: true,
    appliedOps,
    appliedBackground: 'dots',
    skippedConflicts,
    rejectedObjectIds: [],
  });
});

test('durable no-op ack preserves skipped conflict details without advancing state', async () => {
  const transport = makeTransport();
  const skippedConflicts = [{ objectId: 'shape-2', fields: ['top'] }];
  const hub = createTeacherPeerHub({
    authority: {
      getRevision: () => 20,
      async commitAction(action) {
        return {
          ...action,
          revision: 20,
          duplicate: false,
          needsSync: false,
          changed: false,
          appliedOps: [],
          appliedBackground: null,
          skippedConflicts,
          rejectedObjectIds: [],
        };
      },
    },
    getSnapshot: async () => ({ snapshot: {}, revision: 20 }),
    getCommitsAfter: async () => [],
  });
  hub.addPeer('student-a', transport);

  await hub.handleMessage('student-a', {
    type: 'action-proposal',
    payload: { actionId: 'noop-action', baseRevision: 20, ops: [] },
  });

  const ack = transport.sent.find((entry) => entry.type === 'ack')?.payload;
  assert.equal(ack.changed, false);
  assert.deepEqual(ack.appliedOps, []);
  assert.deepEqual(ack.skippedConflicts, skippedConflicts);
});
