import assert from 'node:assert/strict';
import test from 'node:test';
import { createTeacherAuthority } from '../src/lib/teacherAuthority.js';

test('assigns the next revision only after durable persistence succeeds', async () => {
  const persisted = [];
  const authority = createTeacherAuthority({
    initialRevision: 7,
    persistCommit: async (commit) => persisted.push({ ...commit }),
  });

  const result = await authority.commitAction({
    actionId: 'action-0001',
    clientId: 'teacher',
    baseRevision: 7,
    ops: [{ type: 'delete', id: 'object-a' }],
  });

  assert.equal(result.revision, 8);
  assert.equal(authority.getRevision(), 8);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].revision, 8);
});

test('does not advance revision when durable persistence fails', async () => {
  const authority = createTeacherAuthority({
    initialRevision: 11,
    persistCommit: async () => { throw new Error('disk-full'); },
  });

  await assert.rejects(() => authority.commitAction({
    actionId: 'action-0002',
    clientId: 'student-a',
    baseRevision: 11,
    ops: [{ type: 'delete', id: 'object-a' }],
  }), /disk-full/);

  assert.equal(authority.getRevision(), 11);
});

test('deduplicates a retried action and returns the original revision', async () => {
  let persistCount = 0;
  const authority = createTeacherAuthority({
    initialRevision: 20,
    persistCommit: async () => { persistCount += 1; },
  });
  const action = {
    actionId: 'action-0003',
    clientId: 'student-a',
    baseRevision: 20,
    ops: [{ type: 'delete', id: 'object-a' }],
  };

  const first = await authority.commitAction(action);
  const second = await authority.commitAction(action);

  assert.equal(first.revision, 21);
  assert.equal(second.revision, 21);
  assert.equal(second.duplicate, true);
  assert.equal(persistCount, 1);
  assert.equal(authority.getRevision(), 21);
});

test('serializes simultaneous commits so revisions cannot collide', async () => {
  const persisted = [];
  const authority = createTeacherAuthority({
    initialRevision: 30,
    persistCommit: async (commit) => {
      await new Promise((resolve) => setTimeout(resolve, commit.actionId === 'action-0004' ? 15 : 1));
      persisted.push(commit.revision);
    },
  });

  const [first, second] = await Promise.all([
    authority.commitAction({
      actionId: 'action-0004', clientId: 'student-a', baseRevision: 30,
      ops: [{ type: 'delete', id: 'object-a' }],
    }),
    authority.commitAction({
      actionId: 'action-0005', clientId: 'student-b', baseRevision: 30,
      ops: [{ type: 'delete', id: 'object-b' }],
    }),
  ]);

  assert.deepEqual([first.revision, second.revision], [31, 32]);
  assert.deepEqual(persisted, [31, 32]);
  assert.equal(authority.getRevision(), 32);
});
