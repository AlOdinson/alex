import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as exporting from '../src/lib/exportBoard.js';
import { createStudentPeerSession } from '../src/lib/studentPeerSession.js';
const flush = async () => { for (let i=0;i<40;i++) await Promise.resolve(); };
const optional = async path => { try { return await import(path); } catch (e) { if(e.code==='ERR_MODULE_NOT_FOUND') return {}; throw e; } };
const scope = await optional('../src/lib/eraserScope.js');
const uploads = await optional('../src/lib/imageUploadQueue.js');

for (const [width,height] of [[1600,900],[20000,16000],[10000000,20]]) test(`export has bounded dimensions ${width}x${height}`, () => {
 assert.equal(typeof exporting.fitExportSize,'function');
 const size=exporting.fitExportSize(width,height,2);
 assert.ok(size.width>0&&size.height>0&&size.width<=4096&&size.height<=4096);
 assert.ok(size.width*size.height<=8_000_000);
 assert.ok(size.multiplier>0&&size.multiplier<=2);
});
test('non-finite export bounds produce a clear error',()=>{
 assert.equal(typeof exporting.fitExportSize,'function');
 for(const x of [NaN,Infinity,0,-1]) assert.throws(()=>exporting.fitExportSize(x,100),/размер|size/i);
});
test('empty JPEG output is rejected instead of producing an invalid PDF',()=>{
 assert.throws(()=>exporting.canvasToPdfBlob({width:100,height:100,toDataURL:()=> 'data:,'}),/JPEG|изображен|пуст|размер/i);
});
test('PNG null blob rejects explicitly',async()=>{
 await assert.rejects(exporting.canvasToPngBlob({toBlob:fn=>fn(null)}),/PNG/);
});
test('export does not clear a selection or resize the live canvas',()=>{
 const old=globalThis.document; const context={fillRect(){},save(){},restore(){},drawImage(){}};
 globalThis.document={createElement:()=>({width:0,height:0,getContext:()=>context})};
 const active={}; const viewport=[1,0,0,1,0,0];
 const canvas={getObjects:()=>[],getWidth:()=>100,getHeight:()=>100,viewportTransform:viewport,
  getActiveObject:()=>active,discardActiveObject(){assert.fail('export cleared selection');},
  setDimensions(){assert.fail('export resized the live canvas');},
  setViewportTransform(v){this.viewportTransform=v;},calcViewportBoundaries(){},requestRenderAll(){},
  toCanvasElement:()=>({width:200,height:200}),};
 try { const result=exporting.renderFabricCanvas(canvas,'blank');assert.equal(result.width,200);assert.equal(canvas.viewportTransform,viewport); }
 finally {globalThis.document=old;}
});

const ink={type:'Path'},photo={type:'Image'},pdf={type:'Image',mediaKind:'pdf'},screen={type:'Image',transientScreenShare:true};
test('eraser defaults to drawing and preserves photos PDF and screen share',()=>{
 assert.equal(typeof scope.eraserAllows,'function');assert.equal(scope.DEFAULT_ERASER_SCOPE,'drawing');
 assert.equal(scope.eraserAllows(ink),true);
 for(const item of [photo,pdf,screen]) assert.equal(scope.eraserAllows(item),false);
});
test('media eraser preserves all vector drawing and text',()=>{
 assert.equal(typeof scope.eraserAllows,'function');
 for(const item of [photo,pdf,screen]) assert.equal(scope.eraserAllows(item,'media'),true);
 for(const type of ['path','Line','rect','circle','Triangle','IText','Textbox']) assert.equal(scope.eraserAllows({type},'media'),false);
});
test('all eraser accepts drawing and media but never deletes temporary previews',()=>{
 assert.equal(typeof scope.eraserAllows,'function');
 for(const item of [ink,photo,pdf,screen]) assert.equal(scope.eraserAllows(item,'all'),true);
 assert.equal(scope.eraserAllows({...photo,transientPreview:true},'all'),false);
});
test('mixed groups are protected in category-specific modes',()=>{
 assert.equal(typeof scope.eraserAllows,'function');
 const group={type:'Group',objects:[ink,photo]};
 assert.equal(scope.eraserAllows(group,'drawing'),false);assert.equal(scope.eraserAllows(group,'media'),false);
 assert.equal(scope.eraserAllows(group,'all'),true);
});
test('actual eraser hit-test skips media to reach ink underneath',()=>{
 const source=readFileSync(new URL('../src/components/Board.jsx',import.meta.url),'utf8');
 const fn=source.slice(source.indexOf('    function preciseObjectEraserTarget('),source.indexOf('    function flushObjectEraserDeletePreview'));
 const canvas={getZoom:()=>1};const bounds={left:0,top:0,right:100,bottom:100,width:100,height:100};
 const image={...photo,canvas,getBoundingRect:()=>bounds}; const path={...ink,canvas,getBoundingRect:()=>bounds};
 const args={canvas,MIN_ZOOM:.05,Line:class{},Point:class{},util:{},clamp:(x,a,b)=>Math.max(a,Math.min(b,x)),finiteRect:x=>x,
  objectEraserRecordsRef:{current:new Map()},eraserScopeRef:{current:'drawing'},eraserAllows:scope.eraserAllows,
  isBoardNotebook:()=>false,renderedObjectIntersectsSceneRect:()=>true};
 const run=new Function(...Object.keys(args),`${fn};return preciseObjectEraserTarget;`)(...Object.values(args));
 assert.equal(run({x:20,y:20},{x:20,y:20},[image,path]),path);
});

test('queue retains remaining files while disconnected and resumes in order',async()=>{
 assert.equal(typeof uploads.createImageUploadQueue,'function');
 let ready=true;const sent=[];let attempts=0;
 const q=uploads.createImageUploadQueue({isReady:()=>ready,onChange(){},retryDelayMs:0});
 q.add([{id:'a',name:'one'},{id:'b',name:'two'},{id:'c',name:'three'}],async job=>{
   if(job.id==='b'&&attempts++===0){ready=false;throw new Error('peer connection closed');}sent.push(job.id);
 });
 await flush();assert.deepEqual(sent,['a']);assert.equal(q.snapshot().find(x=>x.id==='b').status,'waiting');
 ready=true;q.resume();await flush();assert.deepEqual(sent,['a','b','c']);q.close();
});
test('queue retry reuses the same job, action ID and bytes',async()=>{
 assert.equal(typeof uploads.createImageUploadQueue,'function');let attempt=0,first;
 const q=uploads.createImageUploadQueue({isReady:()=>true,onChange(){},retryDelayMs:0});
 q.add([{id:'x',name:'x',actionId:'stable',records:[{src:'same'}]}],async job=>{
  if(!first)first=job;assert.equal(job,first);assert.equal(job.actionId,'stable');assert.equal(job.records[0].src,'same');
  if(attempt++===0)throw new Error('invalid file');
 });
 await flush();assert.equal(q.snapshot()[0].status,'failed');q.retry('x');await flush();assert.equal(q.snapshot()[0].status,'done');q.close();
});
test('one corrupt file does not prevent later files from loading',async()=>{
 assert.equal(typeof uploads.createImageUploadQueue,'function');const sent=[];
 const q=uploads.createImageUploadQueue({isReady:()=>true});
 q.add([{id:'bad',name:'bad'},{id:'good',name:'good'}],async job=>{if(job.id==='bad')throw new Error('invalid image');sent.push(job.id);});
 await flush();assert.deepEqual(sent,['good']);assert.equal(q.snapshot()[0].status,'failed');q.close();
});
test('closing a queue stops the remainder and prevents retries',async()=>{
 assert.equal(typeof uploads.createImageUploadQueue,'function');let finish;const sent=[];
 const q=uploads.createImageUploadQueue({isReady:()=>true});
 q.add([{id:'a',name:'a'},{id:'b',name:'b'}],async job=>{sent.push(job.id);await new Promise(r=>finish=r);});
 await flush();q.close();finish();await flush();q.resume();q.retry('a');assert.deepEqual(sent,['a']);
});
test('upload queue serializes overlapping batches',async()=>{
 assert.equal(typeof uploads.createImageUploadQueue,'function');let active=0,max=0;const sent=[];
 const q=uploads.createImageUploadQueue({isReady:()=>true});
 const process=async job=>{max=Math.max(max,++active);await Promise.resolve();sent.push(job.id);active--;};
 q.add([{id:'a',name:'a'},{id:'b',name:'b'}],process);q.add([{id:'c',name:'c'}],process);
 await flush();assert.equal(max,1);assert.deepEqual(sent,['a','b','c']);q.close();
});
test('student action exposes transmission completion separately from its acknowledgement',async()=>{
 let finishSend;
 const session=createStudentPeerSession({transport:{send:()=>new Promise(r=>finishSend=r)},getRevision:()=>0,applyCommit:async()=>{},installSnapshot:async()=>{}});
 const action=session.proposeActionAndWait({actionId:'image',ops:[]});
 assert.ok(action.sent&&typeof action.sent.then==='function','missing transmission completion promise');
 let sent=false,acked=false;action.sent.then(()=>sent=true);action.then(()=>acked=true);
 await flush();assert.equal(sent,false);finishSend();await flush();assert.equal(sent,true);assert.equal(acked,false);
 await session.handleMessage({type:'ack',payload:{actionId:'image',accepted:true,revision:1}});await action;session.close();
});
test('visible export error and retry panels are wired into the real board',()=>{
 const source=readFileSync(new URL('../src/components/Board.jsx',import.meta.url),'utf8');
 assert.ok(source.includes('BoardOperationStatus'));assert.ok(source.includes('uploadQueueRef'));assert.ok(source.includes('EraserScopePicker'));
});
test('eraser categories do not change eyedropper targets',()=>{
 const source=readFileSync(new URL('../src/components/Board.jsx',import.meta.url),'utf8');
 const body=source.slice(source.indexOf('    function preciseEyedropperTarget('),source.indexOf('    function preciseObjectEraserTarget('));
 assert.equal(body.includes('eraserAllows('),false);
});
test('screen removal requests require editing permission and the active host session',async()=>{
 const api=await import('../src/lib/screenShare.js');assert.equal(typeof api.canRemoveScreenShare,'function');
 const session={sessionId:'current',hostId:'host',sourceMode:'screen'};
 assert.equal(api.canRemoveScreenShare({type:'screen-remove',sessionId:'current',permission:'edit'},session,'host'),true);
 for(const signal of [{type:'screen-remove',sessionId:'old',permission:'owner'},{type:'screen-remove',sessionId:'current',permission:'view'}])assert.equal(api.canRemoveScreenShare(signal,session,'host'),false);
 assert.equal(api.canRemoveScreenShare({type:'screen-remove',sessionId:'current',permission:'edit'},session,'viewer'),false);
});

test('acknowledgement deadline starts after a slow proposal is sent',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const {createStudentPeerNetwork}=await import('../src/lib/studentPeerNetwork.js');
 let sent,ack;const task=new Promise(resolve=>ack=resolve);task.sent=new Promise(resolve=>sent=resolve);
 const network=createStudentPeerNetwork({teacherId:'teacher',signaling:{send:async()=>{}},getRevision:()=>0,applyCommit:async()=>{},installSnapshot:async()=>{},requestTimeoutMs:100,
  createPair:options=>({start:async()=>{options.onSelectedChannel({},'owner-initiated');},close(){}}),
  createTransport:()=>({send:async()=>{},close(){}}),
  createSession:()=>({start:async()=>{},proposeActionAndWait:()=>task,close(){}})});
 t.after(()=>network.close());await network.start();let failure;
 const result=network.proposeActionAndWait({actionId:'slow'}).catch(error=>{failure=error;});
 await flush();t.mock.timers.tick(1000);await flush();assert.equal(failure,undefined);assert.equal(network.isReady(),true);
 sent();await flush();t.mock.timers.tick(50);ack({accepted:true});await result;assert.equal(failure,undefined);
});

test('unconfirmed uploads cannot be erased or undone as completed history', () => {
  assert.equal(scope.eraserAllows({ ...photo, pendingUpload: true }, 'all'), false);
  const source = readFileSync(new URL('../src/components/Board.jsx', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('  const addImageFiles ='), source.indexOf('  const screenshotViewportPoint ='));
  assert.ok(body.indexOf('historyAction.pendingUpload =') < body.indexOf('await publishBoardImage('));
  assert.match(body, /if \(!job\.historyRecorded\) \{\s+const index = undoStackRef\.current\.indexOf\(historyAction\)/);
});

test('eraser UI cannot bypass category protection through legacy partial mode',()=>{
 const source=readFileSync(new URL('../src/components/Toolbar.jsx',import.meta.url),'utf8');
 assert.equal(source.includes("setEraserMode('partial')"),false);
});
