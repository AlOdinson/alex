import assert from 'node:assert/strict';
import test from 'node:test';
import { createHistoryCommandQueue } from '../src/lib/historyCommandQueue.js';

for (const trimOldHistory of [false, true]) {
  test(`redo remains undoable before newer local edits (history trimmed=${trimOldHistory})`, async () => {
    const prior = { id: 'prior' }, restored = { id: 'restored' }, drawn = { id: 'drawn' };
    const undo = [prior];
    let redo = [restored];
    let generation = 0;
    let release;
    let entered;
    const started = new Promise((resolve) => { entered = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    const calls = [];
    const queue = createHistoryCommandQueue({
      getUndo: () => undo, getRedo: () => redo, getGeneration: () => generation,
      execute: async (action, direction) => {
        calls.push([action.id, direction]);
        if (direction === 'redo') { entered(); await gate; }
        return { changed: true };
      },
    });
    try {
      const replay = queue.enqueue('redo');
      await started;
      if (trimOldHistory) undo.shift();
      undo.push(drawn);
      redo = [];
      generation += 1;
      release();
      await replay;
      assert.deepEqual(undo.map((action) => action.id), [
        ...(trimOldHistory ? [] : ['prior']), 'restored', 'drawn',
      ], 'confirmed redo must not disappear when a new stroke is recorded before its acknowledgement');
      await queue.enqueue('undo');
      await queue.enqueue('undo');
      assert.deepEqual(calls.slice(-2), [['drawn', 'undo'], ['restored', 'undo']]);
    } finally { release(); queue.close(); }
  });
}

test('a new local edit during undo still invalidates the old redo branch', async () => {
  const removed = { id: 'removed' }, drawn = { id: 'drawn' };
  const undo = [removed];
  let redo = [], generation = 0, release, entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const queue = createHistoryCommandQueue({
    getUndo: () => undo, getRedo: () => redo, getGeneration: () => generation,
    execute: async () => { entered(); await gate; return { changed: true }; },
  });
  try {
    const pending = queue.enqueue('undo');
    await started;
    undo.push(drawn); redo = []; generation += 1;
    release(); await pending;
    assert.deepEqual(undo, [drawn]);
    assert.deepEqual(redo, []);
  } finally { release(); queue.close(); }
});
