import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/components/Board.jsx', import.meta.url), 'utf8');
const start = source.indexOf('const ensureNotebookController = useCallback');
const end = source.indexOf('}, [boardId, replayPendingActionsLocally, sendDurableOps, syncFromServer]);', start);
assert.ok(start >= 0 && end > start, 'ensureNotebookController source not found');
const text = source.slice(start, end);

test('cold Board controller restores durable intents cooperatively before publication', () => {
  assert.match(text, /createNotebookBoardController\([\s\S]*initialPendingActions:\s*\[\]/);
  assert.match(text, /await\s+controller\.restoreInitialPendingActions\(initialPendingActions,[\s\S]*isCurrent:\s*current/);
  const restoreAt=text.indexOf('restoreInitialPendingActions');
  const installAt=text.indexOf('notebookControllerRef.current = controller');
  assert.ok(restoreAt >= 0 && installAt > restoreAt, 'controller was published before durable restore completed');
});

test('cold Board controller rechecks runtime revision after cooperative durable restore', () => {
  const restoreAt=text.indexOf('restoreInitialPendingActions');
  const installAt=text.indexOf('notebookControllerRef.current = controller');
  const tail=text.slice(restoreAt, installAt);
  assert.match(tail, /realtime\.getRevision\?\.\(\)/);
  assert.match(tail, /controller\.getConfirmedState\(\)\.revision/);
  assert.match(tail, /await\s+controller\.rebaseAsync\(/);
  assert.match(tail, /controller\.rebase\(/, 'final handoff must retain a synchronous stale-state escape');
});
