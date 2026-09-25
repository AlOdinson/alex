import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserBoardSession } from '../src/lib/browserBoardSession.js';
function owner(enabled = true, extra = {}) {
  const events = []; let factoryCalls = 0; let options; let closedVerifier = 0;
  const runtime = { getRevision: () => 3, getVerificationMode: () => ({ version: enabled ? 1 : 0, epoch: 'epoch' }),
    getVerificationView: () => ({}), runVerification: (work) => work(),
    commitTeacherAction: async (action) => ({ ...action, revision: 4, changed: true, appliedOps: action.ops }), close() {} };
  const session = createBrowserBoardSession({
    boardId: 'test-v', clientId: 't', permission: 'owner', sendScreenShareSignal: async () => {},
    createTeacherTabAuthority: ({ onChange }) => ({ start() { onChange(true); }, stop() {} }),
    createTeacherRuntime: async (input) => { options = input; return runtime; },
    registerRuntime: () => () => {},
    onAuthoritativeCommit: async (commit) => { events.push(['paint', commit.actionId]); },
    createVerifier: (input) => {
      factoryCalls++; events.push(['verifier', input.epoch]);
      return { notify: (commit) => events.push(['verify', commit.actionId]),
        close: () => { closedVerifier++; }, resume: () => events.push(['resume']), stats: () => ({ enabled: true }) };
    },
    ...extra,
  });
  return { session, events, runtime, get options() { return options; }, get factoryCalls() { return factoryCalls; },
    get closedVerifier() { return closedVerifier; } };
}
test('old board session never constructs the additional checker', async () => {
  const h = owner(false); await h.session.start();
  await h.session.sendOps([{ type: 'delete', id: 'a' }], { actionId: 'old' });
  assert.equal(h.factoryCalls, 0); assert.deepEqual(h.events, []); h.session.close();
});
test('new board checker is scoped to runtime and marks teacher commits without awaiting it', async () => {
  const h = owner(); await h.session.start();
  assert.equal(h.factoryCalls, 1);
  await h.session.sendOps([{ type: 'delete', id: 'a' }], { actionId: 'own-undo' });
  assert.deepEqual(h.events.at(-1), ['verify', 'own-undo']);
  assert.equal(h.session.getVerificationStats().enabled, true);
  h.session.close(); assert.equal(h.closedVerifier, 1);
});
test('remote commits notify the checker after visible application succeeds', async () => {
  const h = owner(); await h.session.start();
  await h.options.onRemoteCommit({ actionId: 'student-move', revision: 4, ops: [] });
  assert.deepEqual(h.events.slice(-2), [['paint', 'student-move'], ['verify', 'student-move']]);
  h.session.close();
});
test('optional verification observer cannot reject a durable action', async () => {
  const h = owner(true, { createVerifier: () => ({ notify: () => { throw new Error('observer'); }, close() {} }) });
  await h.session.start();
  const result = await h.session.sendOps([{ type: 'delete', id: 'a' }], { actionId: 'ack' });
  assert.equal(result.accepted, true); h.session.close();
});
test('student gets opt-in from teacher session, not from its own calendar or URL', async () => {
  let studentOptions; let enabled = false; let calls = 0; let notify = 0;
  const runtime = { start: async () => { enabled = true; studentOptions.onVerificationMode({ version: 1, epoch: 'teacher' }); },
    getVerificationMode: () => ({ version: enabled ? 1 : 0, epoch: 'teacher' }),
    verifyObjects: async () => ({}), close() {} };
  const session = createBrowserBoardSession({ boardId: 's-v', clientId: 's', permission: 'edit', sendScreenShareSignal: async () => {},
    createStudentRuntime: (options) => { studentOptions = options; return runtime; },
    registerRuntime: () => () => {}, getReplicaRevision: () => 3,
    getVerificationReplicaView: () => ({}),
    applyReplicaCommit: () => ({ applied: true }),
    createVerifier: (options) => { calls++; assert.equal(options.epoch, 'teacher'); return { notify: () => { notify++; }, close() {} }; },
  });
  await session.start(); assert.equal(calls, 0);
  await session.updateParticipants([{ clientId: 't', permission: 'owner' }]);
  assert.equal(calls, 1);
  await studentOptions.applyCommit({ revision: 4, ops: [{ type: 'delete', id: 'old-stroke' }] });
  assert.equal(notify, 1); session.close();
});
