import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
const board = readFileSync(new URL('../src/components/Board.jsx', import.meta.url), 'utf8');
function callback(name, env) {
  const marker = `const ${name} = useCallback(`;
  const start = board.indexOf(marker) + marker.length;
  const end = board.indexOf('\n  }, [', start) + '\n  }'.length;
  assert.ok(start >= marker.length && end > start);
  return new Function('env', `with (env) { return (${board.slice(start, end)}); }`)(env);
}
function context(enabled) {
  const scheduled = []; let resumes = 0;
  return { scheduled, get resumes() { return resumes; }, env: {
    realtimeRef: { current: { getVerificationStats: () => ({ enabled }), resumeVerification: () => { resumes++; } } },
    targetedReconcileStateRef: { current: { pending: new Map(), timer: null, running: false } },
    targetedReconcileRunnerRef: { current: () => {} },
    TARGETED_RECONCILE_DELAY: 180, TARGETED_RECONCILE_RETRY_DELAY: 240, TARGETED_RECONCILE_MAX_WAIT_ATTEMPTS: 32,
    authoritativeObjectStatesRef: { current: new Map() },
    getLocalMutationIds: () => new Set(), reconcileAuthoritativeIds: async () => true, syncFromServer: () => {},
    window: { setTimeout: (fn, delay) => { scheduled.push({ fn, delay }); return 7; } },
  } };
}
test('new-board preview completion only wakes confirmed bounded work, never starts legacy retry loop', () => {
  const c = context(true);
  const schedule = callback('scheduleTargetedReconciliation', c.env);
  for (let i = 0; i < 20; i++) schedule(Array.from({ length: 300 }, (_, j) => `id${j}`));
  assert.equal(c.scheduled.length, 0, 'no second timer-based verifier on new boards');
  assert.equal(c.env.targetedReconcileStateRef.current.pending.size, 0);
  assert.equal(c.resumes, 20);
});
test('unmarked old boards keep their original targeted reconciliation delay and queue', () => {
  const c = context(false);
  callback('scheduleTargetedReconciliation', c.env)(['a', 'a', 'b'], { minimumRevisionById: new Map([['a', 9]]) });
  assert.equal(c.scheduled.length, 1);
  assert.equal(c.scheduled[0].delay, 180);
  assert.equal(c.env.targetedReconcileStateRef.current.pending.size, 2);
  assert.equal(c.env.targetedReconcileStateRef.current.pending.get('a').minimumRevision, 9);
  assert.equal(c.resumes, 0);
});
test('queued legacy work is retired once new-board capability becomes available', async () => {
  const c = context(true);
  c.env.targetedReconcileStateRef.current.pending.set('a', { attempts: 0 });
  c.env.targetedReconcileStateRef.current.timer = 7;
  let legacyReads = 0;
  c.env.getLocalMutationIds = () => { legacyReads++; return new Set(); };
  await callback('runTargetedReconciliation', c.env)();
  assert.equal(c.env.targetedReconcileStateRef.current.pending.size, 0);
  assert.equal(c.env.targetedReconcileStateRef.current.timer, null);
  assert.equal(c.resumes, 1);
  assert.equal(legacyReads, 0);
  assert.equal(c.scheduled.length, 0);
});
