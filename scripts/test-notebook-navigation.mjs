import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { getEnv } from 'fabric/node';
import { setEnv, Canvas, Rect, Textbox, ActiveSelection, util } from 'fabric';
import { BoardNotebook } from '../src/lib/boardNotebook.js';
import { authorityFixture, createUiHarness, serialized, canvasListener } from './notebook-ui-node-harness.mjs';
setEnv(getEnv());
const navigation = await import('../src/lib/notebookNavigation.js').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {};
});
const book = id => new BoardNotebook({ boardObjectId: id, left: 110, top: 70, notebookPages: [[], [], []] });

for (const tool of ['pencil', 'eraser', 'text', 'line', 'select', 'shape']) {
  test(`page navigation addresses an unselected notebook while using ${tool}`, async () => {
    const { authority } = await authorityFixture([serialized(book('book'))]);
    const ui = await createUiHarness({ authority });
    try {
      ui.canvas.discardActiveObject(); ui.scope.activeToolRef.current = tool;
      await ui.scope.changeNotebookPage(2, 'book'); await ui.flush();
      assert.equal(ui.book().notebookPageNumber, 2);
      assert.equal(ui.canvas.getActiveObject(), undefined);
      assert.equal(ui.scope.activeToolRef.current, tool);
      assert.equal(ui.book().left, 110); assert.equal(ui.book().top, 70);
      assert.equal(ui.history.length, 0, 'page navigation keeps the existing non-history semantics');
    } finally { await ui.close(); }
  });
}

test('each notebook navigates independently, without changing another selected object', async () => {
  const { authority } = await authorityFixture([serialized(book('first')), serialized(book('second'))]);
  const ui = await createUiHarness({ authority });
  try {
    const [first, second] = ui.canvas.getObjects(); ui.canvas.setActiveObject(first);
    await ui.scope.changeNotebookPage(2, 'second'); await ui.flush();
    assert.equal(first.notebookPageNumber, 1); assert.equal(second.notebookPageNumber, 2);
    assert.equal(ui.canvas.getActiveObject(), first);
    await ui.scope.changeNotebookPage(3, 'deleted-id');
    assert.equal(first.notebookPageNumber, 1, 'a stale button never falls back to the active selection');
  } finally { await ui.close(); }
});

test('rapid relative arrow taps advance in queue order and previous stops at page one', async () => {
  const { authority } = await authorityFixture([serialized(book('book'))]);
  const ui = await createUiHarness({ authority });
  try {
    await Promise.all([1, 1, 1].map(delta => ui.scope.changeNotebookPage(delta, 'book', true)));
    await ui.flush(); assert.equal(ui.book().notebookPageNumber, 4);
    for (let i = 0; i < 5; i++) await ui.scope.changeNotebookPage(-1, 'book', true);
    await ui.flush(); assert.equal(ui.book().notebookPageNumber, 1);
    ui.scope.canEditRef.current = false;
    await ui.scope.changeNotebookPage(1, 'book', true); assert.equal(ui.book().notebookPageNumber, 1);
  } finally { await ui.close(); }
});

test('navigation geometry follows the complete notebook transform, including a group and viewport', async () => {
  assert.equal(typeof navigation.notebookNavigationLayout, 'function');
  const canvas = new Canvas(null, { width: 1400, height: 1000, renderOnAddRemove: false });
  try {
    const n = book('book'); n.set({ scaleX: 1.3, scaleY: 1.3 }); canvas.add(n);
    const other = new Rect({ left: 700, top: 500, width: 50, height: 70 }); canvas.add(other);
    canvas.setActiveObject(new ActiveSelection([n, other], { canvas, angle: 12 }));
    canvas.setViewportTransform([1.7, 0, 0, 1.7, -45, 24]);
    const layout = navigation.notebookNavigationLayout(n, canvas);
    const matrix = layout.position.transform.match(/matrix\((.*)\)/)[1].split(',').map(Number);
    for (const [x, y] of [[0, 0], [n.width, 0], [0, n.height], [n.width / 2, n.height]]) {
      const expected = util.transformPoint(util.transformPoint({ x: x - n.width / 2, y: y - n.height / 2 }, n.calcTransformMatrix()), canvas.viewportTransform);
      const actual = util.transformPoint({ x, y }, matrix);
      assert.ok(Math.abs(actual.x - expected.x) < 1e-7); assert.ok(Math.abs(actual.y - expected.y) < 1e-7);
    }
    assert.equal(layout.id, 'book'); assert.equal(layout.pageNumber, 1);
  } finally { await canvas.dispose(); }
});

test('navigation tracker indexes notebooks once, never scans ink or serializes pages on frame ticks', async () => {
  assert.equal(typeof navigation.createNotebookNavigationTracker, 'function');
  const canvas = new Canvas(null, { width: 800, height: 700, renderOnAddRemove: false });
  try {
    const n = book('book'); canvas.add(n, new Rect({ width: 20, height: 20 }));
    const tracker = navigation.createNotebookNavigationTracker(canvas);
    const getObjects = canvas.getObjects;
    n.getPageObjects = () => { throw Error('navigation must not traverse children'); };
    n.toObject = () => { throw Error('navigation must not serialize content'); };
    canvas.getObjects = () => { throw Error('navigation must not rescan the scene'); };
    canvas.discardActiveObject();
    for (let i = 0; i < 120; i++) assert.equal(tracker.read().length, 1);
    const second = book('second'); canvas.add(second); assert.equal(tracker.read().length, 2);
    canvas.remove(second); assert.equal(tracker.read().length, 1);
    n.left = 245; n.notebookPageNumber = 3;
    assert.equal(tracker.read()[0].pageNumber, 3);
    n.visible = false; assert.equal(tracker.read().length, 0);
    tracker.dispose(); assert.deepEqual(tracker.read(), []);
    canvas.getObjects = getObjects;
  } finally { await canvas.dispose(); }
});

function domFixture() {
  const dom = new JSDOM('<div id="host"><canvas></canvas><div id="layer"><div class="notebook-nav-island"><button>Next</button></div></div></div>');
  const { document } = dom.window, layer = document.getElementById('layer');
  const emit = (target, type, fields = {}) => {
    const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 20, clientY: 30, isPrimary: true }, fields);
    target.dispatchEvent(event); return event;
  };
  return { dom, document, layer, canvas: document.querySelector('canvas'), button: document.querySelector('button'), emit };
}

test('an outside pointer passes through all navigation islands until the entire release task ends', async () => {
  assert.equal(typeof navigation.installNotebookNavigationInput, 'function');
  const f = domFixture(), gate = navigation.installNotebookNavigationInput(f.layer);
  try {
    f.emit(f.canvas, 'pointerdown'); assert.equal(gate.allowsActivation(), false);
    assert.equal(f.layer.dataset.gestureActive, 'true');
    f.emit(f.canvas, 'pointerup'); assert.equal(gate.allowsActivation(), false, 'no synthetic click may land on an arrow');
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(gate.allowsActivation(), true);
    f.emit(f.button, 'pointerdown'); assert.equal(gate.allowsActivation(), true, 'a deliberate arrow contact is not a board stroke');
  } finally { gate.dispose(); f.dom.window.close(); }
});

test('multi-contact, legacy TouchEvents, cancellation, blur and disposal cannot strand the navigation gate', async () => {
  assert.equal(typeof navigation.installNotebookNavigationInput, 'function');
  const f = domFixture(), gate = navigation.installNotebookNavigationInput(f.layer);
  try {
    f.emit(f.canvas, 'pointerdown', { pointerId: 7 }); f.emit(f.canvas, 'pointerdown', { pointerId: 8 });
    f.emit(f.canvas, 'pointerup', { pointerId: 7 }); await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(gate.allowsActivation(), false);
    f.emit(f.canvas, 'pointercancel', { pointerId: 8 }); await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(gate.allowsActivation(), true);
    f.emit(f.canvas, 'touchstart', { changedTouches: [{ identifier: 4 }] }); assert.equal(gate.allowsActivation(), false);
    f.emit(f.canvas, 'touchcancel', { changedTouches: [{ identifier: 4 }] }); await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(gate.allowsActivation(), true);
    f.emit(f.canvas, 'pointerdown'); f.emit(f.dom.window, 'blur'); assert.equal(gate.allowsActivation(), true);
    gate.dispose(); f.emit(f.canvas, 'pointerdown'); assert.equal(f.layer.dataset.gestureActive, undefined);
  } finally { gate.dispose(); f.dom.window.close(); }
});

for (const pointerType of ['mouse', 'pen', 'touch']) {
  test(`${pointerType}: one deliberate tap turns once, crossing/moving/cancelled contacts and compatibility click do not`, () => {
    assert.equal(typeof navigation.createNotebookNavigationTap, 'function');
    let turns = 0, allowed = true;
    const target = { isConnected: true, setPointerCapture() {}, releasePointerCapture() {},
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 50, bottom: 50 }) };
    const e = fields => ({ currentTarget: target, pointerId: 1, pointerType, button: 0, isPrimary: true,
      clientX: 20, clientY: 30, preventDefault() {}, stopPropagation() {}, ...fields });
    const tap = navigation.createNotebookNavigationTap({ canActivate: () => allowed, activate: () => turns++ });
    tap.up(e()); assert.equal(turns, 0, 'crossing with no down on button is not a tap');
    tap.down(e()); tap.up(e()); tap.click(e({ detail: 1 })); assert.equal(turns, 1);
    tap.down(e()); tap.move(e({ clientX: 100 })); tap.up(e()); assert.equal(turns, 1);
    tap.down(e()); tap.cancel(e()); tap.up(e()); assert.equal(turns, 1);
    tap.down(e()); allowed = false; tap.up(e()); assert.equal(turns, 1);
    allowed = true; tap.down(e()); tap.up(e({ clientX: 90 })); assert.equal(turns, 1);
    tap.down(e({ isPrimary: false })); tap.up(e({ isPrimary: false })); assert.equal(turns, 1);
    tap.click(e({ detail: 0 })); assert.equal(turns, 2, 'native keyboard activation remains available');
  });
}


test('page turn finalizes an in-progress text draft on its original page and keeps the text tool', async () => {
  const n = book('book'), text = new Textbox('Draft before turn', { boardObjectId: 'text', left: 170, top: 130, width: 170, fontSize: 20, originX: 'left', originY: 'top' });
  const { authority } = await authorityFixture([serialized(n), serialized(text)]);
  const ui = await createUiHarness({ authority });
  try {
    const draft = ui.canvas.getObjects().find(o => o.boardObjectId === 'text');
    Object.assign(ui.scope, {
      notebookPageTextExitRef: { current: new WeakSet() }, mobileTextEditorRef: { current: null },
      textChangeTimerRef: { current: null }, textBeforeRef: { current: new Map([['text', ui.scope.getObjectRecords([draft])]]) },
      newTextDraftIdsRef: { current: new Set() }, selectedShapeRef: { current: null },
      setMobileTextEditor() {}, sendLocalLock() {}, configureBrushAndMode() {}, setToolState() {}, sendRecordPatches() {},
    });
    ui.scope.notebookHandlersRef.current.capture = ui.scope.captureIntoNotebook;
    ui.canvas.on('text:editing:exited', canvasListener('text:editing:exited', ui.scope));
    ui.canvas.setActiveObject(draft); draft.enterEditing(); ui.scope.activeToolRef.current = 'text';
    await ui.scope.changeNotebookPage(1, 'book', true); await ui.flush();
    assert.equal(draft.isEditing, false, 'finish text before hiding its page');
    assert.equal(ui.book().notebookPageNumber, 2);
    assert.equal(ui.book().notebookPages[0][0]?.text, 'Draft before turn');
    assert.equal(ui.scope.activeToolRef.current, 'text', 'page navigation must not switch to selection');
    assert.deepEqual(ui.errors, []);
  } finally { await ui.close(); }
});

test('lost outside mouse release and an abandoned file drag cannot leave the arrows unclickable', async () => {
  const f = domFixture(), gate = navigation.installNotebookNavigationInput(f.layer);
  try {
    f.emit(f.canvas, 'pointerdown'); f.emit(f.canvas, 'pointermove', { buttons: 0 });
    await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(gate.allowsActivation(), true);
    f.emit(f.canvas, 'dragenter', { dataTransfer: { types: ['Files'] } }); assert.equal(gate.allowsActivation(), false);
    f.emit(f.document.documentElement, 'dragleave', { relatedTarget: null });
    await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(gate.allowsActivation(), true);
  } finally { gate.dispose(); f.dom.window.close(); }
});

test('a pen sample with zero buttons does not hand its ongoing stroke to the navigation', async () => {
  const f = domFixture(), gate = navigation.installNotebookNavigationInput(f.layer);
  try {
    f.emit(f.canvas, 'pointerdown', { pointerType: 'pen' });
    f.emit(f.canvas, 'pointermove', { pointerType: 'pen', buttons: 0, pressure: 0.5 });
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(gate.allowsActivation(), false);
    assert.equal(f.layer.dataset.gestureActive, 'true');
  } finally { gate.dispose(); f.dom.window.close(); }
});

// Exercise the actual window capture handler: React's bubble stop is too late
// to stop the board's Space-pan / Delete / arrow-key shortcuts.
test('focused notebook controls retain native keyboard activation instead of board shortcuts', () => {
  const source = readFileSync(new URL('../src/components/Board.jsx', import.meta.url), 'utf8');
  const from = source.indexOf('    function handleKeyDown(event) {');
  const to = source.indexOf('    function handleKeyUp(event)', from);
  assert.ok(from >= 0 && to > from);
  const f = domFixture();
  const state = { deleted: 0, panned: 0 };
  const scope = { canvas: { getActiveObject: () => null },
    HTMLInputElement: f.dom.window.HTMLInputElement, HTMLTextAreaElement: f.dom.window.HTMLTextAreaElement,
    HTMLSelectElement: f.dom.window.HTMLSelectElement, IText: Textbox, isOwner: false,
    spacePressedRef: { current: false }, canEditRef: { current: true }, heldArrowKeys: new Map(),
    startArrowPan: () => state.panned++, deleteSelection: () => state.deleted++ };
  const handler = new Function('scope', `with(scope){${source.slice(from, to)};return handleKeyDown;}`)(scope);
  try {
    const button = f.layer.querySelector('button');
    for (const [key, code] of [[' ', 'Space'], ['Enter', 'Enter'], ['Delete', 'Delete'], ['ArrowLeft', 'ArrowLeft']]) {
      let prevented = false;
      handler({ target: button, key, code, preventDefault: () => { prevented = true; }, stopPropagation() {} });
      assert.equal(prevented, false, `${code} belongs to the focused notebook control`);
    }
    assert.equal(scope.spacePressedRef.current, false); assert.deepEqual(state, { deleted: 0, panned: 0 });
    let prevented = false;
    handler({ target: f.canvas, key: ' ', code: 'Space', preventDefault: () => { prevented = true; }, stopPropagation() {} });
    assert.equal(prevented, true); assert.equal(scope.spacePressedRef.current, true, 'board Space-pan is unchanged away from controls');
  } finally { f.dom.window.close(); }
});

test('losing focus on a toolbar button does not release a live canvas gesture', async () => {
  const { holdNotebookTransformProjection } = await import('../src/lib/notebookBoardActions.js');
  const f = domFixture(), gate = navigation.installNotebookNavigationInput(f.layer);
  let depth = 0;
  const release = holdNotebookTransformProjection({ suspendProjection: () => depth++, resumeProjection: () => depth-- },
    { eventTarget: f.dom.window, pointerId: 1 });
  try {
    f.button.focus(); f.emit(f.canvas, 'pointerdown');
    f.button.blur(); // FocusEvent does not bubble, but window capture DOES see it.
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(gate.allowsActivation(), false, 'element blur must not unblock an ongoing stroke');
    assert.equal(depth, 1, 'element blur must not resume old notebook projection during a held drag');
    f.emit(f.dom.window, 'blur');
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(gate.allowsActivation(), true); assert.equal(depth, 0, 'real window blur still releases safely');
  } finally { release(); gate.dispose(); f.dom.window.close(); }
});
