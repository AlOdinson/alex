import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Canvas, FabricImage, Path, Rect, Group, getEnv } from 'fabric/node';
import { createBoardScreenShareCompositor as create } from '../src/lib/boardScreenShareCompositor.js';
let maximumPixelDifference = 0;
function fixture({retina=1}={}) {
  const canvas=new Canvas(null,{width:160,height:120,renderOnAddRemove:false,enableRetinaScaling:true,preserveObjectStacking:true});
  canvas.getRetinaScaling=()=>retina;canvas.setDimensions({width:160,height:120});
  const source=getEnv().document.createElement('canvas');source.width=80;source.height=60;
  const object=new FabricImage(source,{left:35,top:25,objectCaching:false,transientScreenShare:true});
  const below=new Path('M 5 5 L 145 100 L 15 90 z',{fill:'#ef7322',objectCaching:false});
  const above=new Path('M 15 20 Q 100 110 140 20 L 150 100 z',{fill:'#38b47c',objectCaching:false});
  let calls=0; for(const p of [below,above]) { const original=p._render; p._render=function(...args){calls++;return original.apply(this,args);}; }
  canvas.on('before:render',({ctx})=>{ctx.fillStyle='#fff';ctx.fillRect(0,0,160,120);ctx.fillStyle='#dedede';ctx.fillRect(0,40,160,2);});
  canvas.add(below,object,above);
  const cacheCanvases=[],doc={hidden:false,createElement(){const c=getEnv().document.createElement('canvas');cacheCanvases.push(c);return c;}};
  const compositor=create({object,document:doc});
  const paint=(color='#3456e8')=>{const ctx=source.getContext('2d');ctx.fillStyle=color;ctx.fillRect(0,0,80,60);};
  const render=()=>{canvas.cancelRequestedRender();canvas.renderAll();};
  const pixels=()=>Buffer.from(canvas.contextContainer.getImageData(0,0,160*retina,120*retina).data);
  const close=async()=>{compositor.dispose();canvas.cancelRequestedRender();await canvas.dispose();};
  paint();render();return {canvas,source,object,below,above,compositor,doc,cacheCanvases,paint,render,pixels,close,get calls(){return calls;}};
}
function equivalent(actual,expected) {
  let max=0,different=0;for(let i=0;i<actual.length;i++){const delta=Math.abs(actual[i]-expected[i]);max=Math.max(max,delta);if(delta)different++;}
  maximumPixelDifference = Math.max(maximumPixelDifference, max);
  assert.ok(max<=2,`pixel mismatch: max channel error ${max}; ${different} channels differ`);
}
test('60 video presentations do not redraw static paths; actual pixels match Fabric',async()=>{
  const h=fixture();const before=h.calls;
  for(let i=0;i<60;i++){h.paint(i%2?'#faab22':'#3366aa');assert.equal(h.compositor.present(),true);}
  assert.equal(h.calls-before,0,'video-only frames must not render static paths');
  const fast=h.pixels();h.render();equivalent(fast,h.pixels());
  console.log('Static path renders across 60 frames: ordinary=120, compositor=0');await h.close();
});
test('actual background, stacking and viewport/DPR pixels survive multiple transforms',async()=>{
  for(const retina of [1,2]) { const h=fixture({retina});
    for(const v of [[1,0,0,1,0,0],[1.25,0,0,1.25,-18,-9],[0.7,0,0,0.7,23,11]]) {
      h.canvas.setViewportTransform(v);h.render();h.paint('#c346ed');h.compositor.present();const fast=h.pixels();h.render();equivalent(fast,h.pixels());
    }await h.close();
  }
  console.log(`Largest RGBA difference from ordinary Fabric at DPR 1/2: ${maximumPixelDifference}/255`);
});
test('pending render, cancelled scene events, order, viewport and media geometry invalidate',async()=>{
  const h=fixture();
  for(const mutate of [
    ()=>{h.above.set('fill','#992244');h.canvas.requestRenderAll();},
    ()=>{h.canvas.remove(h.above);h.canvas.cancelRequestedRender();},
    ()=>h.canvas.moveObjectTo(h.below,1),
    ()=>h.canvas.viewportTransform[4]+=8,
    ()=>{h.object.set({width:70,scaleX:1.1});h.object.setCoords();},
  ]) {
    mutate();h.paint('#2288ff');assert.equal(h.compositor.present(),false,'invalid cache must request ordinary render');
    assert.ok(h.canvas.nextRenderHandle,'even cancelled object edits need an ordinary refresh');h.render();
    h.paint('#ff5522');assert.equal(h.compositor.present(),true);const fast=h.pixels();h.render();equivalent(fast,h.pixels());
  }await h.close();
});
test('hidden/offscreen frames do no presentation work and resume',async()=>{
  const h=fixture();let renders=0;h.canvas.on('after:render',()=>renders++);
  const before=h.pixels(),calls=h.calls;h.doc.hidden=true;h.paint('#ff0000');assert.equal(h.compositor.isVisible(),false);h.compositor.present();
  assert.deepEqual(h.pixels(),before);assert.equal(h.calls,calls);assert.equal(renders,0);
  h.doc.hidden=false;h.object.set('left',10000);h.object.setCoords();assert.equal(h.compositor.isVisible(),false);h.compositor.present();assert.equal(renders,0);
  h.object.set('left',35);h.object.setCoords();assert.equal(h.compositor.isVisible(),true);h.compositor.present();assert.notDeepEqual(h.pixels(),before);await h.close();
});
test('selection, erasing, nested unsupported blending and canvas overlays use ordinary renderer',async()=>{
  for(const change of [
    h=>h.canvas.setActiveObject(h.object),
    h=>h.above.set('globalCompositeOperation','destination-out'),
    h=>h.canvas.add(new Group([new Rect({width:30,height:30,globalCompositeOperation:'multiply'})])),
    h=>{h.canvas.overlayColor='rgba(255,0,0,0.2)';},
    h=>{h.canvas.clipPath=new Rect({width:80,height:80});},
  ]) {const h=fixture();change(h);h.render();h.paint('#fac234');assert.equal(h.compositor.present(),false);h.render();await h.close();}
});
test('fast presentation preserves top-canvas drawing preview and disposal releases hooks/caches',async()=>{
  const h=fixture();h.canvas.contextTop.fillStyle='#ff0000';h.canvas.contextTop.fillRect(5,5,20,20);
  const top=()=>Buffer.from(h.canvas.contextTop.getImageData(0,0,160,120).data),before=top();h.compositor.present();assert.deepEqual(top(),before);
  h.compositor.dispose();assert.ok(h.cacheCanvases.every(c=>c.width===0&&c.height===0));
  const calls=h.calls;h.compositor.present();assert.equal(h.calls,calls);h.canvas.requestRenderAll();h.render();assert.ok(h.calls>calls);await h.close();
});
test('video-only frames do not scan static scene objects, including after a stack reorder',async()=>{
  const h=fixture();let scans=0;const getObjects=h.canvas.getObjects;
  h.canvas.getObjects=function(...args){scans++;return getObjects.apply(this,args);};
  for(let i=0;i<10;i++)h.compositor.present();assert.equal(scans,0);
  h.canvas.moveObjectTo(h.below,2);assert.equal(h.compositor.present(),false);h.render();
  h.paint('#cc8800');h.compositor.present();const fast=h.pixels();h.render();equivalent(fast,h.pixels());await h.close();
});
test('hooks survive other wrappers, reattachment, exports and disposal',async()=>{
  const h=fixture();const installedRender=h.canvas._renderObjects,installedRequest=h.canvas.requestRenderAll;
  let forwarded=0;h.canvas._renderObjects=function(...args){forwarded++;return installedRender.apply(this,args);};
  const laterRender=h.canvas._renderObjects;
  h.canvas.requestRenderAll=function(...args){return installedRequest.apply(this,args);};const laterRequest=h.canvas.requestRenderAll;
  h.canvas.remove(h.object);h.canvas.add(h.object);h.render();h.compositor.dispose();
  h.render();assert.ok(forwarded>0);assert.equal(h.canvas._renderObjects,laterRender);assert.equal(h.canvas.requestRenderAll,laterRequest);
  await h.close();
});
test('thumbnail/export rendering cannot overwrite the live compositor cache',async()=>{
  const h=fixture();h.canvas.toCanvasElement(0.5,{filter:item=>!item.transientScreenShare});
  h.paint('#aadd22');assert.equal(h.compositor.present(),true);const fast=h.pixels();h.render();equivalent(fast,h.pixels());await h.close();
});

test('stationary selected isolated notebook keeps controls and skips full scenes at DPR 1/2',async()=>{
  // A cached group uses the same isolation contract as BoardNotebook, without
  // mixing fabric/node and browser Fabric class registries in this pixel fixture.
  for(const retina of [1,2]) for(const beforeVideo of [false,true]) {
    const h=fixture({retina});
    const ink=new Rect({left:-20,top:-20,width:45,height:45,fill:'rgba(255,0,0,.5)'});
    const eraser=new Rect({left:0,top:0,width:20,height:20,globalCompositeOperation:'destination-out'});
    const notebook=new Group([ink,eraser],{left:15,top:20,objectCaching:true,backgroundColor:'white',width:70,height:70});
    notebook.isNotebookCompositingIsolated=()=>Boolean(notebook.ownCaching&&notebook._cacheCanvas);
    h.canvas.add(notebook);if(beforeVideo)h.canvas.moveObjectTo(notebook,0);
    h.canvas.setActiveObject(notebook);h.render();h.render();
    let renders=0;h.canvas.on('before:render',()=>renders++);
    for(let i=0;i<60;i++){h.paint(i%2?'#faab22':'#3366aa');assert.equal(h.compositor.present(),true);}
    assert.equal(renders,0);const fast=h.pixels();h.render();equivalent(fast,h.pixels());
    notebook.set('left',notebook.left+5);h.canvas.fire('object:moving',{target:notebook});assert.equal(h.compositor.present(),false);
    h.render();assert.equal(h.compositor.present(),true);
    await h.close();
  }
});
