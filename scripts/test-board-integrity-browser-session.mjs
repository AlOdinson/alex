import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserBoardSession } from '../src/lib/browserBoardSession.js';
import { getReplicaIntegritySource, installReplicaSnapshot, clearReplicaState } from '../src/lib/browserReplicaStore.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const snapshot = { version: 2, background: 'grid', canvas: { objects: [] } };
function owner(version) {
  const source = { version, boardId: 'owner', revision: 0, snapshot: structuredClone(snapshot) };
  let wakes = 0;
  const s = createBrowserBoardSession({
    boardId: 'owner', clientId: 'teacher', permission: 'owner', sendScreenShareSignal: async () => {},
    registerRuntime: () => () => {},
    integrityCanvas: { subscribeWake: () => { wakes++; return () => { wakes--; }; }, isReady: () => false },
    createTeacherTabAuthority: ({ onChange }) => ({ start() { onChange(true); }, stop() {} }),
    createTeacherRuntime: async () => ({
      getRevision: () => source.revision,
      getIntegritySource: () => version === 1 ? source : null,
      commitTeacherAction: async (action) => { source.revision++; return { ...action, revision: source.revision }; },
      close() {},
    }),
  });
  return { s, getWakes: () => wakes };
}
test('browser session gates verifier by explicit persisted new-board opt-in', async () => {
  for (const version of [0, 1]) {
    const { s, getWakes } = owner(version);
    try {
      await s.start();
      assert.equal(typeof s.getIntegrityStatus, 'function');
      assert.equal(Boolean(s.getIntegrityStatus()), version === 1);
      assert.equal(getWakes(), version);
      await s.sendOps([{ type: 'delete', id: 'A' }]);
      if (version) assert.equal(s.getIntegrityStatus().pending, 1);
    } finally { s.close(); }
    assert.equal(getWakes(), 0);
  }
});

test('student session activates after negotiated snapshot and cancels audit on close', async () => {
  let options; let requests = 0; let release; let callback;
  const s = createBrowserBoardSession({
    boardId: 'student', clientId: 's', permission: 'edit', sendScreenShareSignal: async () => {},
    registerRuntime: () => () => {},
    createStudentRuntime: (o) => {
      options = o;
      return {
        async start() {
          await o.installSnapshot(structuredClone(snapshot), 0);
          o.onIntegrityInfo?.({ version: 1, boardId: 'student', sessionId: 'session-1' });
        },
        requestIntegrity() { requests++; return new Promise((r) => { release = r; }); },
        getIntegrityInfo: () => ({ version: 1, boardId: 'student', sessionId: 'session-1' }),
        close() { release?.({ status: 'disabled' }); },
      };
    },
    integrityCanvas: { isReady: () => true, isBusy: () => false, size: () => 0,
      capture: async () => [], getBackground: () => 'grid', repair: async () => true,
      subscribeWake: (fn) => { callback = fn; return () => { callback = null; }; } },
  });
  try {
    await s.start(); await s.updateParticipants([{ clientId: 't', permission: 'owner' }]);
    assert.equal(options.integrityVersion, 1);
    assert.ok(s.getIntegrityStatus());
    await sleep(260);
    assert.equal(requests, 1);
    assert.equal(s.getIntegrityStatus().running, true);
    assert.equal(getReplicaIntegritySource('student').revision, 0);
  } finally { s.close(); clearReplicaState('student'); }
  assert.equal(callback, null);
});
