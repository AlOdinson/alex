import test from 'node:test';
import assert from 'node:assert/strict';
test('worker alpha readback uses bounded tiles and closes its dedicated bitmap',async()=>{
 const oldSelf=globalThis.self,oldCanvas=globalThis.OffscreenCanvas;
 let largest=0,closed=0,reply;const surface=[];
 globalThis.OffscreenCanvas=class {
  constructor(w,h){this.width=w;this.height=h;surface.push(this);}
  getContext(){return{drawImage(){},getImageData(x,y,w,h){largest=Math.max(largest,w*h);return{data:new Uint8ClampedArray(w*h*4)};}};}
 };
 globalThis.self={postMessage:value=>reply=value};
 try{
  await import('../src/lib/notebookSplitWorker.js');
  await self.onmessage({data:{id:1,type:'raster-bounds',width:513,height:521,bitmap:{close(){closed++;}}}});
  assert.deepEqual(reply,{id:1,result:{empty:true}});assert.ok(largest<=65536,`read ${largest} pixels at once`);assert.equal(closed,1);assert.equal(surface[0].width,0);
 }finally{globalThis.self=oldSelf;globalThis.OffscreenCanvas=oldCanvas;}
});
