import test from 'node:test';
import assert from 'node:assert/strict';
import { getEnv } from 'fabric/node';
import { setEnv, Path, StaticCanvas } from 'fabric';
import { makeAuditSnapshot, installNotebookAuditMetrics } from './notebook-audit-metrics.js';
import { BoardNotebook, captureNotebookObject } from '../src/lib/boardNotebook.js';
import { prepareNotebookProjection } from '../src/lib/notebookProjection.js';
setEnv(getEnv());

// Replacing the production serializer with a hand-built sparse frame causes the
// confirmed projection to unset opacity/scale, then makes the next cut invalid.
test('audit fixture uses the same complete frame record as production creation', async () => {
  const frame = makeAuditSnapshot({ pageStrokes: 2 }).canvas.objects.at(-1);
  const book = await BoardNotebook.fromObject(frame);
  try {
    const roundTrip = book.toObject(['boardObjectId']);
    for (const key of ['visible', 'opacity', 'scaleX', 'scaleY', 'angle', 'skewX', 'skewY', 'flipX', 'flipY']) {
      assert.equal(frame[key], roundTrip[key], `fixture omits canonical ${key}`);
    }
  } finally { book.dispose(); }
});

test('fixture confirmation keeps pixels visible and permits the second contained stroke', async () => {
  const frame = makeAuditSnapshot({ pageStrokes: 2 }).canvas.objects.at(-1);
  const book = await BoardNotebook.fromObject(frame);
  const canvas = new StaticCanvas(null, { width: 700, height: 700, enableRetinaScaling: false, renderOnAddRemove: false });
  canvas.add(book);
  const next = { ...frame, notebookPages: [frame.notebookPages[0].concat(
    new Path([['M', -80, 160], ['L', -30, 164]], { boardObjectId: 'first', stroke: 'black', fill: null }).toObject(['boardObjectId']))] };
  let second;
  try {
    const work = await prepareNotebookProjection(book, next);
    assert.equal(work.apply(), true);
    assert.equal(book.visible, true, 'confirmation hid the fixture notebook');
    assert.ok(book.calcTransformMatrix().every(Number.isFinite));
    let renders = 0;
    for (const child of book.getPageObjects()) {
      const render = child.render; child.render = function (...args) { renders++; return render.apply(this, args); };
    }
    canvas.renderAll(); assert.equal(renders, 3, 'real child geometry must render');
    second = await captureNotebookObject(book, new Path([['M', 205, 480], ['L', 260, 484]], { stroke: 'black', strokeWidth: 3, fill: null }));
    assert.ok(second?.inside, 'second gesture must remain capturable');
  } finally { second?.inside?.dispose(); second?.outside?.dispose(); await canvas.dispose(); }
});
