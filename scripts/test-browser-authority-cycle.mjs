import assert from 'node:assert/strict';
import test from 'node:test';
import { createTeacherAuthority } from '../src/lib/teacherAuthority.js';
import { createTeacherPeerHub } from '../src/lib/teacherPeerHub.js';
import { createStudentPeerSession } from '../src/lib/studentPeerSession.js';
import { applyAuthorityOps } from '../src/lib/authoritySnapshot.js';

const EMPTY = { version: 2, background: 'grid', canvas: { objects: [] } };

function clone(value) {
  return structuredClone(value);
}

test('teacher and student converge using only authority journal and peer messages', async () => {
  let teacherSnapshot = clone(EMPTY);
  let studentSnapshot = clone(EMPTY);
  let studentRevision = 0;
  const commits = [];
  const acks = [];

  const authority = createTeacherAuthority({
    initialRevision: 0,
    persistCommit: async (commit) => {
      commits.push(clone(commit));
      teacherSnapshot = applyAuthorityOps(teacherSnapshot, commit.ops, commit.background);
      return { commit, duplicate: false };
    },
  });

  let session;
  const teacherToStudent = {
    async send(type, payload) {
      await session.handleMessage({ type, payload: clone(payload) });
    },
    async sendTextTransfer(kind, text) {
      await session.handleTransfer({ kind, text });
    },
  };

  const hub = createTeacherPeerHub({
    authority,
    getSnapshot: async () => ({ snapshot: clone(teacherSnapshot), revision: authority.getRevision() }),
    getCommitsAfter: async (revision, limit = 500) => commits
      .filter((commit) => commit.revision > revision)
      .slice(0, limit)
      .map(clone),
  });
  hub.addPeer('student-a', teacherToStudent);

  const studentToTeacher = {
    async send(type, payload) {
      await hub.handleMessage('student-a', { type, payload: clone(payload) });
    },
  };

  session = createStudentPeerSession({
    transport: studentToTeacher,
    getRevision: () => studentRevision,
    applyCommit: async (commit) => {
      studentSnapshot = applyAuthorityOps(studentSnapshot, commit.ops, commit.background);
      studentRevision = commit.revision;
    },
    installSnapshot: async (snapshot, revision) => {
      studentSnapshot = clone(snapshot);
      studentRevision = revision;
    },
    onAck: (ack) => acks.push(clone(ack)),
  });

  await session.start();
  assert.equal(studentRevision, 0);

  const teacherCommit = await authority.commitAction({
    actionId: 'teacher-1',
    clientId: 'teacher',
    baseRevision: 0,
    ops: [{
      type: 'upsert',
      object: { boardObjectId: 'shape-1', type: 'rect', left: 10, top: 20 },
    }],
  });
  await hub.broadcastCommit(teacherCommit);
  await session.whenIdle();
  assert.equal(studentRevision, 1);

  await session.proposeAction({
    actionId: 'student-1',
    clientId: 'student-a',
    ops: [{ type: 'patch', id: 'shape-1', patch: { left: 55 } }],
  });
  await session.whenIdle();

  assert.equal(authority.getRevision(), 2);
  assert.equal(studentRevision, 2);
  assert.equal(acks.at(-1).actionId, 'student-1');
  assert.equal(acks.at(-1).accepted, true);
  assert.deepEqual(studentSnapshot, teacherSnapshot);
  assert.equal(teacherSnapshot.canvas.objects[0].left, 55);
});
