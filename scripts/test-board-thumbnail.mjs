import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureBoardThumbnail, installBoardThumbnail } from '../src/lib/boardThumbnail.js';
const image = 'data:image/jpeg;base64,test';
function preview() { return { getContext:()=>({fillRect(){},drawImage(){}}), toDataURL:()=>image }; }
test('thumbnail is bounded and failed/tainted captures are optional',()=>{
  const output=preview();
  assert.equal(captureBoardThumbnail({width:2000,height:1000},()=>output),image);
  assert.equal(output.width,1600); assert.equal(output.height,800);
  assert.equal(captureBoardThumbnail({width:0,height:0}),null);
  assert.equal(captureBoardThumbnail({width:10,height:10},()=>{throw Error('tainted');}),null);
  assert.equal(captureBoardThumbnail({width:10,height:10},()=>({...preview(),toDataURL:()=>image+'x'.repeat(1500000)})),null);
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

test('clean preview paints content on white without copying the grid bitmap',()=>{
  let copied=false,content=false,fill='';
  const ctx={fillStyle:'',fillRect(){fill=this.fillStyle;},drawImage(){copied=true;}};
  const result=captureBoardThumbnail({width:1600,height:900},()=>({getContext:()=>ctx,toDataURL:()=>image}), (context,w,h)=>{content=true;assert.equal(w,1600);assert.equal(h,900);assert.equal(context,ctx);});
  assert.equal(result,image);assert.equal(fill,'#ffffff');assert.equal(content,true);assert.equal(copied,false);
});
test('blocked preview storage remains optional',async()=>{
  const {readBoardThumbnail,saveBoardThumbnail}=await import('../src/lib/boardThumbnailStore.js');
  assert.equal(await readBoardThumbnail('missing'),null);
  assert.equal(await saveBoardThumbnail('missing',image),false);
});
test('erased areas retain white pixels in the JPEG preview',async()=>{
  const { createCanvas } = await import('canvas');
  const output=createCanvas(100,100);
  captureBoardThumbnail({width:100,height:100},()=>output,(ctx)=>{
    ctx.fillStyle='#ff0000';ctx.fillRect(0,0,100,100);
    ctx.globalCompositeOperation='destination-out';ctx.fillRect(20,20,30,30);
    ctx.globalCompositeOperation='source-over';
  });
  assert.deepEqual([...output.getContext('2d').getImageData(30,30,1,1).data],[255,255,255,255]);
});
test('returning Home waits for thumbnail commit before navigation',async()=>{
  const win=new EventTarget(),doc=new EventTarget();doc.createElement=preview;
  const timers=new Map();let nextId=0,finish;const visited=[];
  win.setTimeout=fn=>{timers.set(++nextId,fn);return nextId;};win.clearTimeout=id=>timers.delete(id);
  win.location={href:'https://example.test/alex/board/lesson?key=x',assign:url=>visited.push(url)};
  const canvas={lowerCanvasEl:{width:800,height:600},on(){},off(){}};
  const previous=globalThis.document;globalThis.document=doc;
  try {
    const dispose=installBoardThumbnail({canvas,save:()=>new Promise(resolve=>{finish=resolve;}),window:win,document:doc});
    const event=new Event('click',{cancelable:true});
    Object.defineProperties(event,{button:{value:0},target:{value:{closest:()=>({href:'https://example.test/alex/',hasAttribute:()=>false})}}});
    win.dispatchEvent(event);
    assert.equal(event.defaultPrevented,true);assert.deepEqual(visited,[]);
    finish(true);await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(visited,['https://example.test/alex/']);
    dispose();assert.equal(timers.size,0);
  } finally {globalThis.document=previous;}
});
test('a failed thumbnail write is retried rather than marked saved',async()=>{
  const win=new EventTarget(),doc=new EventTarget();doc.createElement=preview;
  win.setTimeout=()=>1;win.clearTimeout=()=>{};
  const canvas={lowerCanvasEl:{width:800,height:600},on(){},off(){}};
  let writes=0;const previous=globalThis.document;globalThis.document=doc;
  try{
    const dispose=installBoardThumbnail({canvas,save:()=>{writes++;return false;},window:win,document:doc});
    win.dispatchEvent(new Event('pagehide'));await new Promise(resolve=>setImmediate(resolve));
    win.dispatchEvent(new Event('pagehide'));assert.equal(writes,2);dispose();
  }finally{globalThis.document=previous;}
});
