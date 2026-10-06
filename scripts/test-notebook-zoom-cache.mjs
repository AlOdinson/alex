import test from 'node:test';
import assert from 'node:assert/strict';
import { getEnv } from 'fabric/node';
import { setEnv, StaticCanvas, Path, Point, config, Rect } from 'fabric';
import { BoardNotebook } from '../src/lib/boardNotebook.js';
import { currentNotebookChildIndex } from '../src/lib/notebookChildIndex.js';
import { notebookRenderCacheFor, createNotebookRenderCache } from '../src/lib/notebookRenderCache.js';
import { canvasListener } from './notebook-ui-node-harness.mjs';
setEnv(getEnv());
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const pixels = c => new Uint8ClampedArray(c.getContext().getImageData(0,0,c.width,c.height).data);
function fixture() {
  const canvas = new StaticCanvas(null,{width:680,height:580,enableRetinaScaling:false,renderOnAddRemove:false});
  const book = new BoardNotebook({left:30,top:40,boardObjectId:'zoom-book'});
  for(let i=0;i<100;i++)book.addPageObject(new Path(`M -180 ${-190+i*3.8} Q -20 ${-177+i*3.8} 180 ${-186+i*3.8}`,{boardObjectId:`ink-${i}`,stroke:'rgba(23,44,81,.7)',strokeWidth:2,fill:null}));
  canvas.add(book);canvas.renderAll();let renders=0;
  for(const child of book._objects){const render=child.render;child.render=function(...args){renders++;return render.apply(this,args);};}
  const wheel=canvasListener('mouse:wheel',{canvas,Point,clamp:(x,a,b)=>Math.min(b,Math.max(a,x)),MIN_ZOOM:.1,MAX_ZOOM:10,
    DESKTOP_WHEEL_ZOOM_SPEED:1,setZoom(){},updateBackgroundTransform(){},sendTeacherViewThrottled(){}});
  return {canvas,book,wheel,get renders(){return renders;},reset(){renders=0;},close:()=>canvas.dispose()};
}
const fireWheel=(e,delta=-4)=>{e.wheel({e:{deltaY:delta,preventDefault(){},stopPropagation(){}},viewportPoint:new Point(330,270)});e.canvas.cancelRequestedRender();e.canvas.renderAll();};

test('actual Board wheel reuses clean page pixels across small viewport steps, then restores exact density',async()=>{
 const e=fixture();try{
  const records=JSON.stringify(e.book.toObject());
  for(let i=0;i<24;i++)fireWheel(e);
  assert.equal(e.renders,0,'24 small wheel steps re-rendered unchanged page geometry');
  await sleep(240);e.canvas.renderAll();
  assert.equal(e.renders,100,'quiet refinement must repaint once, not stay blurry');
  const actual=pixels(e.canvas);e.book.dirty=true;e.canvas.renderAll();assert.deepEqual(actual,pixels(e.canvas));
  assert.equal(JSON.stringify(e.book.toObject()),records,'viewport quality work changed lesson data');
 }finally{await e.close();}
});

test('viewport-only density refresh keeps the existing page-local spatial index',async()=>{
 const e=fixture();try{const index=currentNotebookChildIndex(e.book);assert.ok(index);
  e.canvas.setZoom(1.8);e.canvas.renderAll();assert.equal(currentNotebookChildIndex(e.book),index,'zoom rebuilt every child bound');
 }finally{await e.close();}
});

test('baked rectangular page mask is released rather than retained alongside its identical-sized page cache',async()=>{
 const e=fixture();try{
  assert.ok(!e.book.clipPath._cacheCanvas,'baked clip pixels retained a second full-sized surface');
  assert.equal(notebookRenderCacheFor(e.canvas).bytesUsed(),e.book._cacheCanvas.width*e.book._cacheCanvas.height*4);
 }finally{await e.close();}
});

test('a page exceeding the retention limit is still painted before its temporary cache is released',async()=>{
 const previous=config.perfLimitSizeTotal;config.perfLimitSizeTotal=12_000_000;
 const canvas=new StaticCanvas(null,{width:120,height:120,enableRetinaScaling:false,renderOnAddRemove:false});
 const book=new BoardNotebook({width:3000,height:3000,left:0,top:0,boardObjectId:'oversize'});
 book.addPageObject(new Rect({left:-1490,top:-1490,width:60,height:60,fill:'red',boardObjectId:'mark'}));canvas.add(book);
 try{assert.doesNotThrow(()=>canvas.renderAll(),'retention eviction destroyed the surface before drawImage');
  assert.ok(pixels(canvas).some((n,i)=>i%4===3&&n>0),'oversize page went blank');
  assert.equal(notebookRenderCacheFor(canvas).bytesUsed(),0);assert.ok(!book._cacheCanvas,'oversize temporary surface was retained');
 }finally{await canvas.dispose();config.perfLimitSizeTotal=previous;}
});

const value=(id,visible,evicted)=>({surfaces:[{width:4,height:4}],isVisible:()=>visible,onEvict:()=>evicted.push(id)});
test('memory admission evicts an offscreen page before a visible least-recently-used page',()=>{
 const cache=createNotebookRenderCache({maxNotebookBytes:128,maxBoardBytes:128}),evicted=[];
 cache.acquire('visible',value('visible',true,evicted));cache.acquire('offscreen',value('offscreen',false,evicted));
 cache.acquire('new',value('new',true,evicted));assert.deepEqual(evicted,['offscreen']);assert.equal(cache.bytesUsed(),128);
});
test('a full set of visible residents does not evict and rebuild each other every frame',()=>{
 const cache=createNotebookRenderCache({maxNotebookBytes:128,maxBoardBytes:128}),evicted=[];
 cache.acquire('a',value('a',true,evicted));cache.acquire('b',value('b',true,evicted));
 assert.equal(cache.acquire('c',value('c',true,evicted)),false);assert.deepEqual(evicted,['c']);
 assert.ok(cache.acquire('a'));assert.ok(cache.acquire('b'));assert.equal(cache.bytesUsed(),128);
});
test('a temporary repair reservation pins its source against another admission',()=>{
 const cache=createNotebookRenderCache({maxNotebookBytes:128,maxBoardBytes:160}),evicted=[];
 cache.acquire('a',{surfaces:[{width:4,height:4}],onEvict:()=>evicted.push('a')});
 cache.acquire('b',{surfaces:[{width:4,height:4}],onEvict:()=>evicted.push('b')});const release=cache.reserveTemporary('a',32);
 assert.ok(release);cache.acquire('c',{surfaces:[{width:4,height:4}],onEvict:()=>evicted.push('c')});
 assert.deepEqual(evicted,['b']);release();assert.equal(cache.bytesUsed(),128);
});
test('non-finite and negative surface sizes cannot corrupt the memory budget',()=>{
 const cache=createNotebookRenderCache({maxNotebookBytes:128,maxBoardBytes:128});
 for(const width of [NaN,-3,Infinity,1.5]){assert.equal(cache.acquire('bad',{surfaces:[{width,height:4}]}),false);assert.equal(cache.bytesUsed(),0);}
});
