import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';
import { createGifCompositor, createGifMedia } from '../src/lib/gifMedia.js';
import { createMediaMemoryBudget } from '../src/lib/mediaMemoryBudget.js';
import { createBoardMediaRuntime } from '../src/lib/boardMediaRuntime.js';
const frame=(color,left=0,disposalType=1,delay=20)=>({dims:{left,top:0,width:1,height:1},patch:new Uint8ClampedArray(color),disposalType,delay});
test('partial transparent frames and disposal restore previous/background',()=>{
  const element=createCanvas(2,1); const c=createGifCompositor({element,createCanvas,width:2,height:1});
  c.draw(frame([255,0,0,255]));c.draw(frame([0,0,255,255],1,3));
  c.draw(frame([0,0,0,0]));
  assert.deepEqual([...element.getContext('2d').getImageData(0,0,2,1).data],[255,0,0,255,0,0,0,0]);
  c.draw(frame([0,255,0,255],0,2));c.draw(frame([0,0,255,255],1));
  assert.deepEqual([...element.getContext('2d').getImageData(0,0,1,1).data],[0,0,0,0]);c.dispose();
});
test('25 MiB full-HD GIF fits the bounded media budget and releases its reservation',async()=>{
  let closed=false;
  const decoder={init:async()=>({width:1920,height:1080,frameCount:1,loops:1}),frame:async()=>frame([255,0,0,255]),close(){closed=true;}};
  const budget=createMediaMemoryBudget();
  const gif=await createGifMedia({blob:new Blob([new Uint8Array(25*1024*1024)]),budget,decoder,createCanvas});
  assert.ok(budget.usedBytes()<=128*1024*1024);
  gif.dispose(); assert.equal(budget.usedBytes(),0);assert.equal(closed,true);
});
test('runtime hydration is idempotent, hidden GIF does not draw and deletion cleans up',async()=>{
  const events=new Map();let renders=0,created=0,destroyed=0,advanced=0;
  const object={mediaKind:'gif',mediaAssetId:'a'.repeat(64),width:1,height:1,isOnScreen:()=>true,setElement(el){this.el=el;},set(v){Object.assign(this,v);},setCoords(){}};
  const objects=[object];const canvas={getObjects:()=>objects,getZoom:()=>1,on:(name,fn)=>events.set(name,fn),off:name=>events.delete(name),requestRenderAll(){renders++;}};
  const runtime=createBoardMediaRuntime({canvas,boardId:'a',store:{get:async()=>({metadata:{kind:'gif'},blob:new Blob(['GIF89a'])})},gifFactory:async()=>{created++;return {element:{width:1,height:1},width:1,height:1,advance:async()=>{advanced++;return {changed:true,nextDelayMs:10};},dispose(){destroyed++;}};}});
  runtime.suspend(true);await runtime.hydrate(object);await new Promise(ok=>setTimeout(ok,35));
  assert.equal(created,1);assert.equal(advanced,0);assert.equal(renders,1);
  objects.length=0;events.get('object:removed')({target:object});runtime.dispose();
  assert.equal(destroyed,1);assert.equal(runtime.getStats().timerActive,false);
});
test('one-frame-at-a-time animation preserves delays and finite loops and releases memory',async()=>{
  const frames=[frame([255,0,0,255],0,1,20),frame([0,0,255,255],0,1,40)]; let closed=false;
  const decoder={init:async()=>({width:1,height:1,frameCount:2,loops:1}),frame:async index=>frames[index],close(){closed=true;}};
  const budget=createMediaMemoryBudget();const gif=await createGifMedia({blob:new Blob(['GIF89a']),budget,decoder,createCanvas});
  assert.equal((await gif.advance(0)).changed,false);
  assert.equal((await gif.advance(20)).changed,true);
  assert.equal((await gif.advance(60)).nextDelayMs,null);
  assert.deepEqual([...gif.element.getContext('2d').getImageData(0,0,1,1).data],[0,0,255,255]);
  gif.dispose();assert.equal(closed,true);assert.equal(budget.usedBytes(),0);
});
