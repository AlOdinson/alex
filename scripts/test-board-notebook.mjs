import test from 'node:test';
import assert from 'node:assert/strict';
import { getEnv } from 'fabric/node';
import { setEnv, Rect, Textbox, FabricImage, StaticCanvas, util } from 'fabric';
import { createBoardNotebook, isBoardNotebook, setNotebookPage, captureNotebookObject, notebookObjectIntersection } from '../src/lib/boardNotebook.js';
setEnv(getEnv());

const near = (a, b) => a.forEach((value, index) => assert.ok(Math.abs(value - b[index]) < 1e-6, `${a} != ${b}`));

test('notebook preserves transforms and lazy pages through registered JSON revival', async () => {
  const notebook = createBoardNotebook({ left: 200, top: 160, scaleX: 1.4, scaleY: 1.4 });
  const child = new Rect({ left: -230, top: -180, width: 700, height: 20, strokeWidth: 0 });
  const original = child.calcOwnMatrix();
  notebook.addPageObject(child);
  near(child.calcOwnMatrix(), original);
  assert.equal(notebook.width, 520);
  assert.equal(notebook.height, 480);
  assert.equal(await setNotebookPage(notebook, 2), true);
  assert.equal(notebook.getPageObjects().length, 0);
  assert.equal(notebook.notebookPages[0].length, 1);
  notebook.addPageObject(new Rect({ width: 10, height: 12 }));
  const serialized = notebook.toObject(['id']);
  assert.equal(serialized.objects, undefined);
  assert.equal(serialized.clipPath, undefined);
  const [revived] = await util.enlivenObjects([JSON.parse(JSON.stringify(serialized))]);
  assert.equal(isBoardNotebook(revived), true);
  assert.equal(revived.getPageObjects().length, 1);
  assert.equal(revived.getPageObjects()[0].boardObjectId, notebook.getPageObjects()[0].boardObjectId);
  assert.equal(revived.notebookPageNumber, 2);
  assert.equal(await setNotebookPage(revived, 1), true);
  near(revived.getPageObjects()[0].calcOwnMatrix(), original);
  assert.equal(await setNotebookPage(revived, 0), false);
  assert.equal(await setNotebookPage(revived, 4), false);
});

test('capture preserves source and world geometry while clipping a boundary crossing', async () => {
  const notebook = createBoardNotebook({ left: 100, top: 100, angle: 25, scaleX: 1.2, scaleY: 1.2 });
  const object = new Rect({ width: 100, height: 70, strokeWidth: 0 });
  util.applyTransformToObject(object, util.multiplyTransformMatrices(notebook.calcTransformMatrix(), [1, 0, 0, 1, 245, 0]));
  object.setCoords();
  const before = JSON.stringify(object.toObject());
  const result = await captureNotebookObject(notebook, object);
  assert.equal(result.split, true);
  assert.equal(result.inside.clipPath.inverted, false);
  assert.equal(result.outside.clipPath.inverted, true);
  notebook.addPageObject(result.inside);
  near(result.inside.calcTransformMatrix(), object.calcTransformMatrix());
  near(result.outside.calcTransformMatrix(), object.calcTransformMatrix());
  assert.equal(JSON.stringify(object.toObject()), before);
  assert.equal(notebook.width, 520);
});

test('whole text stays editable; cut text produces two static image fragments', async () => {
  const notebook = createBoardNotebook({ left: 0, top: 0 });
  const whole = new Textbox('editable', { left: 70, top: 70, width: 120, fontSize: 24 });
  const captured = await captureNotebookObject(notebook, whole);
  assert.equal(captured.split, false);
  assert.equal(captured.inside.type, 'textbox');
  const crossing = new Textbox('cut text', { left: 490, top: 100, width: 100, fontSize: 24 });
  const source = JSON.stringify(crossing.toObject());
  const cut = await captureNotebookObject(notebook, crossing);
  assert.equal(cut.split, true);
  assert.ok(cut.inside instanceof FabricImage);
  assert.ok(cut.outside instanceof FabricImage);
  assert.equal(JSON.stringify(crossing.toObject()), source);
  notebook.addPageObject(cut.inside);
  const [revived] = await util.enlivenObjects([notebook.toObject()]);
  assert.equal(revived.getPageObjects()[0].type, 'image');
});

test('rotated separation and unsupported media are excluded', async () => {
  const notebook = createBoardNotebook({ left: 0, top: 0, angle: 45 });
  const far = new Rect({ left: 900, top: 900, width: 10, height: 10 });
  assert.equal(notebookObjectIntersection(notebook, far).intersects, false);
  assert.equal(await captureNotebookObject(notebook, far), null);
  const gif = new Rect({ left: 0, top: 0, width: 200, height: 200 });
  gif.mediaKind = 'gif';
  assert.equal(await captureNotebookObject(notebook, gif), null);
  assert.equal(await captureNotebookObject(notebook, notebook), null);
});


test('rendered split masks keep only the intended side of the page boundary', async () => {
  const notebook = createBoardNotebook({ left: 0, top: 0 });
  const source = new Rect({ left: 500, top: 100, originX: 'center', originY: 'center', width: 100, height: 40, fill: '#ff0000', strokeWidth: 0 });
  const { inside, outside } = await captureNotebookObject(notebook, source);
  notebook.addPageObject(inside);
  const canvas = new StaticCanvas(null, { width: 600, height: 500, enableRetinaScaling: false, renderOnAddRemove: false });
  canvas.add(notebook);
  canvas.renderAll();
  const pixel = (x, y) => [...canvas.getContext().getImageData(x, y, 1, 1).data];
  assert.deepEqual(pixel(480, 100), [255, 0, 0, 255]);
  assert.deepEqual(pixel(540, 100), [0, 0, 0, 0]);
  canvas.remove(notebook);
  canvas.add(outside);
  canvas.renderAll();
  assert.deepEqual(pixel(480, 100), [0, 0, 0, 0]);
  assert.deepEqual(pixel(540, 100), [255, 0, 0, 255]);
  await canvas.dispose();
});

test('empty page navigation leaves content unchanged and survives undo on another page', async () => {
  const notebook = createBoardNotebook();
  const initial = JSON.stringify(notebook.toObject().notebookPages);
  await setNotebookPage(notebook, 2);
  assert.equal(JSON.stringify(notebook.toObject().notebookPages), initial);
  const [restored] = await util.enlivenObjects([{ ...notebook.toObject(), notebookPages: [[]] }]);
  assert.equal(restored.notebookPageNumber, 2);
  assert.equal(restored.getPageObjects().length, 0);
});

test('touching the edge without overlap does not rasterize or capture text', async () => {
  const notebook = createBoardNotebook();
  const text = new Textbox('outside', {left:520,top:50,width:120,fontSize:20,originX:'left',originY:'top',strokeWidth:0});
  assert.equal(await captureNotebookObject(notebook,text),null);
});
test('recapturing an outside fragment cannot duplicate page child identities', async () => {
  const notebook=createBoardNotebook();
  const source=new Rect({left:500,top:100,width:80,height:80,originX:'left',originY:'top'});
  source.boardObjectId='source';
  const first=await captureNotebookObject(notebook,source);notebook.addPageObject(first.inside);
  first.outside.boardObjectId='source';first.outside.left-=30;first.outside.setCoords();
  const second=await captureNotebookObject(notebook,first.outside);notebook.addPageObject(second.inside);
  assert.notEqual(first.inside.boardObjectId,second.inside.boardObjectId);
  assert.notEqual(first.inside.boardObjectId,'source');
});

test('hydrating 600 children is linear and reads leave the render cache clean', async () => {
  const sample = new Rect({width:8,height:8}).toObject();
  const original = Rect.prototype.toObject;
  let visits = 0;
  Rect.prototype.toObject = function(...args) {visits++;return original.apply(this,args);};
  try {
    const book = await (await import('../src/lib/boardNotebook.js')).BoardNotebook.fromObject({notebookPages:[Array.from({length:600},()=>structuredClone(sample))]});
    assert.ok(visits <= 1200, `600 children serialized ${visits} times`);
    book.dirty=false;visits=0;
    book.toObject();book.toObject();
    assert.equal(book.dirty,false,'serialization is not a content mutation');
    assert.ok(visits<=2,'unchanged children must not be serialized again');
  } finally {Rect.prototype.toObject=original;}
});

test('incremental child serialization preserves immutable before records and hidden pages', async () => {
  const book=createBoardNotebook();
  const first=new Rect({width:8,height:8,fill:'red'});book.addPageObject(first);
  const before=book.toObject(),beforeJSON=JSON.stringify(before);
  let visits=0;const original=first.toObject;first.toObject=function(...args){visits++;return original.apply(this,args);};
  book.addPageObject(new Rect({width:4,height:4}));
  book.toObject();
  assert.equal(visits,0,'adding a sibling must not serialize the existing child');
  first.set('fill','blue');book.invalidatePageContent(first);book.toObject();
  assert.equal(JSON.stringify(before),beforeJSON,'retained history must not be mutated');
  const page=book.toObject().notebookPages[0];
  await setNotebookPage(book,2);
  book.addPageObject(new Rect({width:2,height:2}));
  const after=book.toObject();
  assert.equal(after.notebookPages[0],page,'unchanged hidden records are shared immutably');
  assert.notEqual(book.serializeNotebookForSnapshot().notebookPages,after.notebookPages,'explicit snapshot detaches data');
});

test('cached notebook stays visible at zoom and releases old page surfaces', async () => {
  const book=createBoardNotebook({left:10,top:10,width:150,height:150});
  book.addPageObject(new Rect({left:-65,top:-65,width:100,height:100,fill:'red',strokeWidth:0}));
  const c=new StaticCanvas(null,{width:500,height:500,enableRetinaScaling:false,renderOnAddRemove:false});c.add(book);c.renderAll();
  const previous=book.getPageObjects()[0];
  c.setZoom(2);c.cancelRequestedRender();c.renderAll();
  assert.deepEqual([...c.getContext().getImageData(70,70,1,1).data],[255,0,0,255]);
  book.dirty=false;book.toObject();c.renderAll();
  assert.deepEqual([...c.getContext().getImageData(70,70,1,1).data],[255,0,0,255]);
  await setNotebookPage(book,2);c.cancelRequestedRender();c.renderAll();
  assert.equal(previous._cacheCanvas,undefined);
  await setNotebookPage(book,1);c.cancelRequestedRender();c.renderAll();
  assert.deepEqual([...c.getContext().getImageData(70,70,1,1).data],[255,0,0,255]);
  const {notebookRenderCacheFor}=await import('../src/lib/notebookRenderCache.js');
  assert.ok(notebookRenderCacheFor(c).bytesUsed()>0);await c.dispose();
  assert.equal(notebookRenderCacheFor(c).bytesUsed(),0);
});

test('page navigation preserves serialized child data exactly instead of round-tripping it', async () => {
  const record=new Rect({left:-11.123456,top:-6.876543,width:13,height:7,angle:13.37}).toObject(['boardObjectId']);
  record.boardObjectId='stable-child';record.metadataFromSnapshot={source:'retained'};
  const {BoardNotebook}=await import('../src/lib/boardNotebook.js');
  const book=await BoardNotebook.fromObject({notebookPages:[[record],[]]});
  assert.deepEqual(book.toObject().notebookPages[0][0],record,'hydration is a read, not an edit');
  const before=JSON.stringify(book.toObject().notebookPages);
  await setNotebookPage(book,2);await setNotebookPage(book,1);
  assert.equal(JSON.stringify(book.toObject().notebookPages),before,'navigation must not conflict with an earlier conditional undo');
});
