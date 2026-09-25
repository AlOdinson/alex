import assert from 'node:assert/strict';
import test from 'node:test';
import { createTeacherPeerHub } from '../src/lib/teacherPeerHub.js';
import { createStudentPeerSession } from '../src/lib/studentPeerSession.js';
import { createPeerMessage, decodePeerMessage } from '../src/lib/peerProtocol.js';
import { captureIntegrityRecords, createIntegrityBudget, fingerprintIntegrityRecord } from '../src/lib/boardIntegrityData.js';

const snapshot = () => ({ version: 2, background: 'grid', canvas: { objects: [{ type: 'Path', boardObjectId: 'A', left: 4, stroke: 'black', path: [['M', 1, 2]] }] } });
async function pair({ version = 1, capability = 1, revision = 3 } = {}) {
  const source = { version, boardId: 'test-board', revision, snapshot: snapshot() };
  let replica = { revision: 0, snapshot: null };
  const hints = [], sent = [], errors = [];
  const authority = {
    getRevision: () => source.revision,
    getIntegritySource: () => version === 1 ? source : null,
    async commitAction(action) { source.revision++; return { ...action, revision: source.revision, changed: true }; },
  };
  let student;
  const hub = createTeacherPeerHub({ authority, getSnapshot: async () => source, getCommitsAfter: async () => [], onError: (e) => errors.push(e) });
  const toStudent = {
    send(type, payload) { sent.push({ type, payload }); return student.handleMessage(decodePeerMessage(createPeerMessage(type, payload))); },
    sendTextTransfer(kind, text) { sent.push({ kind, text }); return student.handleTransfer({ kind, text }); },
  };
  student = createStudentPeerSession({
    transport: { send: (type, payload) => hub.handleMessage('student', decodePeerMessage(createPeerMessage(type, payload))) },
    integrityVersion: capability,
    onIntegrityHint: (ids) => hints.push(ids),
    getRevision: () => replica.revision,
    applyCommit: async (commit) => { replica.revision = commit.revision; },
    installSnapshot: async (data, r) => { replica = { snapshot: structuredClone(data), revision: r }; },
    onError: (e) => errors.push(e),
  });
  hub.addPeer('student', toStudent);
  await student.start();
  return { hub, student, source, getReplica: () => replica, hints, sent, errors, close() { student.close(); hub.removePeer('student'); } };
}

test('real peer session negotiates integrity only for a new board and capable client', async () => {
  const p = await pair();
  try {
    assert.equal(typeof p.student.requestIntegrity, 'function');
    assert.equal(p.student.getIntegrityInfo()?.boardId, 'test-board');
    const local = p.getReplica(); local.snapshot.canvas.objects[0].stroke = 'red';
    const records = await captureIntegrityRecords(local, ['A'], createIntegrityBudget());
    const hash = await fingerprintIntegrityRecord(records[0], createIntegrityBudget());
    const result = await p.student.requestIntegrity({ revision: local.revision, records: [{ id: 'A', hash }], background: 'grid' });
    assert.equal(result.status, 'done');
    assert.equal(result.records[0].object.stroke, 'black');
    assert.equal(result.revision, 3);
    assert.equal(p.source.revision, 3, 'repair is not a new mutation');
    assert.equal(p.errors.length, 0);
  } finally { p.close(); }
});

test('old boards and old clients do not receive integrity metadata or hints', async () => {
  for (const options of [{ version: 0 }, { capability: 0 }]) {
    const p = await pair(options);
    try {
      assert.equal(JSON.parse(p.sent.find((x) => x.kind === 'snapshot').text).integrity, undefined);
      assert.equal(p.student.getIntegrityInfo?.() ?? null, null);
      assert.equal(typeof p.hub.broadcastIntegrityHint, 'function');
      await p.hub.broadcastIntegrityHint(['A'], 3);
      assert.equal(p.hints.length, 0);
      assert.equal(p.sent.some((x) => x.type?.startsWith('integrity')), false);
    } finally { p.close(); }
  }
});

test('event-driven bounded hint is delivered without a new heartbeat', async () => {
  const p = await pair();
  try {
    assert.equal(typeof p.hub.broadcastIntegrityHint, 'function');
    await p.hub.broadcastIntegrityHint(['A'], 3);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(p.hints, [['A']]);
  } finally { p.close(); }
});

test('an audit response does not block the next action acknowledgement', async () => {
  const p = await pair();
  try {
    assert.equal(typeof p.student.requestIntegrity, 'function');
    const action = await p.student.proposeActionAndWait({ actionId: 'undo-1', ops: [{ type: 'delete', id: 'A' }] });
    assert.equal(action.accepted, true);
    assert.equal(p.getReplica().revision, 4);
  } finally { p.close(); }
});
