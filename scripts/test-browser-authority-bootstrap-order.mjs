import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('../src/components/Board.jsx', import.meta.url), 'utf8');

test('stale recovery is rejected before it can seed or merge Board authority state', () => {
  const recoveryStart = source.indexOf('const recovery = await recoveryPromise;');
  const guard = source.indexOf('authoritativeSnapshotGate.shouldApplyRecovery(recoveryRevision)', recoveryStart);
  const seed = source.indexOf('seedAuthoritativeSnapshot(recovery.snapshot', recoveryStart);
  const pending = source.indexOf('const pendingActions = await getPendingActions(boardId);', recoveryStart);
  const apply = source.indexOf('await applyAuthoritativeSnapshot(recoveredSnapshot, recoveryRevision);', recoveryStart);

  assert.ok(recoveryStart >= 0, 'bootstrap recovery block was not found');
  assert.ok(guard > recoveryStart, 'stale recovery guard was not found');
  assert.ok(seed > recoveryStart, 'recovery authority seed was not found');
  assert.ok(pending > recoveryStart, 'recovery pending-action merge was not found');
  assert.ok(apply > recoveryStart, 'recovery snapshot apply was not found');
  assert.ok(guard < seed, 'stale recovery must be rejected before it mutates authoritative object state');
  assert.ok(guard < pending, 'stale recovery must be rejected before pending actions are merged onto it');
  assert.ok(guard < apply, 'stale recovery must be rejected before Fabric snapshot apply');
});
