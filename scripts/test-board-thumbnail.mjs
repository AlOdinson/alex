import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { captureBoardThumbnail, installBoardThumbnail } from '../src/lib/boardThumbnail.js';
import { createCanvas, loadImage } from 'canvas';
import { Rect, Group, StaticCanvas } from 'fabric/node';
const image = 'data:image/jpeg;base64,test';
const settle = () => new Promise(resolve => setImmediate(resolve));
function preview() { return { getContext:()=>({fillRect(){},drawImage(){},save(){},restore(){},scale(){},transform(){}}), toDataURL:()=>image }; }
function harness({ objects = [], create = preview, save, canvas: suppliedCanvas } = {}) {
  const win = new EventTarget(), doc = new EventTarget(), timers = new Map(), idle = new Map(), listeners = new Map();
  let id = 0, captures = 0, scans = 0;
  const writes = [];
  doc.createElement = () => { captures++; return create(); };
  globalThis.document = doc; // Legacy capture reads the DOM globally; exercise its real path during RED.
  win.setTimeout = (fn, delay) => { timers.set(++id, { fn, delay }); return id; };
  win.clearTimeout = id => timers.delete(id);
  win.requestIdleCallback = fn => { idle.set(++id, fn); return id; };
  win.cancelIdleCallback = id => idle.delete(id);
  win.location = { href:'https://example.test/alex/board/lesson?key=x', assign:url=>visited.push(url) };
  const visited = [];
  const canvas = suppliedCanvas ?? {
    lowerCanvasEl:{width:800,height:600}, viewportTransform:[1,0,0,1,0,0],
    getWidth:()=>800, getHeight:()=>600, getObjects:()=>{ scans++; return objects; },
    on:(name, fn)=>{ if(!listeners.has(name))listeners.set(name,new Set()); listeners.get(name).add(fn); },
    off:(name,fn)=>listeners.get(name)?.delete(fn),
  };
  const fire = (name, payload={}) => { if(suppliedCanvas)canvas.fire(name,payload);else for(const fn of listeners.get(name)??[])fn(payload); };
  const runTimers = () => { const current=[...timers]; timers.clear(); for(const [,{fn}] of current)fn(); };
  const runIdle = () => { const current=[...idle]; idle.clear(); for(const [,fn] of current)fn({timeRemaining:()=>50}); };
  const advance = ms => { for(const [id,entry] of [...timers]) { entry.delay -= ms; if(entry.delay<=0) {timers.delete(id);entry.fn();} } };
  const input = (name, props={}) => { const event=new Event(name);Object.assign(event,props);win.dispatchEvent(event); };
  const dispose = installBoardThumbnail({canvas,window:win,document:doc,save:value=>{writes.push(value);return save?.(value);}});
  return {win,doc,canvas,fire,runTimers,runIdle,advance,input,dispose,writes,timers,idle,listeners,visited,get captures(){return captures;},get scans(){return scans;}};
}
async function quiet(h) { h.runTimers(); h.runIdle(); await settle(); }
function home(h) {
  const event=new Event('click',{cancelable:true});
  Object.defineProperties(event,{button:{value:0},target:{value:{closest:()=>({href:'https://example.test/alex/',hasAttribute:()=>false})}}});
  h.win.dispatchEvent(event);return event;
}

test('thumbnail is bounded and failed/tainted captures are optional',()=>{
  const output=preview();
  assert.equal(captureBoardThumbnail({width:2000,height:1000},()=>output),image);
  assert.equal(output.width,1600); assert.equal(output.height,800);
  assert.equal(captureBoardThumbnail({width:0,height:0}),null);
  assert.equal(captureBoardThumbnail({width:10,height:10},()=>{throw Error('tainted');}),null);
  assert.equal(captureBoardThumbnail({width:10,height:10},()=>({...preview(),toDataURL:()=>image+'x'.repeat(1500000)})),null);
});
test('video-only after:render never scans content or schedules another capture',async()=>{
  const h=harness();await quiet(h);const scans=h.scans,captures=h.captures;
  for(let i=0;i<1000;i++)h.fire('after:render');
  assert.equal(h.timers.size,0);assert.equal(h.idle.size,0);assert.equal(h.scans,scans);assert.equal(h.captures,captures);
  h.dispose();
});
test('object changes coalesce until quiet and viewport fallback notices pan',async()=>{
  const h=harness();await quiet(h);
  for(let i=0;i<100;i++)h.fire('object:modified',{target:{}});
  assert.equal(h.captures,1);assert.equal(h.timers.size,1);h.runTimers();assert.equal(h.captures,1);
  h.runIdle();await settle();assert.equal(h.captures,2);
  h.canvas.viewportTransform[4]=40;h.fire('after:render');await quiet(h);assert.equal(h.captures,3);h.dispose();
});
test('content bursts wait for a quiet interval rather than capturing mid-burst',async()=>{
  const h=harness();h.advance(400);h.fire('object:modified',{target:{}});h.advance(100);h.runIdle();await settle();
  assert.equal(h.captures,0);h.advance(400);h.runIdle();await settle();assert.equal(h.captures,1);h.dispose();
});
test('Fabric group children and text edits are observed; render-only state is ignored',async()=>{
  const child=new Rect({width:20,height:20}),group=new Group([child]);
  const h=harness({objects:[group]});await quiet(h);child.set('fill','#123456');await quiet(h);assert.equal(h.captures,2);
  group.set('dirty',false);child.set('dirty',false);group.set('canvas',null);h.fire('after:render');assert.equal(h.timers.size,0);
  h.fire('text:changed',{target:child});await quiet(h);assert.equal(h.captures,3);h.dispose();
});
test('blur recovers lost contacts and rejected writes remain retryable',async()=>{
  let reject=true;const h=harness({save:()=>{if(reject)throw Error('storage');}});
  h.input('pointerdown',{pointerId:1});await quiet(h);assert.equal(h.captures,0);
  h.input('blur');await quiet(h);assert.equal(h.writes.length,1);assert.equal(h.timers.size,0);
  reject=false;h.win.dispatchEvent(new Event('pagehide'));await settle();assert.equal(h.writes.length,2);h.dispose();
});
test('actual Fabric object.set edits update the preview without object:modified',async()=>{
  const object=new Rect({width:20,height:20,fill:'#ff0000'}), original=object._set;
  const h=harness({objects:[object]});await quiet(h);object.set('fill','#0000ff');h.fire('after:render');
  assert.equal(h.timers.size,1);await quiet(h);assert.equal(h.captures,2);
  const scans=h.scans;object.set('selectable',false);for(let i=0;i<50;i++)h.fire('after:render');
  assert.equal(h.timers.size,0);assert.equal(h.scans,scans);h.dispose();assert.equal(object._set,original);
});
test('new Fabric objects are observed and removed objects release mutation observers',async()=>{
  const objects=[],h=harness({objects});await quiet(h);
  const object=new Rect({width:20,height:20}),original=object._set;objects.push(object);h.fire('object:added',{target:object});await quiet(h);
  object.set({left:20,top:30});await quiet(h);assert.equal(h.captures,3);
  objects.pop();h.fire('object:removed',{target:object});await quiet(h);assert.equal(object._set,original);
  object.set('left',50);assert.equal(h.timers.size,0);h.dispose();
});
test('pointer and touch held defer captures; actual final release schedules work',async()=>{
  const h=harness();h.input('pointerdown',{pointerId:1});h.input('touchstart',{touches:[{}]});await quiet(h);
  assert.equal(h.captures,0);h.input('pointerup',{pointerId:1});await quiet(h);assert.equal(h.captures,0);
  h.input('touchend',{touches:[]});await quiet(h);assert.equal(h.captures,1);
  h.input('pointerdown',{pointerId:2});h.fire('object:modified',{target:{}});h.input('pointercancel',{pointerId:2});await quiet(h);
  assert.equal(h.captures,2);h.dispose();
});
test('pointer release schedules after Fabric finishes its transform later in the event',async()=>{
  const h=harness();h.input('pointerdown',{pointerId:1});h.canvas._currentTransform={target:{}};
  h.input('pointerup',{pointerId:1});h.canvas._currentTransform=null;await quiet(h);assert.equal(h.captures,1);h.dispose();
});
test('screen-share objects neither dirty nor render into the preview',async()=>{
  const screen=new Rect({width:100,height:100,fill:'#ff0000'});screen.screenShareSessionId='session';screen.excludeFromExport=true;
  let rendered=0;screen.render=()=>rendered++;
  const h=harness({objects:[screen]});await quiet(h);assert.equal(rendered,0);
  h.fire('object:modified',{target:screen});screen.set('left',10);h.fire('after:render');
  assert.equal(h.timers.size,0);h.dispose();
});
test('async JPEG encoding paints once while retrying quality and never calls toDataURL',async()=>{
  let draws=0, encodes=0;
  const h=harness({objects:[{render(){draws++;}}],create:()=>({...preview(),toDataURL(){throw Error('sync encoding forbidden');},toBlob(callback,type,quality){encodes++;assert.equal(type,'image/jpeg');assert.equal(quality,encodes===1?0.92:0.82);callback(new Blob([encodes===1?'x'.repeat(1200000):'jpeg'],{type}));}})});
  await quiet(h);await settle();assert.equal(draws,1);assert.equal(encodes,2);assert.equal(h.writes.length,1);h.dispose();
});
test('leaving captures latest frame while encode awaits and serializes capture/save',async()=>{
  let frame='A';const encodes=[],complete=[],writes=[];
  const h=harness({create:()=>{const content=frame;return {...preview(),toBlob:callback=>{encodes.push(content);complete.push(()=>callback(new Blob([content],{type:'image/jpeg'})));}};},save:value=>writes.push(value)});
  await quiet(h);assert.deepEqual(encodes,['A']);
  frame='B';h.fire('object:modified',{target:{}});h.win.dispatchEvent(new Event('pagehide'));
  frame='C';h.fire('object:modified',{target:{}});h.dispose();assert.equal(h.captures,3);assert.deepEqual(encodes,['A']);
  complete.shift()();await settle();assert.deepEqual(encodes,['A','C']);complete.shift()();await settle();
  assert.deepEqual(writes,['data:image/jpeg;base64,QQ==','data:image/jpeg;base64,Qw==']);assert.equal(h.timers.size,0);assert.equal(h.idle.size,0);
});
test('saved frame A following pending save B is saved again, with only one write active',async()=>{
  let frame=image+'A';const complete=[];
  const h=harness({create:()=>({...preview(),toDataURL:()=>frame}),save:()=>new Promise(resolve=>complete.push(resolve))});
  h.win.dispatchEvent(new Event('pagehide'));await settle();complete.shift()(true);await settle();
  frame=image+'B';h.fire('object:modified',{target:{}});h.win.dispatchEvent(new Event('pagehide'));await settle();
  frame=image+'A';h.fire('object:modified',{target:{}});h.win.dispatchEvent(new Event('pagehide'));await settle();assert.deepEqual(h.writes,[image+'A',image+'B']);
  complete.shift()(true);await settle();assert.deepEqual(h.writes,[image+'A',image+'B',image+'A']);complete.shift()(true);await settle();h.dispose();
});
test('flush at the final save completion boundary cannot strand a newer frame',async()=>{
  let frame=image+'A',finish;const first=new Promise(resolve=>{finish=resolve;});
  const h=harness({create:()=>({...preview(),toDataURL:()=>frame}),save:()=>h.writes.length===1?first:true});
  h.win.dispatchEvent(new Event('pagehide'));await settle();
  first.then(()=>{frame=image+'B';h.fire('object:modified',{target:{}});h.win.dispatchEvent(new Event('pagehide'));});
  finish(true);await settle();assert.deepEqual(h.writes,[image+'A',image+'B']);h.dispose();
});
test('returning Home waits for latest thumbnail commit before navigation',async()=>{
  const complete=[],h=harness({save:()=>new Promise(resolve=>complete.push(resolve))});
  const event=home(h);assert.equal(event.defaultPrevented,true);assert.deepEqual(h.visited,[]);await settle();
  complete.shift()(true);await settle();assert.deepEqual(h.visited,['https://example.test/alex/']);h.dispose();assert.equal(h.timers.size,0);
});
test('navigation is bounded when encoding never returns, disposal removes listeners and idle jobs',async()=>{
  const h=harness({create:()=>({...preview(),toBlob(){}})});h.runTimers();assert.equal(h.idle.size,1);
  home(h);h.runTimers();await settle();assert.deepEqual(h.visited,['https://example.test/alex/']);h.dispose();
  assert.equal(h.idle.size,0);assert.equal(h.timers.size,0);assert.ok([...h.listeners.values()].every(set=>set.size===0));
  for(const name of ['click','pagehide','pointerdown','pointerup','pointercancel','touchstart','touchend','touchcancel','blur'])assert.equal(getEventListeners(h.win,name).length,0,name);
  assert.equal(getEventListeners(h.doc,'visibilitychange').length,0);
  h.input('pointerdown',{pointerId:1});h.input('pointerup',{pointerId:1});assert.equal(h.timers.size,0);
});
test('failed write remains dirty for next explicit flush without an unbounded retry loop',async()=>{
  const h=harness({save:()=>false});h.win.dispatchEvent(new Event('pagehide'));await settle();assert.equal(h.writes.length,1);
  h.win.dispatchEvent(new Event('pagehide'));await settle();assert.equal(h.writes.length,2);h.dispose();await settle();
});
test('real encoded JPEG is sharp, white under erasure, excludes live media and preserves viewport',async()=>{
  const object=new Rect({originX:'left',originY:'top',left:0,top:0,width:200,height:100,fill:'#ff0000',strokeWidth:0});
  const actual=new StaticCanvas(null,{width:800,height:600,renderOnAddRemove:false});actual.add(object);
  const screen=new Rect({left:0,top:0,width:800,height:600,fill:'#000000',strokeWidth:0});screen.screenShareSessionId='s';
  let renders=0;const eraser={render(ctx){renders++;ctx.globalCompositeOperation='destination-out';ctx.fillRect(20,20,30,30);ctx.globalCompositeOperation='source-over';}};
  const h=harness({objects:[object,eraser,screen],create:()=>{const out=createCanvas(1,1);out.toBlob=(callback,type,quality)=>callback(new Blob([out.toBuffer(type,{quality})],{type}));return out;}});
  h.canvas.viewportTransform[4]=100;await quiet(h);assert.equal(renders,1);assert.equal(h.writes.length,1);
  const decoded=await loadImage(h.writes[0]);assert.equal(decoded.width,800);assert.equal(decoded.height,600);
  const output=createCanvas(800,600),ctx=output.getContext('2d');ctx.drawImage(decoded,0,0);
  const pixel=(x,y)=>[...ctx.getImageData(x,y,1,1).data];
  assert.ok(pixel(130,30).slice(0,3).every(channel=>channel>=250));assert.equal(pixel(130,30)[3],255);assert.deepEqual(pixel(10,10),[255,255,255,255]);
  const red=pixel(170,50);assert.ok(red[0]>240&&red[1]<15&&red[2]<15);assert.ok(pixel(102,50)[0]>240&&pixel(102,50)[1]<15);h.dispose();await actual.dispose();
});
for (const grouped of [false,true]) test(`real Fabric ${grouped?'group':'canvas'} reorder refreshes pixels and latest exit order while save awaits`,async()=>{
  const actual=new StaticCanvas(null,{width:96,height:96,enableRetinaScaling:false,renderOnAddRemove:false});
  const red=new Rect({originX:'left',originY:'top',left:0,top:0,width:64,height:64,fill:'#ff0000',strokeWidth:0});
  const blue=new Rect({originX:'left',originY:'top',left:0,top:0,width:64,height:64,fill:'#0000ff',strokeWidth:0});
  const collection=grouped?new Group([red,blue],{originX:'left',originY:'top',left:0,top:0}):actual;
  if(grouped)actual.add(collection);else actual.add(red,blue);
  const nativeStack=collection._onStackOrderChanged,nativeMove=collection.moveObjectTo;
  let stackCalls=0,moveCalls=0,complete;
  const priorStack=function(...args){stackCalls++;return nativeStack.apply(this,args);};
  const boardMove=function(...args){moveCalls++;return nativeMove.apply(this,args);};
  collection._onStackOrderChanged=priorStack;collection.moveObjectTo=boardMove;
  const h=harness({canvas:actual,create:()=>{const output=createCanvas(1,1);output.toBlob=(callback,type,quality)=>callback(new Blob([output.toBuffer(type,{quality})],{type}));return output;},save:()=>h.writes.length===2?new Promise(resolve=>{complete=resolve;}):true});
  try {
    await quiet(h);assert.equal(h.writes.length,1);
    assert.equal(collection.moveObjectTo(red,1),true);actual.requestRenderAll();actual.renderAll();
    assert.equal(h.timers.size,1,'a real order change must schedule a thumbnail');assert.equal(collection.moveObjectTo,boardMove);
    await quiet(h);assert.equal(h.writes.length,2);assert.equal(moveCalls,1);assert.equal(stackCalls,1);
    assert.equal(collection.sendObjectToBack(red),true);actual.renderAll();h.dispose();
    assert.equal(collection._onStackOrderChanged,priorStack);assert.equal(collection.moveObjectTo,boardMove);
    actual.clear();complete(true);await settle();assert.equal(h.writes.length,3);
    const colors=[];
    for(const value of h.writes){const decoded=await loadImage(value),out=createCanvas(96,96),ctx=out.getContext('2d');ctx.drawImage(decoded,0,0);const pixel=ctx.getImageData(32,32,1,1).data;colors.push(pixel[0]>240?'red':pixel[2]>240?'blue':'other');}
    assert.deepEqual(colors,['blue','red','blue']);assert.equal(h.timers.size,0);assert.equal(h.idle.size,0);
  } finally {h.dispose();await actual.dispose();}
});
test('blocked preview storage remains optional',async()=>{
  const {readBoardThumbnail,saveBoardThumbnail}=await import('../src/lib/boardThumbnailStore.js');
  assert.equal(await readBoardThumbnail('missing'),null);assert.equal(await saveBoardThumbnail('missing',image),false);
});
