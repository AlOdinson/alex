import test from 'node:test';
import assert from 'node:assert/strict';
import { getEnv } from 'fabric/node';
import { setEnv, StaticCanvas, Rect, Textbox, Path } from 'fabric';
import { BoardNotebook } from '../src/lib/boardNotebook.js';
import { createNotebookBoardController } from '../src/lib/notebookBoardController.js';
import { applyAuthorityOpsInPlace } from '../src/lib/authoritySnapshot.js';
import { evaluateAuthorityAction } from '../src/lib/authorityOperationEvaluator.js';
import { prepareAuthoritativeHistory } from '../src/lib/historyOperations.js';
import { updateNotebookTombstones } from '../src/lib/notebookOperations.js';
setEnv(getEnv());
const api=await import('../src/lib/notebookBoardActions.js').catch(()=>({}));
const fields=['boardObjectId','updatedAt','updatedBy','shapeType','isEraserPath','storagePath','objectKind'];
const rec=o=>o.toObject(fields);
async function setup({pages=2,children=[],source=null,hold=false}={}) {
 const book=await BoardNotebook.fromObject({boardObjectId:'book',left:20,top:20,width:300,height:300,notebookPages:Array.from({length:pages},(_,i)=>i?[]:children),notebookPageNumber:1});
 const canvas=new StaticCanvas(null,{width:600,height:600,renderOnAddRemove:false});canvas.add(book);if(source)canvas.add(source);
 const state={revision:0,snapshot:{version:2,background:'blank',canvas:{objects:canvas.getObjects().map(rec)}}};
 let notebookTombstones={},release,blocked=hold;const sent=[],history=[],errors=[];
 const controller=createNotebookBoardController({clientId:'teacher',confirmedState:state,paint:async()=>true,onError:e=>errors.push(e),publish:async input=>{
  sent.push(input);if(blocked){blocked=false;await new Promise(r=>release=r);}
  const ev=evaluateAuthorityAction({...input,snapshot:state.snapshot,notebookVersion:1,notebookTombstones});const h=prepareAuthoritativeHistory(state.snapshot,ev.appliedOps,ev.appliedBackground,input);
  if(ev.changed){state.revision++;applyAuthorityOpsInPlace(state.snapshot,h.appliedOps,ev.appliedBackground);notebookTombstones=updateNotebookTombstones(notebookTombstones,h.appliedOps,input);}
  return {...input,revision:state.revision,ops:h.appliedOps,changed:ev.changed,historyInverseOps:h.historyInverseOps,skippedConflicts:ev.skippedConflicts};
 }});
 assert.equal(typeof api.createNotebookBoardActions,'function','missing incremental Board gesture adapter');
 const actions=api.createNotebookBoardActions({getCanvas:()=>canvas,getController:async()=>controller,clientId:'teacher',acquireLease:async()=>true,ownsLease:()=>true,releaseLease:()=>{},
  getRecords:objects=>objects.map(o=>{assert.notEqual(o,book,'ordinary edit must not serialize whole notebook');return {object:rec(o),zIndex:canvas.getObjects().indexOf(o)};}),
  recordAction:action=>history.push(action),mutate:work=>work(),onChange:()=>{},onError:e=>errors.push(e)});
 return {canvas,book,controller,actions,sent,history,state,errors,release:()=>release(),close:async()=>{controller.dispose();await canvas.dispose();}};
}

test('capturing a second stroke finishes while the first acknowledgement is delayed',async()=>{
 const env=await setup({pages:20,hold:true});
 try{for(let i=0;i<3;i++){const p=new Path(`M 50 ${60+i*12} L 100 ${65+i*12}`,{stroke:'black',fill:null});p.boardObjectId=`source-${i}`;env.canvas.add(p);assert.equal(await env.actions.capture(env.book,p),true);}
  assert.equal(env.book.getPageObjects().length,3);assert.equal(env.controller.pendingCount(),3);assert.equal(env.history.length,3);
  assert.ok(env.history.every(h=>!JSON.stringify(h).includes('notebookPages')));env.release();await env.controller.flush();
  assert.ok(env.sent.every(a=>a.ops.some(op=>op.type==='notebook')));assert.ok(env.sent.every(a=>Buffer.byteLength(JSON.stringify(a))<16384));assert.equal(env.state.snapshot.canvas.objects[0].notebookPages[0].length,3);
 }finally{await env.close();}
});

test('whole text remains the same editable child and its operation contains only changed fields',async()=>{
 const text=new Textbox('before',{left:-80,top:-80,width:100,fontSize:16});text.boardObjectId='text';const env=await setup({children:[rec(text)]});
 try{const child=env.book.getPageObjects()[0];await env.actions.saveText({notebook:env.book,child,pageNumber:1},'after');await env.controller.flush();
  assert.equal(env.book.getPageObjects()[0].type,'textbox');assert.equal(env.book.getPageObjects()[0].boardObjectId,'text');assert.equal(env.book.getPageObjects()[0].text,'after');
  assert.equal(env.sent[0].ops[0].changes[0].type,'patch');assert.equal(env.sent[0].ops[0].changes[0].patch.text,'after');assert.ok(!JSON.stringify(env.sent[0]).includes('notebookPages'));
 }finally{await env.close();}
});

test('object erasing touches only selected page children and produces compact undo',async()=>{
 const a=new Rect({width:10,height:10}),b=new Rect({width:10,height:10});a.boardObjectId='a';b.boardObjectId='b';const env=await setup({children:[rec(a),rec(b)]});
 try{const retained=env.book.getPageObjects()[1];await env.actions.erase([{id:'book',page:1,childIds:new Set(['a'])}]);await env.controller.flush();
  assert.deepEqual(env.book.getPageObjects(),[retained]);assert.equal(env.sent[0].ops[0].changes[0].id,'a');assert.ok(env.history[0].nextHistoryOps[0].changes.some(c=>c.type==='insert'&&c.object.boardObjectId==='a'));
 }finally{await env.close();}
});

test('blank page navigation stays out of undo and each page remains a valid child-operation target',async()=>{
 const env=await setup({pages:1});
 try{for(let page=2;page<=6;page++)await env.actions.changePage(env.book,page);const p=new Path('M 50 60 L 90 80',{stroke:'black'});p.boardObjectId='on-six';env.canvas.add(p);await env.actions.capture(env.book,p);await env.controller.flush();
  assert.equal(env.history.length,1);assert.equal(env.book.notebookPageNumber,6);assert.equal(env.state.snapshot.canvas.objects[0].notebookPages[5].length,1);assert.ok(env.sent.slice(0,5).every(a=>!JSON.stringify(a).includes('notebookPages')));
 }finally{await env.close();}
});

test('a changed target page during asynchronous capture leaves the source stroke on the board',async()=>{
 const env=await setup();
 try{const p=new Rect({left:50,top:50,width:20,height:20});p.boardObjectId='source';env.canvas.add(p);let release;const original=p.clone.bind(p);p.clone=async(...args)=>{await new Promise(r=>release=r);return original(...args);};
 const capture=env.actions.capture(env.book,p);for(let i=0;i<8;i++)await Promise.resolve();env.book.notebookPageNumber=2;release();await assert.rejects(capture,/Страница/);assert.ok(env.canvas.getObjects().includes(p));assert.equal(env.controller.pendingCount(),0);
 }finally{await env.close();}
});

test('untrusted frame navigation cannot allocate an arbitrary range of blank pages',()=>{
 const snapshot={canvas:{objects:[{type:'BoardNotebook',boardObjectId:'book',notebookPages:[[]],notebookPageNumber:1}]}};
 const result=evaluateAuthorityAction({snapshot,notebookVersion:1,ops:[{type:'patch',id:'book',patch:{notebookPageNumber:1000000000}}]});
 assert.equal(result.changed,false);assert.ok(result.skippedConflicts.length);assert.equal(snapshot.canvas.objects[0].notebookPages.length,1);
});

test('a denied notebook lease rejects capture instead of silently publishing an outside stroke',async()=>{
 const canvas=new StaticCanvas(null,{renderOnAddRemove:false}),book=new BoardNotebook({boardObjectId:'book'}),source=new Rect({left:30,top:30,width:10,height:10});source.boardObjectId='input';canvas.add(book,source);
 let enqueued=0;
 const actions=api.createNotebookBoardActions({getCanvas:()=>canvas,getController:async()=>({enqueue(){enqueued++;}}),acquireLease:async()=>false});
 try{await assert.rejects(actions.capture(book,source),/блокнот|занят/i);assert.equal(enqueued,0);assert.ok(canvas.getObjects().includes(source));}finally{await canvas.dispose();}
});

test('an empty painted intersection neither starts a controller nor requests a notebook lease',async()=>{
 const env=await setup();let controllers=0,leases=0;
 const p=new Path('M 0 0 L 380 0 L 380 380',{stroke:'red',strokeWidth:4,fill:null});p.boardObjectId='outside';env.canvas.add(p);
 const actions=api.createNotebookBoardActions({getCanvas:()=>env.canvas,getController:async()=>{controllers++;return env.controller;},clientId:'teacher',acquireLease:async()=>{leases++;return true;},ownsLease:()=>true,releaseLease:()=>{},getRecords:()=>[],recordAction:()=>{throw Error('empty capture creates no history');}});
 try{assert.equal(await actions.capture(env.book,p),false);assert.equal(controllers,0);assert.equal(leases,0);assert.ok(env.canvas.getObjects().includes(p));assert.equal(env.book.getPageObjects().length,0);}
 finally{await env.close();}
});
test('a source moved during preparation is not consumed by the earlier single capture',async()=>{
 const env=await setup();const p=new Rect({left:30,top:80,width:80,height:60,fill:'red'});p.boardObjectId='source';env.canvas.add(p);
 const original=p.clone.bind(p);let resume;p.clone=async(...args)=>{await new Promise(r=>resume=r);return original(...args);};
 try{const pending=env.actions.capture(env.book,p);for(let i=0;i<30&&!resume;i++)await Promise.resolve();assert.ok(resume);p.set({left:90});p.setCoords();resume();await assert.rejects(pending,/Страница/);assert.ok(env.canvas.getObjects().includes(p));assert.equal(env.book.getPageObjects().length,0);assert.equal(env.history.length,0);}
 finally{await env.close();}
});
