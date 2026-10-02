import test from 'node:test';
import assert from 'node:assert/strict';
import { getEnv } from 'fabric/node';
import { setEnv, Rect, StaticCanvas, classRegistry } from 'fabric';
import { createBoardNotebook, BoardNotebook } from '../src/lib/boardNotebook.js';
setEnv(getEnv());
const api = await import('../src/lib/notebookProjection.js').catch(() => ({}));
const prepare = (...args) => { assert.equal(typeof api.prepareNotebookProjection, 'function', 'missing notebook model-to-canvas projection'); return api.prepareNotebookProjection(...args); };
const child = (id, options={}) => ({ ...new Rect({ width:30, height:20, left:-100, top:-100, ...options }).toObject(), boardObjectId:id });
const model = (book, pages, page=book.notebookPageNumber) => ({...book.toObject(['boardObjectId']), notebookPages:pages, notebookPageNumber:page});

test('projection of one new stroke retains all unchanged children and never revives hidden images', async()=>{
 const book=await BoardNotebook.fromObject({type:'BoardNotebook',boardObjectId:'book',notebookPages:[[child('one'),child('two')],[]],notebookPageNumber:1});
 const old=book.getPageObjects(), records=book.notebookPages[0];
 const hidden = Object.freeze([{type:'Image',boardObjectId:'hidden',get src(){throw new Error('hidden image traversed');}}]);
 const target=model(book,[Object.freeze([...records,child('three')]),hidden]);
 let revivals=0; const original=Rect.fromObject; Rect.fromObject=function(...args){revivals++;return original.apply(this,args);};
 try {
  const task=await prepare(book,target); assert.equal(task.apply(),true);
  assert.equal(revivals,1);assert.equal(book.getPageObjects()[0],old[0]);assert.equal(book.getPageObjects()[1],old[1]);
  assert.equal(book.notebookPages[1],hidden);assert.equal(book.getPageObjects()[2].boardObjectId,'three');
 }finally{Rect.fromObject=original;book.dispose();}
});

test('acknowledging identical content does not re-enliven or dirty the visible notebook',async()=>{
 const book=await BoardNotebook.fromObject({boardObjectId:'book',notebookPages:[[child('one')]],notebookPageNumber:1});
 const same=structuredClone(book.toObject(['boardObjectId']));const original=Rect.fromObject;book.dirty=false;
 Rect.fromObject=()=>{throw new Error('identical child revived');};
 try{const prepared=await prepare(book,same);assert.equal(prepared.apply(),true);assert.equal(book.dirty,false);}
 finally{Rect.fromObject=original;book.dispose();}
});

test('projection rejection removes one stroke but preserves later input and child identity',async()=>{
 const book=await BoardNotebook.fromObject({boardObjectId:'book',notebookPages:[[child('first'),child('rejected'),child('last')]],notebookPageNumber:1});
 const last=book.getPageObjects()[2], target=model(book,[[book.notebookPages[0][0],book.notebookPages[0][2]]]);
 const task=await prepare(book,target);task.apply();assert.deepEqual(book.getPageObjects().map(x=>x.boardObjectId),['first','last']);assert.equal(book.getPageObjects()[1],last);book.dispose();
});

test('projection reconciles retained-child order and matches reference pixels',async()=>{
 const a=child('a',{fill:'red'}), b=child('b',{fill:'blue',left:-90});
 const book=await BoardNotebook.fromObject({boardObjectId:'book',width:260,height:200,left:5,top:5,notebookPages:[[a,b]],notebookPageNumber:1});
 const old=book.getPageObjects(), target=model(book,[[book.notebookPages[0][1],book.notebookPages[0][0]]]);
 const work=await prepare(book,target);work.apply();assert.deepEqual(book.getPageObjects(),[old[1],old[0]]);
 const reference=await BoardNotebook.fromObject(target);const canvases=[book,reference].map(n=>{const c=new StaticCanvas(null,{width:280,height:220,enableRetinaScaling:false});c.add(n);c.renderAll();return c;});
 try{assert.deepEqual(Buffer.from(canvases[0].getContext().getImageData(0,0,280,220).data),Buffer.from(canvases[1].getContext().getImageData(0,0,280,220).data));}finally{await Promise.all(canvases.map(c=>c.dispose()));}
});

test('stale projection never replaces a newer local edit',async()=>{
 const book=createBoardNotebook({boardObjectId:'book'});let current=true;
 const work=await prepare(book,model(book,[[child('obsolete')]]),{isCurrent:()=>current});
 const fresh=new Rect({width:5,height:5});fresh.boardObjectId='newer';book.addPageObject(fresh);current=false;
 assert.equal(work.apply(),false);work.dispose();assert.equal(book.getPageObjects()[0],fresh);book.dispose();
});

test('retired notebook cannot receive a prepared projection',async()=>{
 const book=createBoardNotebook({boardObjectId:'book'});const work=await prepare(book,model(book,[[child('late')]]));
 book.dispose();assert.equal(work.apply(),false);work.dispose();
});

test('frame-only patch carries no child data even when pages contain unreadable sentinels',()=>{
 assert.equal(typeof api.notebookFramePatch,'function','missing frame-only patch builder');
 const book={type:'BoardNotebook',boardObjectId:'book',left:1,notebookPageNumber:1,notebookPages:[{get contents(){throw new Error('page serialized');}}]};
 const patch=api.notebookFramePatch(book,{...book,left:8});assert.deepEqual(patch.patch,{left:8});assert.ok(!JSON.stringify(patch).includes('notebookPages'));
});

test('compound projection can preflight every prepared member before any visible mutation', async () => {
  const book=await BoardNotebook.fromObject({boardObjectId:'preflight',notebookPages:[[]],notebookPageNumber:1});
  const projection=await prepare(book,book.toObject(['boardObjectId']));
  try {assert.equal(typeof projection.isCurrent,'function');assert.equal(projection.isCurrent(),true);book.notebookPageNumber=2;assert.equal(projection.isCurrent(),false);}finally{projection.dispose();book.dispose();}
});
