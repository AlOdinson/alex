import test from 'node:test';
import assert from 'node:assert/strict';
import { createNotebookBoardController } from '../src/lib/notebookBoardController.js';

const baseline = () => ({ revision: 0, snapshot: { canvas: { objects: [
  { type: 'BoardNotebook', boardObjectId: 'book', notebookPageNumber: 1, notebookPages: [[]] },
] } } });
const action = id => ({ actionId: id, ops: [{ type: 'notebook', version: 1, id: 'book', pageNumber: 1,
  changes: [{ type: 'insert', object: { type: 'Rect', boardObjectId: id, width: 4, height: 4 }, ifAbsent: true }],
}] });
const ids = view => view.snapshot.canvas.objects[0].notebookPages[0].map(x => x.boardObjectId);
// Six milliseconds deliberately exceeds the four-millisecond scheduling budget.
// This is an ordering regression, not a benchmark or a latency guarantee.
function consumeSlice() { const start = performance.now(); while (performance.now() - start < 6) {} }
const nextTask = fn => new Promise(resolve => setTimeout(() => { fn?.(); resolve(); }, 0));

test('repeated projection batches yield to the next input task without losing pending strokes', async () => {
  let controller, paints = 0, timerAt = null; const visible = [];
  controller = createNotebookBoardController({ confirmedState: baseline(), publish: () => new Promise(() => {}),
    paint: async (view, context) => {
      paints++; consumeSlice();
      if (paints < 4) controller.enqueue(action(`ink-${paints}`));
      if (context.isCurrent()) visible.push(ids(view));
      return context.isCurrent();
    } });
  controller.pause('test transport paused, local ink remains accepted');
  const input = nextTask(() => { timerAt = paints; });
  try {
    controller.enqueue(action('ink-0')); await controller.whenPainted(); await input;
    assert.ok(timerAt > 0 && timerAt < 4, `input task starved until all ${timerAt} batches finished`);
    assert.deepEqual(visible.at(-1), ['ink-0', 'ink-1', 'ink-2', 'ink-3']);
    assert.equal(controller.pendingCount(), 4);
  } finally { controller.dispose(); }
});

test('suspension during a yield keeps dirty input for resume without applying a held gesture', async () => {
  let controller, paints = 0, pausedAt = null;
  controller = createNotebookBoardController({ confirmedState: baseline(), publish: () => new Promise(() => {}),
    paint: async (_view, context) => {
      paints++; consumeSlice(); if (paints === 1) controller.enqueue(action('second'));
      return context.isCurrent();
    } });
  controller.pause('test');
  const suspend = nextTask(() => { controller.suspendProjection(); pausedAt = paints; });
  try {
    controller.enqueue(action('first')); await controller.whenPainted(); await suspend;
    assert.equal(pausedAt, 1, 'the next projection ran before a pending gesture suspension');
    assert.equal(paints, 1); assert.equal(controller.pendingCount(), 2);
    controller.resumeProjection(); await controller.whenPainted();
    assert.equal(paints, 2); assert.deepEqual(ids(controller.getState()), ['first', 'second']);
  } finally { controller.dispose(); }
});

test('disposing between batches prevents later rendering but retains the queued action export', async () => {
  let controller, paints = 0, exported;
  controller = createNotebookBoardController({ confirmedState: baseline(), publish: () => new Promise(() => {}),
    paint: async (_view, context) => {
      paints++; consumeSlice(); if (paints === 1) controller.enqueue(action('second'));
      return context.isCurrent();
    } });
  controller.pause('test');
  const disposal = nextTask(() => { exported = controller.exportPending(); controller.dispose(); });
  controller.enqueue(action('first')); await controller.whenPainted(); await disposal;
  assert.equal(paints, 1, 'disposed controller painted another queued batch');
  assert.deepEqual(exported.map(x => x.actionId), ['first', 'second']);
});

test('an ordinary short projection does not wait for a timer task', async () => {
  let painted = false, timer = false;
  const controller = createNotebookBoardController({ confirmedState: baseline(), publish: () => new Promise(() => {}),
    paint: async () => { painted = true; return true; } });
  controller.pause('test');
  const input = nextTask(() => { timer = true; });
  try {
    controller.enqueue(action('one')); await controller.whenPainted();
    assert.equal(painted, true); assert.equal(timer, false);
  } finally { controller.dispose(); await input; }
});
