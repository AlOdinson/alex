import test from 'node:test';
import assert from 'node:assert/strict';
import {getEnv} from 'fabric/node';
import {setEnv,StaticCanvas,Path} from 'fabric';
import {BoardNotebook,captureNotebookObject} from '../src/lib/boardNotebook.js';
import {createNotebookBoardActions} from '../src/lib/notebookBoardActions.js';
import {prepareNotebookProjection} from '../src/lib/notebookProjection.js';
setEnv(getEnv());
const oldInk=i=>new Path(`M -170 ${-120+i*3} L 90 ${-113+i*3}`,{stroke:'#345',strokeWidth:2,fill:null,boardObjectId:`old-${i}`});
const fresh=(options={})=>new Path('M 200 320 Q 240 355 270 324',{stroke:'rgba(20,30,40,.6)',opacity:.7,strokeWidth:4,fill:null,boardObjectId:'source',...options});
async function fixture({scale=1,erased=false,zoom=1,retina=1,opacity=1}={}) {
 const canvas=new StaticCanvas(null,{width:800,height:700,renderOnAddRemove:false,enableRetinaScaling:false});
 canvas.getRetinaScaling=()=>retina;canvas.setDimensions({width:800,height:700});canvas.setZoom(zoom);
 const book=new BoardNotebook({opacity,boardObjectId:'book',left:30,top:40,scaleX:scale,scaleY:scale});
 for(let i=0;i<100;i++)book.addPageObject(oldInk(i));
 if(erased){const eraser=oldInk(94);eraser.set({strokeWidth:28,globalCompositeOperation:'destination-out',isEraserPath:true});book.addPageObject(eraser);}
 canvas.add(book);canvas.renderAll();
 let oldRenders=0;
 for(const child of book.getPageObjects()){const render=child.render;child.render=function(...args){oldRenders++;return render.apply(this,args);};}
 const controller={enqueue:()=>({actionId:'a',inverseOps:[],settled:new Promise(()=>{})}),pendingObjectIds:()=>new Set(['book'])};
 const actions=createNotebookBoardActions({getCanvas:()=>canvas,getController:async()=>controller,clientId:'owner',acquireLease:async()=>true,ownsLease:()=>true,releaseLease(){},recordAction(){},getRecords:objects=>objects.map(object=>({object:object.toObject(['boardObjectId']),zIndex:1}))});
 return{canvas,book,actions,get oldRenders(){return oldRenders;},reset(){oldRenders=0;},close:()=>canvas.dispose()};
}
const pixels=canvas=>canvas.getContext().getImageData(0,0,canvas.lowerCanvasEl.width,canvas.lowerCanvasEl.height).data;
async function capture(e,stroke){e.canvas.add(stroke);assert.equal(await e.actions.capture(e.book,stroke),true);e.canvas.renderAll();}

test('an interior new stroke appends to the ready page cache without rendering 100 old children',async()=>{
 const e=await fixture();
 try{await capture(e,fresh());assert.equal(e.oldRenders,0,'adding one stroke rerendered the whole old page');
  const actual=pixels(e.canvas);e.book.dirty=true;e.canvas.renderAll();assert.deepEqual(actual,pixels(e.canvas),'append differs from canonical whole render');
 }finally{await e.close();}
});

test('append preserves transparent ink over earlier erasing and does not reapply old masks',async()=>{
 const e=await fixture({erased:true});
 try{await capture(e,fresh({strokeDashArray:[8,4],strokeLineCap:'round'}));assert.equal(e.oldRenders,0);
  const actual=pixels(e.canvas);e.book.dirty=true;e.canvas.renderAll();assert.deepEqual(actual,pixels(e.canvas));
 }finally{await e.close();}
});

test('metadata-only page projection does not prevent safe subsequent cache append',async()=>{
 const e=await fixture();
 try{const target={...e.book.toObject(['boardObjectId']),updatedAt:91,updatedBy:'teacher'};
  const projection=await prepareNotebookProjection(e.book,target);assert.equal(projection.apply(),true);
  await capture(e,fresh());assert.equal(e.oldRenders,0);
 }finally{await e.close();}
});

test('zoom change and eviction take a canonical full render before append can resume',async()=>{
 const e=await fixture();
 try{e.canvas.setZoom(1.3);await capture(e,fresh());assert.ok(e.oldRenders>=100,'changed cache density reused old pixels');
  e.reset();e.book.releasePageCache();await capture(e,fresh({top:220}));assert.ok(e.oldRenders>=100);
  const actual=pixels(e.canvas);e.book.dirty=true;e.canvas.renderAll();assert.deepEqual(actual,pixels(e.canvas));
 }finally{await e.close();}
});

test('near-boundary stroke retains clipped canonical rendering rather than painting outside the cache mask',async()=>{
 const e=await fixture();
 try{await capture(e,new Path('M 32.5 170 L 32.5 220',{stroke:'black',strokeWidth:4,fill:null,boardObjectId:'edge'}));
  assert.ok(e.oldRenders>=100,'edge-antialias region must use the full clipped path');
  const actual=pixels(e.canvas);e.book.dirty=true;e.canvas.renderAll();assert.deepEqual(actual,pixels(e.canvas));
 }finally{await e.close();}
});

test('a changed earlier child is never hidden by the append fast path',async()=>{
 const e=await fixture();
 try{e.book.getPageObjects()[0].set('stroke','red');e.book.invalidatePageContent(e.book.getPageObjects()[0]);
  await capture(e,fresh());assert.ok(e.oldRenders>=100);
  const actual=pixels(e.canvas);e.book.dirty=true;e.canvas.renderAll();assert.deepEqual(actual,pixels(e.canvas));
 }finally{await e.close();}
});

test('an acute miter that can escape the page does not use interior append',async()=>{
 const e=await fixture();
 try{await capture(e,new Path('M 250 450 L 255 500 L 260 450',{stroke:'black',strokeWidth:10,strokeLineJoin:'miter',strokeMiterLimit:20,fill:null,boardObjectId:'miter'}));
  assert.ok(e.oldRenders>=100,'the miter extends beyond its ordinary object bounds');
  const actual=pixels(e.canvas);e.book.dirty=true;e.canvas.renderAll();assert.deepEqual(actual,pixels(e.canvas));
 }finally{await e.close();}
});

for(const options of [{zoom:.7,retina:2},{zoom:1.5,retina:2,opacity:.45},{scale:1.4,zoom:.8,retina:2}])
test(`cached append is pixel-identical at density ${JSON.stringify(options)}`,async()=>{
 const e=await fixture(options);
 try{await capture(e,fresh({strokeUniform:true,strokeDashArray:[6,4]}));assert.equal(e.oldRenders,0);
  const actual=pixels(e.canvas);e.book.dirty=true;e.canvas.renderAll();assert.deepEqual(actual,pixels(e.canvas));
 }finally{await e.close();}
});

test('append retains the exact canonical cache transform instead of reconstructing its floating matrix',async()=>{
 const e=await fixture({scale:1.4,zoom:.8,retina:2});
 const context=e.book._cacheContext,original=context.setTransform;let transforms=0;
 context.setTransform=function(...args){transforms++;return original.apply(this,args);};
 try{await capture(e,fresh({strokeUniform:true}));assert.equal(e.oldRenders,0);
  assert.equal(transforms,0,'reconstructing a fractional cache matrix changes WebKit edge pixels');
 }finally{context.setTransform=original;await e.close();}
});
