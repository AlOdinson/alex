import { StaticCanvas, Rect, classRegistry } from 'fabric';
import { loadBoardCanvasJson, cancelBoardCanvasLoad } from '../src/lib/boardLoadPreparation.js';
import { createBoardNotebook } from '../src/lib/boardNotebook.js';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const requireValue=(ok,message)=>{if(!ok)throw Error(message);};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const ids=c=>c.getObjects().map(o=>o.boardObjectId);
const rect=id=>({type:'Rect',boardObjectId:id,left:10,top:10,width:12,height:12,fill:'black'});
const make=()=>new StaticCanvas(null,{width:180,height:150,enableRetinaScaling:false,renderOnAddRemove:true});
const pixels=c=>new Uint8Array(c.getContext().getImageData(0,0,c.width,c.height).data);
const errorOf=task=>task.then(()=>null,error=>error);

export async function runBoardStartupCases() {
 const results=[];
 const run=async(name,work)=>{try{results.push({name,...await work()});}catch(error){results.push({name,error:error.stack??error.message});}};
 await run('bounded real constructors and coherent old scene',async()=>{
  const c=make();c.add(new Rect({width:1,height:1,boardObjectId:'old'}));c.cancelRequestedRender();let count=0,atInput=null,oldAtInput;
  class NativeStartupProbe extends Rect {static type='NativeStartupProbe';static fromObject(value,options){
   count++;if(count===1)setTimeout(()=>{atInput=count;oldAtInput=ids(c);},0);
   const until=performance.now()+.6;while(performance.now()<until){}
   return super.fromObject(value,options);
  }}
  classRegistry.setClass(NativeStartupProbe);
  try{await loadBoardCanvasJson(c,{objects:Array.from({length:96},(_,i)=>({...rect(`r-${i}`),type:'NativeStartupProbe'}))});await sleep(0);
   requireValue(atInput>=1&&atInput<96,`input waited for ${atInput} / 96 constructors`);
   requireValue(same(oldAtInput,['old']),'old scene changed during detached preparation');
   requireValue(c._objects.length===96,'incomplete load');return{total:96,constructedBeforeInput:atInput,oldScenePreserved:true};
  }finally{await c.dispose();}
 });
 await run('failed object preserves old scene',async()=>{
  const c=make();c.add(new Rect({width:1,height:1,boardObjectId:'old'}));c.cancelRequestedRender();
  class NativeStartupFailure extends Rect {static type='NativeStartupFailure';static async fromObject(){throw Error('deliberate startup failure');}}
  classRegistry.setClass(NativeStartupFailure);
  try{const error=await errorOf(loadBoardCanvasJson(c,{objects:[{...rect('bad'),type:'NativeStartupFailure'}]}));
   requireValue(error?.message==='deliberate startup failure','failed object was silently omitted');
   requireValue(same(ids(c),['old'])&&c.renderOnAddRemove===true,'scene/render policy changed');return{oldScenePreserved:true};
  }finally{await c.dispose();}
 });
 await run('supersession releases late objects',async()=>{
  const c=make();let finish,disposed=0;
  class NativeStartupSlow extends Rect {static type='NativeStartupSlow';static fromObject(){return new Promise(resolve=>{finish=()=>{
    const object=new Rect({width:1,height:1});object.dispose=()=>{disposed++;};resolve(object);
  };});}}
  classRegistry.setClass(NativeStartupSlow);
  try{const prior=errorOf(loadBoardCanvasJson(c,{objects:[{...rect('old'),type:'NativeStartupSlow'}]}));
   await loadBoardCanvasJson(c,{objects:[rect('new')]});const error=await prior;finish();await sleep(0);
   requireValue(error?.code==='notebook_work_cancelled'&&disposed===1&&same(ids(c),['new']),'obsolete scene installed or leaked');return{lateDisposals:disposed};
  }finally{await c.dispose();}
 });
 await run('explicit cancellation keeps old content',async()=>{
  const c=make();c.add(new Rect({width:1,height:1,boardObjectId:'old'}));let finish,disposed=0;
  class NativeStartupCancel extends Rect {static type='NativeStartupCancel';static fromObject(){return new Promise(resolve=>{finish=()=>{
   const object=new Rect({width:1,height:1});object.dispose=()=>{disposed++;};resolve(object);
  };});}}
  classRegistry.setClass(NativeStartupCancel);
  try{const loading=errorOf(loadBoardCanvasJson(c,{objects:[{...rect('pending'),type:'NativeStartupCancel'}]}));
   cancelBoardCanvasLoad(c);const error=await loading;finish();await sleep(0);
   requireValue(error?.code==='notebook_work_cancelled'&&disposed===1&&same(ids(c),['old']),'cancel failed');return{oldScenePreserved:true};
  }finally{await c.dispose();}
 });
 await run('image placeholders preserve layer order and source',async()=>{
  const c=make(), source={objects:[rect('first'),{type:'Image',boardObjectId:'image',src:'https://unreachable.invalid/no-fetch'},rect('last')]};
  try{const before=JSON.stringify(source);const pending=await loadBoardCanvasJson(c,source,{imagePayload:x=>x.type==='Image'?x:null,
   createPlaceholder:x=>new Rect({width:10,height:10,boardObjectId:x.boardObjectId,pendingImageSerialized:x})});
   requireValue(pending===1&&same(ids(c),['first','image','last'])&&JSON.stringify(source)===before,'source/order mismatch');
   requireValue(c._objects[1].pendingImageSerialized===source.objects[1],'image source missing');return{pendingImages:pending};
  }finally{await c.dispose();}
 });
 await run('background overlay clip and object pixels match canonical',async()=>{
  const a=make(),b=make();const source={objects:[rect('one'),{...rect('two'),left:16,fill:'rgba(20,80,90,.5)'}],
   background:'rgb(245,245,245)',overlay:'rgba(160,30,20,.1)',clipPath:{type:'Rect',left:5,top:5,width:100,height:100,fill:'black'}};
  try{await a.loadFromJSON(source);await loadBoardCanvasJson(b,source);a.renderAll();b.renderAll();const x=pixels(a),y=pixels(b);let mismatch=0;
   for(let i=0;i<x.length;i++)if(x[i]!==y[i])mismatch++;
   requireValue(mismatch===0,`pixel mismatch ${mismatch}`);return{pixelMismatch:mismatch};
  }finally{await a.dispose();await b.dispose();}
 });
 await run('old notebook hidden pages remain serialized',async()=>{
  const c=make(),pages=Array.from({length:6},(_,p)=>Array.from({length:20},(_,i)=>rect(`page-${p}-${i}`)));
  const book=createBoardNotebook({boardObjectId:'book',notebookPages:pages,notebookPageNumber:6});
  const source=book.toObject(['boardObjectId']);book.dispose();
  try{await loadBoardCanvasJson(c,{objects:[source]});const b=c._objects[0];
   requireValue(b.notebookPages.length===6&&b._objects.length===20&&b.notebookPageNumber===6,'hidden pages eagerly attached or lost');
   requireValue(same(b.notebookPages,source.notebookPages),'page data changed');return{pages:6,liveChildren:20};
  }finally{await c.dispose();}
 });
 return results;
}
