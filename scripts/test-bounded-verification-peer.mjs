import assert from 'node:assert/strict';
import test from 'node:test';
import { createTeacherPeerHub } from '../src/lib/teacherPeerHub.js';
import { createStudentPeerSession } from '../src/lib/studentPeerSession.js';
import { createVerificationView } from '../src/lib/boundedVerificationState.js';
import { verificationDigest } from '../src/lib/boundedVerificationDigest.js';
const sample = () => ({ version: 2, background: 'grid', canvas: { objects: [{ boardObjectId: 'a', left: 1, stroke: 'black' }] } });
function teacher(enabled = true) {
  let revision = 10; const snapshot = sample(); const sent = [];
  const view = createVerificationView({ getSnapshot: () => snapshot, getRevision: () => revision });
  const authority = { getRevision: () => revision,
    getVerificationView: () => enabled ? view : null,
    runVerification: async (_key, work) => work(),
    commitAction: async (action) => ({ ...action, revision: ++revision, changed: true }),
  };
  const hub = createTeacherPeerHub({ authority, getSnapshot: async () => ({ snapshot, revision }), getCommitsAfter: async () => [] });
  const transport = { send: async (type, payload) => { sent.push({ type, payload }); },
    sendLowPriorityEncoded: async (text) => { sent.push(JSON.parse(text)); },
    sendTextTransfer: async (kind, text) => { sent.push({ kind, text }); } };
  hub.addPeer('s', transport);
  return { hub, authority, view, sent, snapshot, transport };
}
test('new-board hub advertises verification on initial head', async () => {
  const { hub, sent } = teacher();
  await hub.handleMessage('s', { type: 'head-request' });
  assert.equal(sent[0].payload.verificationVersion, 1);
  assert.equal(typeof sent[0].payload.verificationEpoch, 'string');
});
test('old-board head remains exactly unchanged', async () => {
  const { hub, sent } = teacher(false);
  await hub.handleMessage('s', { type: 'head-request' });
  assert.deepEqual(sent[0], { type: 'head', payload: { revision: 10 } });
});
test('snapshot carries new-board capability without modifying old snapshot content', async () => {
  const { hub, sent, snapshot } = teacher();
  await hub.handleMessage('s', { type: 'snapshot-request' });
  const payload = JSON.parse(sent[0].text);
  assert.equal(payload.verificationVersion, 1); assert.deepEqual(payload.snapshot, snapshot);
});
test('selective verification uses existing message envelope and only returns a mismatch', async () => {
  const { hub, sent, view } = teacher();
  await hub.handleMessage('s', { type: 'head-request' });
  const epoch = sent[0].payload.verificationEpoch;
  await hub.handleMessage('s', { type: 'head-request', payload: { verification: {
    version: 1, requestId: 'probe', epoch, revision: 10,
    entries: [{ id: 'a', hash: '0'.repeat(64) }],
  } } });
  const result = sent.at(-1).payload.verification;
  assert.equal(result.status, 'ok'); assert.equal(result.repairs.length, 1);
  assert.equal(result.repairs[0].object.stroke, 'black');
  await hub.handleMessage('s', { type: 'head-request', payload: { verification: {
    version: 1, requestId: 'probe2', epoch, revision: 10,
    entries: [{ id: 'a', hash: await verificationDigest(view.read('a')) }],
  } } });
  assert.deepEqual(sent.at(-1).payload.verification.repairs, []);
});
test('waiting for verification CPU lane does not delay a durable action acknowledgement', async () => {
  const { hub, sent, authority } = teacher();
  await hub.handleMessage('s', { type: 'head-request' }); const epoch = sent[0].payload.verificationEpoch;
  let release; const gate = new Promise((r) => { release = r; });
  authority.runVerification = async (_key, work) => { await gate; return work(); };
  const check = hub.handleMessage('s', { type: 'head-request', payload: { verification: {
    version: 1, requestId: 'probe', epoch, revision: 10, entries: [],
  } } });
  await hub.handleMessage('s', { type: 'action-proposal', payload: { actionId: 'draw', baseRevision: 10, ops: [] } });
  assert.ok(sent.some((m) => m.type === 'ack' && m.payload.actionId === 'draw'));
  release(); await check;
  assert.equal(sent.at(-1).payload.verification.status, 'stale');
});
function student() {
  const sent = []; let revision = 10;
  const session = createStudentPeerSession({ transport: { send: async (type, payload) => sent.push({ type, payload }) },
    getRevision: () => revision, applyCommit: async (c) => { revision = c.revision; }, installSnapshot: async (_s, r) => { revision = r; },
  });
  return { session, sent };
}
async function ready(session) {
  const starting = session.start();
  await session.handleMessage({ type: 'head', payload: { revision: 10, verificationVersion: 1, verificationEpoch: 'owner' } });
  await starting;
}
test('student learns capability and resolves only the matching verification response', async () => {
  const { session, sent } = student(); await ready(session);
  assert.deepEqual(session.getVerificationMode(), { version: 1, epoch: 'owner' });
  const pending = session.verifyObjects({ revision: 10, entries: [] });
  const probe = sent.at(-1).payload.verification;
  await session.handleMessage({ type: 'head', payload: { revision: 10, verification: { requestId: 'unrelated', epoch: 'owner' } } });
  await session.handleMessage({ type: 'head', payload: { revision: 10, verification: { version: 1, requestId: probe.requestId, epoch: 'owner', status: 'ok', revision: 10, repairs: [], checkedIds: [] } } });
  assert.equal((await pending).status, 'ok'); session.close();
});
test('only one in-flight verification request; it is separate from action ack', async () => {
  const { session } = student(); await ready(session);
  const pending = session.verifyObjects({ revision: 10, entries: [] });
  const observed = assert.rejects(pending, /closed/);
  await assert.rejects(session.verifyObjects({ revision: 10, entries: [] }), /already pending/);
  const action = session.proposeActionAndWait({ actionId: 'undo1', ops: [] });
  await session.handleMessage({ type: 'ack', payload: { actionId: 'undo1', revision: 11, accepted: true } });
  assert.equal((await action).accepted, true);
  session.close(); await observed;
});
test('old teacher never receives an unsupported verification request', async () => {
  const { session, sent } = student(); const starting = session.start();
  await session.handleMessage({ type: 'head', payload: { revision: 10 } }); await starting;
  await assert.rejects(session.verifyObjects({ revision: 10, entries: [] }), /not enabled/);
  assert.equal(sent.some((m) => m.payload.verification), false); session.close();
});
test('teacher epoch change rejects an old verification waiter without a retry timer', async () => {
  const { session } = student(); await ready(session);
  const pending = session.verifyObjects({ revision: 10, entries: [] });
  let rejected = false; pending.catch(() => { rejected = true; });
  await session.handleMessage({ type: 'head', payload: { revision: 10, verificationVersion: 1, verificationEpoch: 'new-epoch' } });
  await Promise.resolve();
  assert.equal(rejected, true); session.close();
});
test('synchronous verification send failure clears the in-flight slot', async () => {
  let fail = true;
  const session = createStudentPeerSession({ transport: { send(type, payload) { if (payload?.verification && fail) throw new Error('send failed'); } },
    getRevision: () => 10, applyCommit: async () => {}, installSnapshot: async () => {}, });
  await ready(session);
  await assert.rejects(async () => session.verifyObjects({ revision: 10, entries: [] }), /send failed/);
  fail = false;
  const second = session.verifyObjects({ revision: 10, entries: [] });
  const observed = assert.rejects(second, /closed/);
  session.close(); await observed;
});
test('verification requests use low-priority frames when the transport supports them', async () => {
  const ordinary = []; const optional = [];
  const session = createStudentPeerSession({ transport: {
    send: async (type, payload) => ordinary.push({ type, payload }),
    sendLowPriorityEncoded: async (text) => optional.push(JSON.parse(text)),
  }, getRevision: () => 10, applyCommit: async () => {}, installSnapshot: async () => {} });
  await ready(session);
  const pending = session.verifyObjects({ revision: 10, entries: [] });
  const observed = assert.rejects(pending, /closed/);
  await Promise.resolve();
  assert.equal(optional.length, 1);
  assert.equal(optional[0].type, 'head-request');
  assert.equal(ordinary.some((m) => m.payload?.verification), false);
  session.close(); await observed;
});
