import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAuthorityAction } from '../src/lib/authorityOperationEvaluator.js';
import { applyAuthorityOpsInPlace } from '../src/lib/authoritySnapshot.js';
import { prepareAuthoritativeHistory } from '../src/lib/historyOperations.js';
import { updateNotebookTombstones } from '../src/lib/notebookOperations.js';
const api=await import('../src/lib/notebookBoardController.js').catch(()=>({}));
const create=options=>{assert.equal(typeof api.createNotebookBoardController,'function','missing UI/session controller');return api.createNotebookBoardController(options);};
const baseline=()=>({revision:0,snapshot:{version:2,background:'grid',canvas:{objects:[{type:'BoardNotebook',boardObjectId:'book',notebookPageNumber:1,notebookPages:[[],[]]}]}}});
const add=id=>({actionId:id,ops:[{type:'notebook',version:1,id:'book',pageNumber:1,changes:[{type:'insert',ifAbsent:true,object:{type:'Rect',boardObjectId:id,width:10,height:10}}]}]});
const ids=view=>view.snapshot.canvas.objects[0].notebookPages[0].map(x=>x.boardObjectId);
const tick=async()=>{for(let i=0;i<15;i++)await Promise.resolve();};
const server=()=>{const state=baseline();let notebookTombstones={};return {state,commit(input){const ev=evaluateAuthorityAction({...input,snapshot:state.snapshot,notebookVersion:1,notebookTombstones});const hist=prepareAuthoritativeHistory(state.snapshot,ev.appliedOps,ev.appliedBackground,input);if(ev.changed){state.revision++;applyAuthorityOpsInPlace(state.snapshot,hist.appliedOps,ev.appliedBackground);notebookTombstones=updateNotebookTombstones(notebookTombstones,hist.appliedOps,input);}return {...input,revision:state.revision,changed:ev.changed,ops:hist.appliedOps,historyInverseOps:hist.historyInverseOps,skippedConflicts:ev.skippedConflicts};}};};

test('controller previews later strokes while first acknowledgement waits; rejection preserves siblings',async()=>{
 const authority=server();let release;const paints=[];
 const controller=create({confirmedState:baseline(),clientId:'teacher',publish:async action=>{if(action.actionId==='first')await new Promise(r=>release=r);if(action.actionId==='bad')return {actionId:'bad',revision:authority.state.revision,changed:false,accepted:false,ops:[]};return authority.commit(action);},paint:async(view,context)=>{assert.ok(context.objectIds.has('book'));paints.push(ids(view));return true;}});
 const first=controller.enqueue(add('first')),bad=controller.enqueue(add('bad')),last=controller.enqueue(add('last'));
 await tick();await controller.whenPainted();assert.deepEqual(paints.at(-1),['first','bad','last']);assert.equal(controller.pendingCount(),3);assert.ok(controller.pendingObjectIds().has('book'));
 release();await assert.rejects(bad.settled);await Promise.all([first.settled,last.settled]);await controller.flush();
 assert.deepEqual(paints.at(-1),['first','last']);assert.equal(controller.pendingObjectIds().size,0);controller.dispose();
});

test('newer projection invalidates a slow painter instead of applying obsolete visible state',async()=>{
 const authority=server();let unlock,started=false;const applied=[];
 const controller=create({confirmedState:baseline(),clientId:'teacher',publish:action=>authority.commit(action),paint:async(view,context)=>{if(!started){started=true;await new Promise(r=>unlock=r);}if(!context.isCurrent())return false;applied.push(ids(view));return true;}});
 controller.enqueue(add('one'));await tick();controller.enqueue(add('two'));await tick();unlock();await controller.flush();
 assert.deepEqual(applied.at(-1),['one','two']);assert.ok(!applied.some(a=>a.length===1));controller.dispose();
});

test('history requests keep their identity and history marker through durable publication',async()=>{
 const authority=server(), sent=[];
 const controller=create({confirmedState:baseline(),clientId:'teacher',publish:input=>{sent.push(input);return authority.commit(input);},paint:async()=>true});
 const added=controller.enqueue(add('original'));
 const undo=controller.enqueue({actionId:'undo-original',history:true,ops:added.inverseOps});
 await Promise.all([added.settled,undo.settled]);await controller.flush();
 assert.equal(sent[1].actionId,'undo-original');assert.equal(sent[1].history,true);assert.deepEqual(ids(controller.getState()),[]);controller.dispose();
});

test('outbox recovery is painted and resent with the same action identifier',async()=>{
 const authority=server(),removed=[],sent=[];let visible=[];
 const controller=create({confirmedState:baseline(),clientId:'teacher',initialPendingActions:[{...add('recovered'),clientId:'teacher',baseRevision:0}],outbox:{save:async()=>{throw new Error('must not resave an existing intent');},remove:async id=>removed.push(id)},publish:action=>{sent.push(action.actionId);return authority.commit(action);},paint:async view=>{visible=ids(view);return true;}});
 await controller.flush();assert.deepEqual(sent,['recovered']);assert.deepEqual(visible,['recovered']);assert.deepEqual(removed,['recovered']);controller.dispose();
});

test('all ordered commits advance the model, including ordinary objects between notebook edits',async()=>{
 const authority=server();const controller=create({confirmedState:baseline(),clientId:'teacher',publish:action=>authority.commit(action),paint:async()=>true});
 await controller.enqueue(add('first')).settled;
 const remote=authority.commit({actionId:'remote-shape',clientId:'student',ops:[{type:'upsert',object:{type:'Rect',boardObjectId:'other',width:20}}]});controller.ack(remote);
 await controller.enqueue(add('second')).settled;await controller.flush();assert.equal(controller.getState().revision,3);assert.equal(controller.getState().snapshot.canvas.objects.length,2);assert.deepEqual(ids(controller.getState()),['first','second']);controller.dispose();
});

test('failed projection is reported, retained and can be retried without losing an edit',async()=>{
 const authority=server(),errors=[];let fail=true,visible=[];
 const controller=create({confirmedState:baseline(),clientId:'teacher',publish:action=>authority.commit(action),onError:e=>errors.push(e),paint:async view=>{if(fail)throw new Error('image preparation failed');visible=ids(view);return true;}});
 await controller.enqueue(add('kept')).settled;await assert.rejects(controller.whenPainted());assert.ok(errors.length);fail=false;controller.retryPaint();await controller.whenPainted();assert.deepEqual(visible,['kept']);controller.dispose();
});

test('snapshot installation can suspend projection without dropping pending intents',async()=>{
 const authority=server();let painted=0;const c=create({confirmedState:baseline(),clientId:'teacher',publish:a=>authority.commit(a),paint:async()=>{painted++;return true;}});
 assert.equal(typeof c.suspendProjection,'function','missing snapshot/projection coordination');c.suspendProjection();const h=c.enqueue(add('during-load'));await h.settled;await tick();assert.equal(painted,0);c.resumeProjection();await c.whenPainted();assert.ok(painted>0);c.dispose();
});

test('ordinary legacy-rendered commits can update session state without a second paint',async()=>{
 const authority=server();let painted=0;const c=create({confirmedState:baseline(),clientId:'teacher',publish:a=>authority.commit(a),paint:async()=>{painted++;return true;}});
 c.ack(authority.commit({actionId:'external',clientId:'student',ops:[{type:'upsert',object:{type:'Rect',boardObjectId:'ordinary'}}]}),{paint:false});await tick();assert.equal(painted,0);assert.equal(c.getState().revision,1);c.dispose();
});

test('accepted conflicting history is a consumed no-op rather than a rejected drawing intent', async () => {
  const controller = create({ clientId:'teacher', confirmedState:{revision:0,snapshot:{canvas:{objects:[]}}},
    paint:async()=>true, publish:async action=>({actionId:action.actionId,revision:0,accepted:true,changed:false,appliedOps:[],historyInverseOps:[],skippedConflicts:[{objectId:'gone',reason:'object_missing'}]}) });
  try { const handle=controller.enqueue({history:true,ops:[{type:'delete',id:'gone'}]});
    const result=await handle.settled;assert.equal(result.changed,false);assert.equal(controller.pendingCount(),0);
  } finally {controller.dispose();}
});

test('filling an ordinary revision gap still repaints the buffered notebook correction',async()=>{
 const paints=[];const controller=create({clientId:'teacher',confirmedState:baseline(),publish:async()=>new Promise(()=>{}),paint:async view=>{paints.push(view);return true;}});
 try {
  const handle=controller.enqueue(add('ink'));await controller.whenPainted();const before=paints.length;
  const corrected={...add('ink').ops[0],changes:[{...add('ink').ops[0].changes[0],object:{...add('ink').ops[0].changes[0].object,fill:'red'}}]};
  controller.ack({actionId:handle.actionId,clientId:'teacher',revision:2,ops:[corrected]});await controller.whenPainted();
  controller.ack({actionId:'outside',clientId:'other',revision:1,ops:[{type:'upsert',object:{type:'Rect',boardObjectId:'outside'}}]},{paint:false});
  await controller.whenPainted();assert.ok(paints.length>before);assert.equal(paints.at(-1).snapshot.canvas.objects[0].notebookPages[0][0].fill,'red');
 }finally{controller.dispose();}
});
