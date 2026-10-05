import test from 'node:test';
import assert from 'node:assert/strict';
import { getEnv } from 'fabric/node';
import { setEnv, StaticCanvas, Path, Textbox, Rect } from 'fabric';
import { BoardNotebook, applyPageDeltaToFabric } from '../src/lib/boardNotebook.js';
import { prepareNotebookProjection } from '../src/lib/notebookProjection.js';
import { applyNotebookOperation, invertNotebookOperation } from '../src/lib/notebookOperations.js';
setEnv(getEnv());
const fields=['boardObjectId','updatedAt','updatedBy','isEraserPath'];
const ink=(id,x=0,y=0,options={})=>new Path(`M ${x} ${y} Q ${x+8} ${y+12} ${x+18} ${y+3}`,{boardObjectId:id,fill:null,stroke:'#235',strokeWidth:2,strokeLineJoin:'round',...options});
const op=changes=>({type:'notebook',version:1,id:'book',pageNumber:1,updatedAt:12,updatedBy:'writer',changes});
async function fixture(options={}) {
 const children=Array.from({length:180},(_,i)=>ink(`old-${i}`,-218+(i%15)*30,-180+Math.floor(i/15)*31));
 children.push(ink('target',-15,-8,{stroke:'rgba(130,20,40,.5)',opacity:.6}));
 children.push(ink('overlay',-10,-5,{stroke:'#257',opacity:.4}));
 if(options.erased)children.push(ink('eraser',-15,-8,{stroke:'black',strokeWidth:9,globalCompositeOperation:'destination-out',isEraserPath:true}));
 const book=await BoardNotebook.fromObject({boardObjectId:'book',left:35,top:40,...options.book,notebookPages:[children.map(x=>x.toObject(fields))]});
 children.forEach(x=>x.dispose());
 const canvas=new StaticCanvas(null,{width:800,height:730,renderOnAddRemove:false,enableRetinaScaling:false});
 canvas.setZoom(options.zoom??1);canvas.add(book);canvas.renderAll();
 let renders=0;for(const object of book._objects){const render=object.render;object.render=function(...args){renders++;return render.apply(this,args);};}
 return {book,canvas,renders:()=>renders,reset:()=>{renders=0;},close:()=>canvas.dispose()};
}
function pixels(canvas){return canvas.getContext().getImageData(0,0,canvas.width,canvas.height).data;}
async function project(f,changes){const target={...f.book.toObject(fields)};applyNotebookOperation(target,op(changes));const work=await prepareNotebookProjection(f.book,target);assert.equal(work.apply(),true);return target;}
function canonical(f){const actual=pixels(f.canvas);f.book.dirty=true;f.canvas.renderAll();const expected=pixels(f.canvas);let count=0;const examples=[];for(let i=0;i<actual.length;i++)if(actual[i]!==expected[i]){count++;if(examples.length<8)examples.push({x:Math.floor(i/4)%f.canvas.width,y:Math.floor(i/4/f.canvas.width),channel:i%4,a:actual[i],b:expected[i]});}assert.equal(count,0,`local paint differs from canonical: ${JSON.stringify(examples)}`);}
for(const [name,changes] of [
 ['move',[{type:'patch',id:'target',patch:{left:55,top:35}}]],
 ['delete',[{type:'delete',id:'target'}]],
 ['middle insert',[{type:'insert',zIndex:50,object:ink('middle',-20,18,{opacity:.45}).toObject(fields)}]],
])test(`${name} preserves exact pixels and does not repaint distant page children`,async()=>{
 const f=await fixture({erased:true});try{const retained=f.book._objects[0];await project(f,changes);f.canvas.renderAll();
 assert.ok(f.renders()<45,`small edit repainted ${f.renders()} retained children`);assert.strictEqual(f.book._objects[0],retained);canonical(f);
 }finally{await f.close();}
});
test('a patch projection never exports either entire indexed page',async()=>{
 const f=await fixture();let exports=0;const freeze=Object.freeze;
 try{const target={...f.book.toObject(fields)};applyNotebookOperation(target,op([{type:'patch',id:'target',patch:{stroke:'#b32'}}]));
 Object.freeze=function(value){if(Array.isArray(value)&&value.length===182&&value[0]?.boardObjectId==='old-0')exports++;return freeze(value);};
 const work=await prepareNotebookProjection(f.book,target);assert.equal(work.apply(),true);assert.equal(exports,0,'small patch exported a complete child array');
 }finally{Object.freeze=freeze;await f.close();}
});
test('incoming child deletion uses local damage repair as well as projection',async()=>{
 const f=await fixture();try{await applyPageDeltaToFabric(f.book,op([{type:'delete',id:'target'}]));f.canvas.renderAll();assert.ok(f.renders()<45,`incoming deletion repainted ${f.renders()}`);canonical(f);}finally{await f.close();}
});
test('fractional scale and translucent page preserve pixels on repair',async()=>{
 const f=await fixture({zoom:1.13,book:{scaleX:.91,scaleY:.91,opacity:.71},erased:true});
 try{await project(f,[{type:'patch',id:'target',patch:{strokeWidth:5,stroke:'rgba(140,20,180,.5)'}}]);f.canvas.renderAll();assert.ok(f.renders()<45);canonical(f);}finally{await f.close();}
});
test('undo of a local deletion restores original z-order and pixels without a whole page repaint',async()=>{
 const f=await fixture({erased:true});try{const before={...f.book.toObject(fields)},action=op([{type:'delete',id:'target'}]);const after=await project(f,action.changes);f.canvas.renderAll();f.reset();
 const undo=invertNotebookOperation(before,action,{clientId:'writer',actionId:'delete',afterState:after});
 assert.ok(undo.length);for(const operation of undo){if(operation.type==='notebook'){const target={...f.book.toObject(fields)};applyNotebookOperation(target,operation);const work=await prepareNotebookProjection(f.book,target);assert.equal(work.apply(),true);}}
 f.canvas.renderAll();assert.ok(f.renders()<45);assert.equal(f.book._objects.at(-3).boardObjectId,'target');canonical(f);
 }finally{await f.close();}
});
test('cancelled replacement does not mutate records, pixels, or dispose retained children',async()=>{
 const f=await fixture();try{const before=f.book.notebookPages,old=f.book._objects.at(-2),image=pixels(f.canvas);let current=true;
 const target={...f.book.toObject(fields)};applyNotebookOperation(target,op([{type:'patch',id:'target',patch:{left:77}}]));
 const work=await prepareNotebookProjection(f.book,target,{isCurrent:()=>current});current=false;assert.equal(work.apply(),false);work.dispose();
 assert.strictEqual(f.book.notebookPages,before);assert.strictEqual(old.group,f.book);assert.deepEqual(pixels(f.canvas),image);
 }finally{await f.close();}
});

test('mixed addressed transactions preserve every layer and match canonical pixels',async()=>{
 const f=await fixture({erased:true});try{
  let serial=0;
  for(let i=0;i<36;i++){
   const inserted=ink(`mixed-${serial++}`,-35+(i%6)*11,-22+(i%7)*9,{opacity:.53}).toObject(fields);
   const changes=i%3===0?[{type:'insert',zIndex:70+i,object:inserted}]
     :i%3===1?[{type:'patch',id:'target',patch:{left:-50+i*2,top:20+i,opacity:.4+i/100}}]
     :[{type:'delete',id:`old-${i}`},{type:'insert',zIndex:10,object:inserted}];
   const target=await project(f,changes);f.canvas.renderAll();
   assert.deepEqual(f.book._objects.map(x=>x.boardObjectId),target.notebookPages[0].map(x=>x.boardObjectId));try{canonical(f);}catch(error){error.message=`step ${i}: `+error.message;throw error;}
  }
 }finally{await f.close();}
});
test('changing text retains editability and restores the previous text footprint',async()=>{
 const f=await fixture();try{
  const text=new Textbox('hello',{boardObjectId:'text',width:70,fontSize:20,fontFamily:'Arial',fontStyle:'italic',left:-30,top:25,fill:'#537'});
  await project(f,[{type:'insert',object:text.toObject(fields)}]);text.dispose();f.canvas.renderAll();f.reset();
  await project(f,[{type:'patch',id:'text',patch:{text:'bye',left:45}}]);f.canvas.renderAll();
  assert.equal(f.book._objects.at(-1).text,'bye');assert.equal(typeof f.book._objects.at(-1).enterEditing,'function');canonical(f);
 }finally{await f.close();}
});
test('page-edge damage and unsupported global compositing fall back to full clipped rendering',async()=>{
 for(const options of [{left:-261,top:0},{globalCompositeOperation:'destination-in'}]){
  const f=await fixture();try{await project(f,[{type:'patch',id:'target',patch:options}]);f.canvas.renderAll();assert.ok(f.renders()>100,'unsafe damage bypassed canonical paint');canonical(f);}finally{await f.close();}
 }
});
test('mask-bearing children, strokeUniform and transparent background match canonical rendering',async()=>{
 const f=await fixture({book:{backgroundColor:'rgba(20,40,70,.25)',scaleX:.8,scaleY:.8},zoom:1.15});try{
  const clip=new Rect({width:17,height:20,originX:'center',originY:'center'});
  const object=ink('mask',5,5,{clipPath:clip,strokeWidth:7,strokeUniform:true,scaleX:1.2,scaleY:.8});
  await project(f,[{type:'insert',object:object.toObject(fields)}]);object.dispose();f.canvas.renderAll();
  await project(f,[{type:'patch',id:'mask',patch:{left:33,scaleX:.7}}]);f.canvas.renderAll();canonical(f);
 }finally{await f.close();}
});
test('erasing, drawing on top, undoing the eraser, and deleting new ink retain compositing order',async()=>{
 const f=await fixture({erased:true});try{
  const after=ink('after-erase',-12,-7,{stroke:'rgba(30,170,20,.65)',strokeWidth:6}).toObject(fields);
  await project(f,[{type:'insert',object:after}]);f.canvas.renderAll();canonical(f);
  await project(f,[{type:'delete',id:'eraser'}]);f.canvas.renderAll();canonical(f);
  await project(f,[{type:'delete',id:'after-erase'}]);f.canvas.renderAll();canonical(f);
 }finally{await f.close();}
});
test('cache damage failure retains vector state and discards the damaged surface for full recovery',async()=>{
 const f=await fixture();try{
  const overlay=f.book._objects.at(-1),render=overlay.render;let fail=true;
  overlay.render=function(ctx){if(fail){fail=false;ctx.save();ctx.translate(17,29);throw new Error('injected paint failure');}return render.call(this,ctx);};
  const target=await project(f,[{type:'patch',id:'target',patch:{stroke:'#971'}}]);
  assert.equal(f.book._cacheCanvas,undefined,'failed paint retained a damaged surface');
  f.canvas.renderAll();assert.deepEqual(f.book.notebookPages,target.notebookPages);canonical(f);
 }finally{await f.close();}
});
test('a stale or incomplete addressed batch cannot install only part of an operation',async()=>{
 const {notebookPageState,notebookPageChanges}=await import('../src/lib/notebookPageModel.js');
 const f=await fixture();try{
  const target={...f.book.toObject(fields)},before=f.book.notebookPages;
  applyNotebookOperation(target,op([{type:'delete',id:'target'},{type:'delete',id:'overlay'}]));
  const changes=notebookPageChanges(notebookPageState(before,0),notebookPageState(target.notebookPages,0));
  assert.equal(f.book.applyAddressedPageChanges(changes.slice(0,1),[],target.notebookPages),false,'accepted an incomplete claimed delta');
  assert.strictEqual(f.book.notebookPages,before);assert.equal(f.book._objects.length,182);
 }finally{await f.close();}
});
test('partially rendered masked children do not retain duplicate unbudgeted bitmap surfaces',async()=>{
 const f=await fixture();try{
  const object=ink('masked',0,0,{clipPath:new Rect({width:20,height:20,originX:'center',originY:'center'})});
  await project(f,[{type:'insert',object:object.toObject(fields)}]);object.dispose();f.canvas.renderAll();
  await project(f,[{type:'patch',id:'target',patch:{stroke:'#234'}}]);
  const child=f.book._objects.at(-1);assert.equal(child._cacheCanvas,undefined,'partial render retained mask child surface');
  assert.equal(child.clipPath?._cacheCanvas,undefined);f.canvas.renderAll();canonical(f);
 }finally{await f.close();}
});
test('parent-scale changes invalidate spatial bounds until the next full cache build',async()=>{
 const {currentNotebookChildIndex}=await import('../src/lib/notebookChildIndex.js');const f=await fixture();
 try{assert.ok(currentNotebookChildIndex(f.book));f.book.set({scaleX:.5,scaleY:.5});
 assert.equal(currentNotebookChildIndex(f.book),null,'retained strokeUniform bounds survived a different parent scale');
 f.book.dirty=true;f.canvas.renderAll();assert.ok(currentNotebookChildIndex(f.book));
 }finally{await f.close();}
});
