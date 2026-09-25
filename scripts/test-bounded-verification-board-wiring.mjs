import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
const board = fs.readFileSync(new URL('../src/components/Board.jsx', import.meta.url), 'utf8');
const realtime = fs.readFileSync(new URL('../src/lib/browserAuthorityRealtime.js', import.meta.url), 'utf8');
test('Canvas comparison callbacks are connected to the existing realtime session', () => {
  assert.match(board, /onVerificationRecords\s*\(/);
  assert.match(board, /readVerificationCanvasIds\s*\(/);
  assert.match(board, /canVerifyCanvas[,\s]/);
  assert.match(board, /createBoundedCanvasVerifier\(/);
  assert.match(realtime, /onVerificationRecords, readVerificationCanvasIds, canVerifyCanvas/);
});
test('new verifier does not add timers or enter the history preparation queue', () => {
  const section = board.slice(board.indexOf('const canVerifyCanvas ='), board.indexOf('realtimeRef.current = connectBoardRealtime'));
  assert.ok(section.length > 100);
  assert.doesNotMatch(section, /setInterval|setTimeout|authoritativeApplyQueueRef/);
  assert.match(board, /if \(!historyCommandBusyRef.current\) realtimeRef.current\?\.resumeVerification\?\.\(\)/);
});
test('new boards use one bounded verifier instead of duplicating the old per-commit checker', () => {
  assert.match(board, /isLastInBatch && !realtimeRef.current\?\.getVerificationStats\?\.\(\)\?\.enabled/);
});
test('async object revival rechecks the revision/gesture fence before touching the Canvas', async () => {
  const start = board.indexOf('const replayPendingActionsLocally = useCallback(') + 'const replayPendingActionsLocally = useCallback('.length;
  const end = board.indexOf('\n  }, [', start) + '\n  }'.length;
  const expression = board.slice(start, end);
  const disposed = []; let current = true; const mutations = [];
  const env = {
    fabricCanvasRef: { current: { getActiveObjects: () => [], add: () => mutations.push('add'), remove: () => mutations.push('remove') } },
    BACKGROUNDS: new Set(['grid', 'dots', 'blank']),
    affectedOperationIds: () => new Set(['a']),
    registeredObjectsById: () => [], serializedObjectCacheRef: { current: new WeakMap() },
    preloadSerializedImages: async () => { current = false; },
    enlivenImageAwareObjects: async () => [{ dispose: () => disposed.push('a') }],
    applyingRemoteRef: { current: false },
  };
  const replay = new Function('env', `with (env) { return (${expression}); }`)(env);
  const result = await replay([{ ops: [{ type: 'upsert', object: { boardObjectId: 'a', type: 'Path' }, zIndex: 0 }] }], { isCurrent: () => current });
  assert.equal(result, false); assert.deepEqual(disposed, ['a']); assert.deepEqual(mutations, []);
  assert.equal(env.applyingRemoteRef.current, false);
});

test('new-board remote commits advance after a legacy order mismatch so the bounded repair can run', () => {
  const start = board.indexOf('          if (', board.indexOf('          const verifiableOps ='));
  const end = board.indexOf('\n          rememberAuthoritativeOps(verifiableOps, incomingRevision);', start);
  assert.ok(start > 0 && end > start);
  const gate = new Function('verifyAuthoritativeOps', 'realtimeRef', 'verifiableOps', 'incomingBackground', 'incomingRevision', board.slice(start, end));
  let legacyCalls = 0;
  const mismatch = () => { legacyCalls++; return false; };
  assert.doesNotThrow(() => gate(mismatch, { current: { getVerificationStats: () => ({ enabled: true }) } }, [], null, 8));
  assert.equal(legacyCalls, 0, 'new boards must not wait for the old synchronous integrity check');
  assert.throws(() => gate(mismatch, { current: { getVerificationStats: () => ({ enabled: false }) } }, [], null, 8), /Адресная проверка операции 8/);
  assert.throws(() => gate(mismatch, { current: {} }, [], null, 8), /Адресная проверка операции 8/);
  assert.equal(legacyCalls, 2, 'unmarked/old boards keep their exact legacy failure semantics');
});
