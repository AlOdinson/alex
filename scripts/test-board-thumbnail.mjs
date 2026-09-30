import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureBoardThumbnail, installBoardThumbnail } from '../src/lib/boardThumbnail.js';
const image = 'data:image/jpeg;base64,test';
function preview() { return { getContext:()=>({fillRect(){},drawImage(){}}), toDataURL:()=>image }; }
test('thumbnail is bounded and failed/tainted captures are optional',()=>{
  const output=preview();
  assert.equal(captureBoardThumbnail({width:2000,height:1000},()=>output),image);
  assert.equal(output.width,360); assert.equal(output.height,180);
  assert.equal(captureBoardThumbnail({width:0,height:0}),null);
  assert.equal(captureBoardThumbnail({width:10,height:10},()=>{throw Error('tainted');}),null);
  assert.equal(captureBoardThumbnail({width:10,height:10},()=>({...preview(),toDataURL:()=>image+'x'.repeat(60000)})),null);
});
test('render bursts coalesce, page exit flushes, and cleanup detaches',()=>{
  const win=new EventTarget(),doc=new EventTarget();doc.createElement=preview;
  let pending=null,render=null,cleared=0;const saved=[];
  win.setTimeout=fn=>{assert.equal(pending,null);pending=fn;return 1;};
  win.clearTimeout=()=>{pending=null;cleared++;};
  const canvas={lowerCanvasEl:{width:800,height:600},on:(event,fn)=>{render=fn;},off:()=>{render=null;}};
  const previous=globalThis.document;globalThis.document=doc;
  try {
    const dispose=installBoardThumbnail({canvas,save:x=>saved.push(x),window:win,document:doc});
    for(let i=0;i<100;i++)render();
    assert.equal(saved.length,0);
    win.dispatchEvent(new Event('pagehide'));assert.deepEqual(saved,[image]);
    render();dispose();assert.equal(saved.length,1);assert.equal(render,null);assert.equal(pending,null);assert.ok(cleared);
  } finally {globalThis.document=previous;}
});
