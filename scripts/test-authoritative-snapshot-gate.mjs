import assert from 'node:assert/strict';
import test from 'node:test';
import { createAuthoritativeSnapshotGate } from '../src/lib/authoritativeSnapshotGate.js';

test('snapshot received before board readiness waits and then replaces stale bootstrap state', async () => {
  let ready = false;
  const applied = [];
  const gate = createAuthoritativeSnapshotGate({
    isReady: () => ready,
    applySnapshot: async (snapshot, revision) => {
      applied.push({ snapshot, revision });
    },
  });

  let settled = false;
  const snapshot = { version: 2, canvas: { objects: [{ boardObjectId: 'old-teacher-ink' }] } };
  const receiving = gate.receive(snapshot, 317).then((value) => {
    settled = true;
    return value;
  });
  await Promise.resolve();

  assert.equal(settled, false, 'student runtime must not report snapshot handoff complete before Board is ready');
  assert.deepEqual(applied, []);
  assert.equal(gate.getLatestRevision(), 317,
    'the newest peer snapshot revision must be visible even while Board bootstrap is blocked');

  ready = true;
  assert.equal(await gate.flush(), true);
  assert.equal(await receiving, true);
  assert.deepEqual(applied, [{ snapshot, revision: 317 }]);
  assert.equal(gate.getLatestRevision(), 317);
});

test('while bootstrap is blocked only the newest authoritative snapshot is applied', async () => {
  let ready = false;
  const applied = [];
  const gate = createAuthoritativeSnapshotGate({
    isReady: () => ready,
    applySnapshot: async (snapshot, revision) => applied.push({ snapshot, revision }),
  });

  const oldResult = gate.receive({ canvas: { objects: [{ boardObjectId: 'stale' }] } }, 20);
  const latestResult = gate.receive({ canvas: { objects: [{ boardObjectId: 'current' }] } }, 25);

  assert.equal(await oldResult, false, 'superseded blocked snapshot should be released without applying');
  assert.equal(gate.getLatestRevision(), 25);
  ready = true;
  await gate.flush();
  assert.equal(await latestResult, true);
  assert.equal(applied.length, 1);
  assert.equal(applied[0].revision, 25);
  assert.equal(applied[0].snapshot.canvas.objects[0].boardObjectId, 'current');
});

test('older snapshot cannot lower the peer snapshot high-water mark', async () => {
  let ready = false;
  const applied = [];
  const gate = createAuthoritativeSnapshotGate({
    isReady: () => ready,
    applySnapshot: async (_snapshot, revision) => applied.push(revision),
  });

  const newest = gate.receive({ canvas: { objects: [{ boardObjectId: 'new' }] } }, 44);
  assert.equal(gate.getLatestRevision(), 44);
  assert.equal(await gate.receive({ canvas: { objects: [{ boardObjectId: 'old' }] } }, 41), false);
  assert.equal(gate.getLatestRevision(), 44);
  ready = true;
  await gate.flush();
  assert.equal(await newest, true);
  assert.deepEqual(applied, [44]);
});

test('snapshot received after readiness is applied immediately', async () => {
  const applied = [];
  const gate = createAuthoritativeSnapshotGate({
    isReady: () => true,
    applySnapshot: async (_snapshot, revision) => applied.push(revision),
  });

  assert.equal(gate.getLatestRevision(), -1);
  assert.equal(await gate.receive({ canvas: { objects: [] } }, 9), true);
  assert.deepEqual(applied, [9]);
  assert.equal(gate.getLatestRevision(), 9);
});
