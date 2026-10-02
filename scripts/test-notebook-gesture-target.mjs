import test from 'node:test';
import assert from 'node:assert/strict';
const api=await import('../src/lib/notebookGestureTarget.js').catch(()=>({}));
function setup(){assert.equal(typeof api.snapshotNotebookGesturePages,'function');const notebook={type:'boardnotebook',boardObjectId:'book',notebookPageNumber:1,width:300,height:300,calcTransformMatrix:()=>[1,0,0,1,100,100]};return {notebook,canvas:{getObjects:()=>[notebook]}};}

test('gesture target capture reads frame metadata, not hidden page content',()=>{
 const {notebook,canvas}=setup();Object.defineProperty(notebook,'notebookPages',{get(){throw Error('hidden pages visited');}});
 const ink={};api.bindNotebookGestureTarget(ink,api.snapshotNotebookGesturePages(canvas));
 assert.equal(api.consumeNotebookGesturePage(ink,notebook),1);
 assert.deepEqual(Object.keys(ink),[],'no gesture metadata in serialization');
});
test('page changed before pointer-up is not silently selected as the stroke destination',()=>{
 const {notebook,canvas}=setup(),ink={};api.bindNotebookGestureTarget(ink,api.snapshotNotebookGesturePages(canvas));notebook.notebookPageNumber=2;
 assert.throws(()=>api.consumeNotebookGesturePage(ink,notebook),/Страница|рамка/);
 assert.equal(api.consumeNotebookGesturePage(ink,notebook),2,'a failed attempt releases its retained frame references');
});
test('a replaced or moved notebook cannot claim an older gesture',()=>{
 const {notebook,canvas}=setup(),ink={};api.bindNotebookGestureTarget(ink,api.snapshotNotebookGesturePages(canvas));
 assert.throws(()=>api.consumeNotebookGesturePage(ink,{...notebook}),/Страница|рамка/);
 api.bindNotebookGestureTarget(ink,api.snapshotNotebookGesturePages(canvas));notebook.calcTransformMatrix=()=>[1,0,0,1,200,100];
 assert.throws(()=>api.consumeNotebookGesturePage(ink,notebook),/Страница|рамка/);
});
test('ordinary outside-board strokes release their gesture metadata',()=>{
 const {notebook,canvas}=setup(),ink={};api.bindNotebookGestureTarget(ink,api.snapshotNotebookGesturePages(canvas));
 assert.equal(api.consumeNotebookGesturePage(ink,null),null);notebook.notebookPageNumber=2;
 assert.equal(api.consumeNotebookGesturePage(ink,notebook),2);
});
