import test from 'node:test';
import assert from 'node:assert/strict';
import { getEnv } from 'fabric/node';
import { setEnv, StaticCanvas, Path } from 'fabric';
import { BoardNotebook } from '../src/lib/boardNotebook.js';
import { createNotebookBoardActions } from '../src/lib/notebookBoardActions.js';
import { prepareNotebookProjection } from '../src/lib/notebookProjection.js';
import { applyNotebookOperation } from '../src/lib/notebookOperations.js';
setEnv(getEnv());

const fields=['boardObjectId','updatedAt','updatedBy','isEraserPath'];
const ink=(id,i,options={})=>{
  const x=-205+(i%25)*16, y=-165+(Math.floor(i/25)%21)*16;
  return new Path(`M ${x} ${y} Q ${x+5} ${y+7} ${x+11} ${y+1}`,{
    boardObjectId:id,fill:null,stroke:'rgba(30,60,100,.68)',opacity:.82,strokeWidth:2,...options,
  });
};
const eraser=(id,i)=>ink(id,i,{stroke:'black',opacity:1,strokeWidth:12,
  globalCompositeOperation:'destination-out',isEraserPath:true});
const pixels=canvas=>canvas.getContext().getImageData(0,0,canvas.lowerCanvasEl.width,canvas.lowerCanvasEl.height).data;
function canonical(canvas,book){const actual=pixels(canvas);book.dirty=true;canvas.renderAll();assert.deepEqual(actual,pixels(canvas));}
async function fixture(count,{erasers=20}={}){
  const canvas=new StaticCanvas(null,{width:760,height:680,renderOnAddRemove:false,enableRetinaScaling:false});
  const book=new BoardNotebook({boardObjectId:'book',left:40,top:35});
  for(let i=0;i<count;i++)book.addPageObject(ink(`old-${i}`,i));
  for(let i=0;i<erasers;i++)book.addPageObject(eraser(`mask-${i}`,i*7+3));
  canvas.add(book);canvas.renderAll();
  let oldRenders=0;
  for(const child of book.getPageObjects()) {const render=child.render;child.render=function(...args){oldRenders++;return render.apply(this,args);};}
  const controller={enqueue:()=>({actionId:'accept',inverseOps:[],settled:new Promise(()=>{})}),pendingObjectIds:()=>new Set(['book'])};
  const actions=createNotebookBoardActions({getCanvas:()=>canvas,getController:async()=>controller,clientId:'owner',
    acquireLease:async()=>true,ownsLease:()=>true,releaseLease(){},recordAction(){},
    getRecords:objects=>objects.map(object=>({object:object.toObject(fields),zIndex:canvas._objects.indexOf(object)}))});
  return{canvas,book,actions,get oldRenders(){return oldRenders;},close:()=>canvas.dispose()};
}
async function capture(f){
  const stroke=new Path('M 180 300 Q 215 330 250 305',{stroke:'rgba(180,20,70,.55)',opacity:.7,strokeWidth:4,fill:null,boardObjectId:'fresh'});
  f.canvas.add(stroke);assert.equal(await f.actions.capture(f.book,stroke),true);f.canvas.renderAll();
}

for(const count of [100,300,1000]) test(`new ink after eraser history does not replay ${count} retained children`,async()=>{
  const f=await fixture(count);
  try {await capture(f);assert.equal(f.oldRenders,0,`new ink replayed ${f.oldRenders} retained children`);canonical(f.canvas,f.book);}
  finally {await f.close();}
});

test('delete and restore of an eraser preserves translucent source ink and canonical pixels',async()=>{
  const f=await fixture(120,{erasers:1});
  try {
    const target=f.book._objects[12];target.set({stroke:'rgba(160,20,80,.45)',opacity:.57});f.book.invalidatePageContent(target);f.book.dirty=true;f.canvas.renderAll();
    const original={stroke:target.stroke,opacity:target.opacity,path:structuredClone(target.path)};
    const mask=f.book._objects.find(object=>object.boardObjectId==='mask-0');
    const serialized=mask.toObject(fields), zIndex=f.book._objects.indexOf(mask);
    const project=async changes=>{const state={...f.book.toObject(fields)};applyNotebookOperation(state,{type:'notebook',version:1,id:'book',pageNumber:1,changes});
      const work=await prepareNotebookProjection(f.book,state);assert.equal(work.apply(),true);f.canvas.renderAll();canonical(f.canvas,f.book);};
    await project([{type:'delete',id:'mask-0'}]);
    await project([{type:'insert',zIndex,object:serialized}]);
    const retained=f.book._objects.find(object=>object.boardObjectId===target.boardObjectId);
    assert.equal(retained.stroke,original.stroke);assert.equal(retained.opacity,original.opacity);assert.deepEqual(retained.path,original.path);
  } finally {await f.close();}
});
