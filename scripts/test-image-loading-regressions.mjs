import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadImageElement } from '../src/lib/imageStorage.js';
const flush = async () => { for(let i=0;i<20;i++) await Promise.resolve(); };
function observe(task) { const state = { status: 'pending' }; task.then(value => Object.assign(state,{ status:'fulfilled',value }),error => Object.assign(state,{ status:'rejected',error })); return state; }

test('an image load event cannot wait forever on optional browser decode()', async (t) => {
  const previous = globalThis.Image;
  globalThis.Image = class { naturalWidth=80; naturalHeight=40; complete=true; decode() { return new Promise(()=>{}); } set src(value) { queueMicrotask(()=>this.onload?.()); } };
  t.after(()=>{ globalThis.Image=previous; });
  const outcome=observe(loadImageElement('data:image/png;base64,fixture',{ retries:0, timeoutMs:50 }));
  await flush();
  assert.equal(outcome.status,'fulfilled');
});

test('a silent browser image request times out and releases its handlers', async (t) => {
  t.mock.timers.enable({apis:['setTimeout']});
  const previous=globalThis.Image; let image;
  globalThis.Image=class { constructor(){image=this;} set src(value) {} };
  t.after(()=>{globalThis.Image=previous;});
  const outcome=observe(loadImageElement('data:image/png;base64,fixture',{retries:0,timeoutMs:50}));
  await flush(); t.mock.timers.tick(51); await flush();
  assert.equal(outcome.status,'rejected');
  assert.match(outcome.error.message,/время|timed out/i);
  assert.equal(image.onload,null); assert.equal(image.onerror,null);
});

test('closing a board cancels an image request without a load event', async (t) => {
  const previous=globalThis.Image;
  globalThis.Image=class { set src(value){} };
  t.after(()=>{globalThis.Image=previous;});
  const controller=new AbortController();
  const outcome=observe(loadImageElement('data:image/png;base64,fixture',{retries:0,signal:controller.signal}));
  controller.abort(); await flush();
  assert.equal(outcome.status,'rejected'); assert.equal(outcome.error.name,'AbortError');
});

// Execute the actual production callback with a small Canvas model. This reproduces
// a delayed hydration being overtaken by snapshot replacement or by a local edit.
function hydrationFixture() {
 const source=readFileSync(new URL('../src/components/Board.jsx',import.meta.url),'utf8');
 const body=source.split('const retryPendingServerImages = useCallback(async () => {')[1].split('\n  }, [')[0];
 const placeholder={boardObjectId:'image',pendingImage:true,pendingImageSerialized:{type:'Image',src:'old',boardObjectId:'image'}};
 const canvas={objects:[placeholder],getObjects(){return this.objects;},remove(o){this.objects=this.objects.filter(x=>x!==o);},add(o){this.objects.push(o);},moveObjectTo(){},requestRenderAll(){}};
 const fiber={current:canvas}; let unblock;
 const loaded=new Promise(resolve=>{unblock=resolve;}); const edits=new Set();
 const args={pendingImageRetryInFlightRef:{current:false}, fabricCanvasRef:fiber, getLocalMutationIds:()=>edits,
  preloadSerializedImages:()=>loaded, enlivenImageAwareObjects:async()=>{await loaded;return [{boardObjectId:'image',setCoords(){},dispose(){}}];},
  boardObjectsById:(c,id)=>c.getObjects().filter(o=>o.boardObjectId===id), applyingRemoteRef:{current:false},
  serializedObjectCacheRef:{current:new WeakMap()},clamp:(x)=>x,applyObjectInteractivity(){}};
 const invoke=new Function(...Object.keys(args),`return (async()=>{${body}\n})();`);
 return {canvas,placeholder,edits,fiber,unblock,run:()=>invoke(...Object.values(args))};
}
for(const scenario of ['replaced','local-edit','board-closed']) test(`delayed image hydration cannot overwrite ${scenario}`, async()=>{
 const f=hydrationFixture(); const task=f.run(); await flush();
 let expected=f.placeholder;
 if(scenario==='replaced') { expected={...f.placeholder,pendingImageSerialized:{type:'Image',src:'new',boardObjectId:'image'}}; f.canvas.objects=[expected]; }
 if(scenario==='local-edit') f.edits.add('image');
 if(scenario==='board-closed') f.fiber.current=null;
 f.unblock(); await task;
 assert.equal(f.canvas.objects[0],expected,'old decoded bytes must not replace the current state');
});

test('image preparation for an authoritative commit does not await decoding',()=>{
 const source=readFileSync(new URL('../src/components/Board.jsx',import.meta.url),'utf8');
 const section=source.slice(source.indexOf('  const applyRemoteOps ='),source.indexOf('  applyRemoteOpsRef.current = applyRemoteOps;'));
 assert.match(section,/partitionImageRevival\(reviveEntries, preparedOps\)/);
 assert.match(section,/retryPendingServerImages\(\)/);
});

test('Fabric image deserialization is aborted on timeout and late objects are disposed', async (t)=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const {enlivenBoardObjects}=await import('../src/lib/imageStorage.js');
 let signal,finish,disposed=false;
 const outcome=observe(enlivenBoardObjects((_objects,options)=>{signal=options.signal;return new Promise(resolve=>{finish=resolve;});},[{type:'Image',src:'data:image/png;base64,fixture'}],{timeoutMs:50}));
 await flush();t.mock.timers.tick(51);await flush();
 assert.equal(outcome.status,'rejected'); assert.equal(signal.aborted,true);
 finish([{dispose(){disposed=true;}}]);await flush();assert.equal(disposed,true);
});

test('successful Fabric images retain their entire serialized source and do not trigger abort', async()=>{
 const {enlivenBoardObjects}=await import('../src/lib/imageStorage.js');
 const serialized=[{type:'Image',src:'data:image/png;base64,fixture'}];let signal;
 const expected={image:true};
 const result=await enlivenBoardObjects((objects,options)=>{assert.equal(objects,serialized);signal=options.signal;return Promise.resolve([expected]);},serialized);
 assert.deepEqual(result,[expected]);assert.equal(signal.aborted,false);
});

test('ordinary vector drawing is not subject to an image timeout',async()=>{
 const {enlivenBoardObjects}=await import('../src/lib/imageStorage.js');
 await enlivenBoardObjects((_objects,options)=>{assert.equal(options,undefined);return Promise.resolve([]);},[{type:'Path',path:[]}]);
});

test('clipboard image files use the same durable insertion path before text or internal clipboard',()=>{
 const source=readFileSync(new URL('../src/components/Board.jsx',import.meta.url),'utf8');
 const body=source.split('    function handlePaste(event) {')[1].split('\n    function ')[0];
 assert.match(body,/droppedFilesFromDataTransfer\(event.clipboardData\).filter\(isAcceptedImageFile\)/);
 assert.ok(body.indexOf('addImageFiles(imageFiles')<body.indexOf('if (internalClipboardArmedRef'));
});

test('image history is recorded before awaiting acknowledgement and accepted results use array shape',()=>{
 const source=readFileSync(new URL('../src/components/Board.jsx',import.meta.url),'utf8');
 const body=source.split('  const addImageFiles = useCallback(')[1].split('  const mutateSelection')[0];
 assert.ok(body.indexOf("recordAction({ type: 'add', records })")<body.indexOf('await publishBoardImage('));
 assert.match(body,/committedResults\?\.at\(-1\)/);
});

test('uncertain image publication retries the identical immutable action without losing bytes',async()=>{
 const {publishBoardImage}=await import('../src/lib/imageStorage.js');
 assert.equal(typeof publishBoardImage,'function');
 let attempts=0;
 const source='data:image/png;base64,ABCDE';
 const publish=async()=>{attempts++;if(attempts===1)throw new Error('Teacher peer data channel closed');return [{accepted:true,appliedOps:[{object:{src:source}}],revision:5}];};
 const result=await publishBoardImage(publish,{delay:async()=>{}});
 assert.equal(attempts,2);assert.equal(result[0].appliedOps[0].object.src,source);
});

test('a negative image acknowledgement is not reported as a successful insertion or retried',async()=>{
 const {publishBoardImage}=await import('../src/lib/imageStorage.js');
 assert.equal(typeof publishBoardImage,'function');let attempts=0;
 await assert.rejects(publishBoardImage(async()=>{attempts++;return [{accepted:false,error:'Board is view-only'}];},{delay:async()=>{}}),/view-only/);
 assert.equal(attempts,1);
});

test('image publication retries are bounded and stop when the board is closed',async()=>{
 const {publishBoardImage}=await import('../src/lib/imageStorage.js');
 assert.equal(typeof publishBoardImage,'function');let attempts=0;
 await assert.rejects(publishBoardImage(async()=>{attempts++;throw new Error('network connection closed');},{delay:async()=>{}}),/closed/);
 assert.equal(attempts,3);
 attempts=0;
 await assert.rejects(publishBoardImage(async()=>{attempts++;throw new Error('network connection closed');},{delay:async()=>{},isActive:()=>attempts===0}),/отменена/);
 assert.equal(attempts,1);
});

test('copying a loading image serializes its real bytes, not the visual loading card',()=>{
 const source=readFileSync(new URL('../src/components/Board.jsx',import.meta.url),'utf8');
 const body=source.split('function serializeObject(object) {')[1].split('\n}\n')[0];
 const payload={type:'Image',src:'data:image/png;base64,bytes',width:400,height:300,scaleX:1,boardObjectId:'image'};
 const placeholder={pendingImage:true,pendingImageSerialized:payload,toObject:()=>({type:'Group',objects:[]})};
 const serialize=new Function('object','patchSerializedObjectTransform',body);
 const actual=serialize(placeholder,(value)=>value);
 assert.deepEqual(actual,payload);assert.notEqual(actual,payload);
});
