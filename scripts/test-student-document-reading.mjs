import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseSync } from 'rolldown/experimental';
import { getEnv } from 'fabric/node';
import { setEnv, Canvas, Rect, FabricImage, Textbox, PencilBrush } from 'fabric';
import { BoardNotebook } from '../src/lib/boardNotebook.js';
import { isBoardMedia } from '../src/lib/boardMediaRuntime.js';
setEnv(getEnv());
const source = fs.readFileSync(new URL('../src/components/Board.jsx', import.meta.url), 'utf8');
const nodes = [];
function visit(n) { if (!n || typeof n !== 'object') return; if (n.type) nodes.push(n); for (const v of Object.values(n)) if (Array.isArray(v)) v.forEach(visit); else if (v && typeof v === 'object') visit(v); }
visit(parseSync('Board.jsx', source).program);
function callback(name, scope) {
  const node = nodes.find(n => n.type === 'VariableDeclarator' && n.id?.name === name && n.init?.callee?.name === 'useCallback');
  const e = node.init.arguments[0];
  return new Function('scope', `with(scope){return (${source.slice(e.start, e.end)});}`)(scope);
}
const api = await import('../src/lib/studentDocumentReading.js').catch(e => { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; return {}; });
const ref = current => ({ current });
const ink = (id, fill) => new Rect({ boardObjectId: id, left: 5, top: 10, width: 12, height: 14, fill }).toObject(['boardObjectId']);
const notebook = () => new BoardNotebook({ boardObjectId: 'book', notebookPages: [[ink('a', 'red')], [ink('b', 'blue')], []] });
const pdf = () => { const el = getEnv().document.createElement('canvas'); el.width = 80; el.height = 100; return new FabricImage(el, { boardObjectId: 'pdf', mediaKind: 'pdf', mediaAssetId: 'a'.repeat(64), pageNumber: 1, pageCount: 3 }); };
const makeCanvas = () => new Canvas(null, { width: 800, height: 650, renderOnAddRemove: false });
const noWrites = () => { throw Error('reading must not acquire a lease, send or record an edit'); };

test('actual Board permits document selection with every mutation control fenced', async () => {
  const canvas = makeCanvas(); const book = notebook(), document = pdf(), text = new Textbox('lesson'); canvas.add(book, document, text);
  const scope = { fabricCanvasRef: ref(canvas), canEditRef: ref(false), canReadDocumentsRef: ref(true), remoteLocksRef: ref(new Map()), clientIdRef: ref('student'), localSelectionTransactionRef: ref(null), isActiveSelectionObject: () => false, applyStudentReadingInteractivity: api.applyStudentReadingInteractivity };
  try {
    callback('applyObjectInteractivity', scope)();
    assert.equal(book.selectable, true, 'a saved notebook must be selectable without editing');
    assert.equal(document.evented, true, 'a PDF must receive selection taps');
    assert.equal(book.hasControls, false); assert.equal(document.hasControls, false);
    for (const o of [book, document]) for (const key of ['lockMovementX','lockMovementY','lockScalingX','lockScalingY','lockRotation']) assert.equal(o[key], true, key);
    assert.equal(text.selectable, false);
    canvas.setActiveObject(document);
    callback('applyObjectInteractivityToObjects', scope)([document]);
    assert.equal(document.selectable, true); assert.equal(document.hasBorders, true);
  } finally { await canvas.dispose(); }
});

test('actual Board read mode enables target finding but never drawing or group selection', async () => {
  const canvas = makeCanvas();
  const scope = { fabricCanvasRef: ref(canvas), canEditRef: ref(false), canReadDocumentsRef: ref(true), activeToolRef: ref('select'), fabricInputModeSwitchRef: ref(null), eraserModeRef: ref('object'), eyedropperActiveRef: ref(false), eyedropperModeRef: ref(null), colorRef: ref('#111111'), opacityRef: ref(1), widthRef: ref(3), PencilBrush, hexToRgba: () => '#111111' };
  try { callback('applyCanvasInputMode', scope)(); assert.equal(canvas.skipTargetFind, false); assert.equal(canvas.isDrawingMode, false); assert.equal(canvas.selection, false); }
  finally { await canvas.dispose(); }
});

test('reader is wired into both actual Board page handlers before any edit queue', async () => {
  const canvas = makeCanvas(), book = notebook(), document = pdf(); canvas.add(book, document); canvas.setActiveObject(document);
  const calls = [];
  const reader = { changePdfPage: (...args) => { calls.push(['pdf', ...args]); }, changeNotebookPage: (...args) => { calls.push(['book', ...args]); } };
  const scope = { fabricCanvasRef: ref(canvas), canEditRef: ref(false), canReadDocumentsRef: ref(true), studentDocumentReaderRef: ref(reader), pdfBusyRef: ref(false), isBoardMedia, queueNotebookMutation: noWrites };
  callback('changePdfPage', scope)(2); callback('changeNotebookPage', scope)(1, 'book', true);
  assert.deepEqual(calls, [['pdf', document, 2], ['book', 1, 'book', true]]);
  await canvas.dispose();
});

function readerFixture({ prepare } = {}) {
  assert.equal(typeof api.createStudentDocumentReader, 'function', 'local page reader exists');
  const canvas = makeCanvas(), book = notebook(), document = pdf(); canvas.add(book, document); let enabled = true;
  const media = { preparePage: prepare ?? (async (_o, page) => ({ page, width: 80, height: page === 2 ? 120 : 100, element: document.getElement() })), showPreparedPage: (_o, result) => { document.shownPage = result.page; } };
  const changes = [], errors = [];
  const reader = api.createStudentDocumentReader({ canvas, canRead: () => enabled, getMediaRuntime: () => media, onChange: () => changes.push(true), onError: error => errors.push(error) });
  return { canvas, book, document, reader, changes, errors, setEnabled: v => enabled = v, close: async () => { reader.dispose(); await canvas.dispose(); } };
}

test('local notebook navigation is bounded, ordered and does not alter saved page records', async () => {
  const f = readerFixture(); const pages = f.book.notebookPages, before = JSON.stringify(pages);
  try {
    await Promise.all([1, 1, 1].map(delta => f.reader.changeNotebookPage(delta, 'book', true)));
    assert.equal(f.book.notebookPageNumber, 3, 'reading cannot create a fourth page');
    assert.equal(f.book.notebookPages, pages); assert.equal(JSON.stringify(pages), before);
    await f.reader.changeNotebookPage(-1, 'book', true); assert.equal(f.book.notebookPageNumber, 2);
    assert.equal(f.book.getPageObjects()[0].fill, 'blue');
    f.setEnabled(false); await f.reader.restore(); assert.equal(f.book.notebookPageNumber, 1);
    assert.equal(f.book.getPageObjects()[0].fill, 'red'); assert.equal(JSON.stringify(pages), before);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('local PDF navigation restores its canonical page and geometry before editing resumes', async () => {
  const f = readerFixture(); const initial = { height: f.document.height, left: f.document.left, top: f.document.top };
  try {
    await f.reader.changePdfPage(f.document, 2); assert.equal(f.document.pageNumber, 2);
    await f.reader.changePdfPage(f.document, 4); assert.equal(f.document.pageNumber, 2);
    f.setEnabled(false); await f.reader.restore(); assert.equal(f.document.pageNumber, 1);
    for (const [key, value] of Object.entries(initial)) assert.equal(f.document[key], value);
    assert.equal(f.document.shownPage, 1);
  } finally { await f.close(); }
});

test('late PDF preparation cannot overwrite a new authoritative snapshot or a removed document', async () => {
  let resolve; const f = readerFixture({ prepare: () => new Promise(r => resolve = r) });
  try {
    const pending = f.reader.changePdfPage(f.document, 2); await new Promise(r => setImmediate(r));
    f.reader.discard(); resolve({ page: 2, width: 80, height: 120 }); await pending;
    assert.equal(f.document.pageNumber, 1); assert.equal(f.document.shownPage, undefined);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('temporary reading locks restore existing object locks instead of unlocking permanent restrictions', async () => {
  assert.equal(typeof api.applyStudentReadingInteractivity, 'function');
  const b = notebook(); b.lockRotation = true; b.lockMovementX = false;
  assert.equal(api.applyStudentReadingInteractivity(b, true), true);
  assert.equal(b.lockMovementX, true); assert.equal(b.lockRotation, true);
  assert.equal(api.applyStudentReadingInteractivity(b, false), false);
  assert.equal(b.lockMovementX, false); assert.equal(b.lockRotation, true);
  await b.dispose();
});

test('authoritative replacement invalidates local work and read-only controls never expose the editing toolbar', () => {
  assert.match(source, /studentDocumentReaderRef\.current\?\.discard\(\)/);
  assert.match(source, /canReadDocuments\s*&&\s*<Toolbar|!canReadDocuments\s*&&\s*<Toolbar/);
  assert.match(source, /canNavigate=\{canEdit \|\| canReadDocuments\}/);
});

test('repeated offline runtime notifications keep reading focus available, including during reconnect restoration', async () => {
  const effect = nodes.find(n => n.type === 'CallExpression' && n.callee?.name === 'useEffect'
    && source.slice(n.start, n.end).includes('let stateGeneration = 0'));
  assert.ok(effect); const node = effect.arguments[0]; let listener;
  const canvas = makeCanvas(); const book = notebook(); canvas.add(book);
  const scope = { boardId:'board', permission:'edit', canEditRef:ref(false), canReadDocumentsRef:ref(true),
    runtimeReadyRef:ref(false), viewedSnapshotRef:ref(true), studentDocumentReaderRef:ref(null),
    activeToolRef:ref('select'), resumeToolRef:ref('pencil'), fabricCanvasRef:ref(canvas),
    setRuntimeReady(){}, setSaveStatus:noWrites, setSyncTone:noWrites,
    applyObjectInteractivity(){ api.applyStudentReadingInteractivity(book, scope.canReadDocumentsRef.current); },
    configureBrushAndMode(){ canvas.skipTargetFind = !(scope.canEditRef.current || scope.canReadDocumentsRef.current); },
    window:{addEventListener:(_n,fn)=>listener=fn,removeEventListener(){}},
    document:{documentElement:{dataset:{}}} };
  const cleanup = new Function('scope',`with(scope){return (${source.slice(node.start,node.end)})();}`)(scope);
  try {
    for (const state of ['waiting','disconnected','waiting']) {
      await listener({detail:{boardId:'board',state}});
      assert.equal(canvas.skipTargetFind,false, 'repeated offline reports cannot disable document selection');
      assert.equal(scope.canEditRef.current,false); assert.equal(book.selectable,true);
      assert.equal(canvas.upperCanvasEl.dataset.readonlyNavigation,'true');
    }
    let finish, cancelled=0;
    scope.studentDocumentReaderRef.current={hasLocalPages:()=>true,restore:()=>new Promise(r=>finish=r),cancelPending:()=>cancelled++};
    const reconnect=listener({detail:{boardId:'board',state:'ready'}});
    assert.equal(scope.canEditRef.current,false,'editing waits for canonical page restoration');
    assert.equal(scope.canReadDocumentsRef.current,false,'new reading cannot race restoration');
    await listener({detail:{boardId:'board',state:'disconnected'}}); finish(); await reconnect;
    assert.equal(cancelled,1); assert.equal(scope.canEditRef.current,false); assert.equal(scope.canReadDocumentsRef.current,true);
    assert.equal(canvas.skipTargetFind,false);
  } finally { cleanup(); await canvas.dispose(); }
});

test('PDF pagination waits for hydrated pixels instead of silently losing an early tap', async () => {
  const { createBoardMediaRuntime } = await import('../src/lib/boardMediaRuntime.js');
  const canvas = makeCanvas(), document = pdf(); canvas.add(document);
  let finish;
  const pixels = document.getElement();
  const runtime = createBoardMediaRuntime({canvas,boardId:'saved-room',
    store:{get:async()=>({metadata:{kind:'pdf'},blob:new Blob(['%PDF-'])})},
    pdfFactory:async()=>({renderPage:()=>new Promise(resolve=>finish=resolve),dispose(){}})});
  try {
    assert.equal(runtime.isPdfReady?.(document) ?? false,false);
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(runtime.isPdfReady?.(document) ?? false,false);
    finish({element:pixels,width:80,height:100});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(runtime.isPdfReady?.(document) ?? false,true,'page controls require a decoded PDF');
    runtime.remove(document);
    assert.equal(runtime.isPdfReady?.(document) ?? false,false);
  } finally { runtime.dispose(); await canvas.dispose(); }
});

test('actual PDF controls reflect local hydration readiness without scanning other files', async () => {
  const canvas=makeCanvas(), document=pdf();canvas.add(document);canvas.setActiveObject(document);
  let ready=false,controls;
  const scope={fabricCanvasRef:ref(canvas),mediaRuntimeRef:ref({isPdfReady:o=>{assert.equal(o,document);return ready;}}),
    isBoardMedia,util:{transformPoint:p=>p},Point:class{constructor(x,y){Object.assign(this,{x,y});}},
    notebookNavigationRef:ref({read:()=>[]}),notebookControlSignatureRef:ref('[]'),pdfControlSignatureRef:ref(''),
    setNotebookControls(){},setPdfControls:value=>controls=value};
  try {
    const update=callback('updatePdfControls',scope);update();
    assert.equal(controls.navigationReady,false);ready=true;update();assert.equal(controls.navigationReady,true);
    assert.match(source,/canNavigate=\{\(canEdit \|\| canReadDocuments\) && pdfControls.navigationReady\}/);
  } finally{await canvas.dispose();}
});
