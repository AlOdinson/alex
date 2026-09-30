import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Canvas, Path, getEnv } from 'fabric/node';
import { setEnv } from 'fabric';
import { createBoardScreenShareMedia } from '../src/lib/boardScreenShare.js';
setEnv(getEnv());
function fixture({callback=true}={}) {
  const nativeWindow=getEnv().window,nativeDoc=getEnv().document,doc=new EventTarget(),win=new EventTarget();
  doc.hidden=false;
  let video,frame,copyCount=0,nextId=0;
  const frames=new Map(),intervals=new Map();
  doc.createElement=type=>{
    const element=nativeDoc.createElement(type==='video'?'canvas':type);
    if(type==='video') {
      video=element;video.width=1920;video.height=1080;
      Object.assign(video,{videoWidth:1920,videoHeight:1080,readyState:2,play:()=>Promise.resolve(),pause:()=>{}});
      if(callback){video.requestVideoFrameCallback=fn=>{frames.set(++nextId,fn);return nextId;};video.cancelVideoFrameCallback=id=>frames.delete(id);}
    } else if(type==='canvas'&&!frame) { /* placeholder is the first canvas */ frame=element; }
    return element;
  };
  const nativeRAF=nativeWindow.requestAnimationFrame,nativeCancelRAF=nativeWindow.cancelAnimationFrame;
  nativeWindow.requestAnimationFrame=()=>++nextId;nativeWindow.cancelAnimationFrame=()=>{};
  const old={document:globalThis.document,window:globalThis.window,setInterval:globalThis.setInterval,clearInterval:globalThis.clearInterval};
  globalThis.document=doc;globalThis.window=win;
  globalThis.setInterval=(fn,ms)=>{intervals.set(++nextId,{fn,ms});return nextId;};globalThis.clearInterval=id=>intervals.delete(id);
  const media=createBoardScreenShareMedia({layout:{left:20,top:20,width:80,height:45},canEdit:true});
  const canvas=new Canvas(null,{width:160,height:120,renderOnAddRemove:false});
  let pathRenders=0,coords=0;
  const path=new Path('M 0 0 L 100 100 L 0 100 z',{fill:'#ff0055',objectCaching:false});
  const render=path._render;path._render=function(...args){pathRenders++;return render.apply(this,args);};
  const setCoords=media.object.setCoords;media.object.setCoords=function(...args){coords++;return setCoords.apply(this,args);};
  const context=media.frameCanvas.getContext('2d'),draw=context.drawImage;
  context.drawImage=function(...args){if(args[0]===video)copyCount++;return draw.apply(this,args);};
  canvas.add(path,media.object);
  const paint=color=>{const ctx=video.getContext('2d');ctx.fillStyle=color;ctx.fillRect(0,0,video.width,video.height);};
  const tick=()=>{if(callback){const [id,fn]=frames.entries().next().value;frames.delete(id);fn();}else{for(const {fn} of intervals.values())fn();}};
  const full=()=>{canvas.cancelRequestedRender();canvas.renderAll();};
  const close=async()=>{media.dispose();canvas.cancelRequestedRender();await canvas.dispose();Object.assign(globalThis,old);nativeWindow.requestAnimationFrame=nativeRAF;nativeWindow.cancelAnimationFrame=nativeCancelRAF;};
  paint('#2244ff');media.setStream({});full();
  return {media,canvas,doc,win,video,frames,intervals,paint,tick,full,close,get copies(){return copyCount;},get coords(){return coords;},get paths(){return pathRenders;}};
}
test('real media frames reuse static pixels and full native staging without setCoords churn',async()=>{
  const h=fixture();const copies=h.copies,coords=h.coords,paths=h.paths;
  for(let i=0;i<30;i++){h.paint(i%2?'#ee5511':'#3355ee');h.tick();}
  assert.equal(h.media.frameCanvas.width,1920);assert.equal(h.media.frameCanvas.height,1080);
  assert.equal(h.copies-copies,30);assert.equal(h.coords,coords,'unchanged geometry must not call setCoords');
  assert.equal(h.paths,paths);assert.equal(h.canvas.nextRenderHandle,0,'video frames must not schedule static scene renders');
  assert.equal(h.frames.size,1,'only the next decoded callback remains scheduled');await h.close();assert.equal(h.frames.size,0);
});
test('hidden and offscreen frames skip staging and resume with latest video pixels',async()=>{
  const h=fixture();const copies=h.copies;h.doc.hidden=true;
  for(let i=0;i<5;i++)h.tick();assert.equal(h.copies,copies,'hidden frames must not copy the video');
  h.doc.hidden=false;h.media.object.set('left',10000);h.media.object.setCoords();h.tick();assert.equal(h.copies,copies);
  h.media.object.set('left',60);h.media.object.setCoords();h.paint('#11dd33');h.tick();assert.equal(h.copies,copies+1);
  assert.deepEqual([...h.media.frameCanvas.getContext('2d').getImageData(1900,1060,1,1).data],[17,221,51,255]);await h.close();
});
test('fallback timer is single, restartable, visibility gated and disposed',async()=>{
  const h=fixture({callback:false});assert.equal(h.intervals.size,1);assert.equal([...h.intervals.values()][0].ms,66);
  const copies=h.copies;h.doc.hidden=true;h.tick();assert.equal(h.copies,copies);
  h.doc.hidden=false;h.media.setStream({});assert.equal(h.intervals.size,1);
  h.media.setStream(null);assert.equal(h.intervals.size,0);h.media.setStream({});assert.equal(h.intervals.size,1);
  await h.close();assert.equal(h.intervals.size,0);
});
test('metadata size changes update full staging geometry once and refresh the scene',async()=>{
  const h=fixture();const coords=h.coords;h.video.videoWidth=1600;h.video.videoHeight=1000;h.tick();
  assert.equal(h.media.frameCanvas.width,1600);assert.equal(h.media.frameCanvas.height,1000);assert.equal(h.coords,coords+1);
  assert.equal(h.media.object.width,1600);assert.equal(h.media.object.height,1000);assert.ok(h.canvas.nextRenderHandle);h.full();
  h.tick();assert.equal(h.coords,coords+1);assert.equal(h.canvas.nextRenderHandle,0);await h.close();
});

test('Ultra changes fallback cadence without adding loops or changing the native frame',async()=>{
  const h=fixture({callback:false});
  const event=new Event('alex-screen-share-ultra-state');event.detail={sessionId:'',enabled:true,visible:false};h.win.dispatchEvent(event);
  assert.equal(h.intervals.size,1);assert.equal([...h.intervals.values()][0].ms,1000/60);
  h.tick();assert.equal(h.media.frameCanvas.width,1920);assert.equal(h.media.frameCanvas.height,1080);await h.close();
});
test('pending full renders consume the latest frame and coalesce render requests',async()=>{
  const h=fixture();h.canvas.requestRenderAll();const pending=h.canvas.nextRenderHandle,paths=h.paths;
  for(const color of ['#ff0000','#0000ff','#33ee44']){h.paint(color);h.tick();assert.equal(h.canvas.nextRenderHandle,pending);}
  assert.equal(h.paths,paths);h.full();assert.equal(h.paths,paths+1);
  assert.deepEqual([...h.canvas.contextContainer.getImageData(70,45,1,1).data],[51,238,68,255]);await h.close();
});
