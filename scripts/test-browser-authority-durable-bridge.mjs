import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserAuthorityDurableBridge } from '../src/lib/browserAuthorityDurableBridge.js';

test('teacher durable bridge commits locally and preserves Board-compatible result fields', async () => {
  const proposals = [];
  const bridge = createBrowserAuthorityDurableBridge({
    clientId: 'teacher-a',
    createActionId: () => 'teacher-action-1',
    runtime: {
      getRevision: () => 4,
      async commitTeacherAction(action) {
        proposals.push(action);
        return {
          ...action,
          revision: 5,
          duplicate: false,
          needsSync: false,
          changed: true,
          appliedOps: action.ops,
          appliedBackground: null,
          skippedConflicts: [],
          rejectedObjectIds: [],
          committedAt: 1234,
        };
      },
    },
  });

  const ops = [{ type: 'delete', id: 'x' }];
  const result = await bridge.sendOps(ops);
  assert.deepEqual(proposals, [{
    actionId: 'teacher-action-1',
    clientId: 'teacher-a',
    baseRevision: 4,
    ops,
    background: null,
  }]);
  assert.deepEqual(result, {
    actionId: 'teacher-action-1',
    revision: 5,
    needsSync: false,
    updatedAt: 1234,
    alreadyApplied: false,
    accepted: true,
    changed: true,
    appliedOps: ops,
    appliedBackground: null,
    rejectedObjectIds: [],
    skippedConflicts: [],
  });
});

test('student durable bridge waits for teacher ack and surfaces lock rejection without pretending it saved', async () => {
  const proposals = [];
  const bridge = createBrowserAuthorityDurableBridge({
    clientId: 'student-a',
    createActionId: () => 'student-action-1',
    runtime: {
      getRevision: () => 9,
      async proposeActionAndWait(action) {
        proposals.push(action);
        return {
          actionId: action.actionId,
          revision: 9,
          accepted: false,
          duplicate: false,
          needsSync: false,
          changed: false,
          appliedOps: [],
          appliedBackground: null,
          rejectedObjectIds: ['locked-shape'],
          skippedConflicts: [],
          error: 'Object locked by another participant',
        };
      },
    },
  });

  const result = await bridge.sendOps([{ type: 'patch', id: 'locked-shape', patch: { left: 20 } }]);
  assert.equal(proposals[0].clientId, 'student-a');
  assert.equal(proposals[0].baseRevision, 9);
  assert.equal(result.accepted, false);
  assert.equal(result.changed, false);
  assert.deepEqual(result.rejectedObjectIds, ['locked-shape']);
});

test('durable bridge refuses to report success when no browser authority runtime is available', async () => {
  const bridge = createBrowserAuthorityDurableBridge({
    clientId: 'student-a',
    createActionId: () => 'missing-runtime-action',
    runtime: {},
  });
  await assert.rejects(
    () => bridge.sendOps([{ type: 'delete', id: 'x' }]),
    /durable runtime/i,
  );
});
