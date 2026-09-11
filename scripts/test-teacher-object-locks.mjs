import assert from 'node:assert/strict';
import test from 'node:test';
import { createTeacherObjectLockAuthority } from '../src/lib/teacherObjectLocks.js';

test('acquire is atomic and replacing a selection releases the old objects', () => {
  let now = 1_000;
  const locks = createTeacherObjectLockAuthority({ now: () => now });

  const first = locks.acquire({
    clientId: 'student-a', lockToken: 'token-student-a', objectIds: ['shape-1'], ttlMs: 12_000,
  });
  assert.equal(first.granted, true);
  assert.equal(first.expiresAt, 13_000);

  const conflict = locks.acquire({
    clientId: 'student-b', lockToken: 'token-student-b', objectIds: ['shape-1', 'shape-2'], ttlMs: 12_000,
  });
  assert.equal(conflict.granted, false);
  assert.equal(conflict.conflicts.length, 1);
  assert.equal(conflict.conflicts[0].objectId, 'shape-1');

  const replacement = locks.acquire({
    clientId: 'student-a', lockToken: 'token-student-a', objectIds: ['shape-2'], ttlMs: 12_000,
  });
  assert.equal(replacement.granted, true);

  const oldObject = locks.acquire({
    clientId: 'student-b', lockToken: 'token-student-b', objectIds: ['shape-1'], ttlMs: 12_000,
  });
  assert.equal(oldObject.granted, true);
  now += 1;
});

test('refresh extends only active locks owned by the matching client and token', () => {
  let now = 1_000;
  const locks = createTeacherObjectLockAuthority({ now: () => now });
  locks.acquire({
    clientId: 'student-a', lockToken: 'token-student-a', objectIds: ['shape-1', 'shape-2'], ttlMs: 12_000,
  });

  assert.equal(typeof locks.refresh, 'function');
  now = 5_000;
  const refreshed = locks.refresh({
    clientId: 'student-a', lockToken: 'token-student-a', ttlMs: 12_000,
  });
  assert.equal(refreshed.refreshed, true);
  assert.deepEqual(refreshed.objectIds, ['shape-1', 'shape-2']);
  assert.equal(refreshed.expiresAt, 17_000);

  const wrongToken = locks.refresh({
    clientId: 'student-a', lockToken: 'wrong-token', ttlMs: 12_000,
  });
  assert.equal(wrongToken.refreshed, false);
  assert.deepEqual(wrongToken.objectIds, []);
});

test('release removes only locks owned by the matching client and token', () => {
  const locks = createTeacherObjectLockAuthority({ now: () => 1_000 });
  locks.acquire({
    clientId: 'student-a', lockToken: 'token-student-a', objectIds: ['shape-1', 'shape-2'], ttlMs: 12_000,
  });
  locks.acquire({
    clientId: 'student-b', lockToken: 'token-student-b', objectIds: ['shape-3'], ttlMs: 12_000,
  });

  assert.equal(typeof locks.release, 'function');
  const released = locks.release({ clientId: 'student-a', lockToken: 'token-student-a' });
  assert.equal(released.released, 2);
  assert.deepEqual(released.objectIds, ['shape-1', 'shape-2']);

  const shape1 = locks.acquire({
    clientId: 'student-c', lockToken: 'token-student-c', objectIds: ['shape-1'], ttlMs: 12_000,
  });
  assert.equal(shape1.granted, true);
  const shape3 = locks.acquire({
    clientId: 'student-c', lockToken: 'token-student-c', objectIds: ['shape-3'], ttlMs: 12_000,
  });
  assert.equal(shape3.granted, false);
  assert.equal(shape3.conflicts[0].clientId, 'student-b');
});

test('expired leases no longer block another client', () => {
  let now = 1_000;
  const locks = createTeacherObjectLockAuthority({ now: () => now });
  locks.acquire({
    clientId: 'student-a', lockToken: 'token-student-a', objectIds: ['shape-1'], ttlMs: 6_000,
  });
  now = 7_000;
  const next = locks.acquire({
    clientId: 'student-b', lockToken: 'token-student-b', objectIds: ['shape-1'], ttlMs: 6_000,
  });
  assert.equal(next.granted, true);
});
