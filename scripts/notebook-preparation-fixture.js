import { Rect, classRegistry } from 'fabric';
import { BoardNotebook, createBoardNotebook, setNotebookPage, applyPageDeltaToFabric } from '../src/lib/boardNotebook.js';
import { prepareNotebookProjection } from '../src/lib/notebookProjection.js';
import { queueNotebookWork } from '../src/lib/notebookWorkScheduler.js';

// Deliberate small CPU units establish event-loop ordering, not pen latency.
const check=(ok,message)=>{if(!ok)throw Error(message);};
const task=()=>new Promise(resolve=>setTimeout(resolve,0));
const burn=ms=>{const until=performance.now()+ms;while(performance.now()<until){}};
export async function runNotebookPreparationCases() {
 const results=[],made=[],freed=new Set(),gates=new Map();let started=0;
 class PreparationBrowserProbe extends Rect {
  static type='PreparationBrowserProbe';
  static async fromObject(value,options){
   started++;if(gates.has(value.boardObjectId))await gates.get(value.boardObjectId);burn(.5);
   if(value.fail)throw Error('broken child');
   const object=await Rect.fromObject(value,value.ignoreAbort?{}:options);made.push(object);
   const dispose=object.dispose.bind(object);object.dispose=()=>{freed.add(object);return dispose();};return object;
  }
 }
 classRegistry.setClass(PreparationBrowserProbe);
 const records=n=>Array.from({length:n},(_,i)=>({type:'PreparationBrowserProbe',boardObjectId:`child-${i}`,width:4,height:3,fill:'black'}));
 const book=()=>createBoardNotebook({boardObjectId:'book',notebookPages:[[],records(96)]});
 const delta=items=>({type:'notebook',version:1,id:'book',pageNumber:1,changes:items.map(object=>({type:'insert',object}))});
 const run=async(name,fn)=>{made.length=0;freed.clear();gates.clear();started=0;try{results.push({name,...await fn()});}catch(error){results.push({name,error:error.message});}};
 await run('ordered mutation jobs yield to input',async()=>{
  const seen=[];let atInput;const input=task().then(()=>{atInput=seen.length;});let tail=Promise.resolve();
  const jobs=Array.from({length:4},(_,i)=>tail=queueNotebookWork(tail,async()=>{await Promise.resolve();burn(6);seen.push(i);return i;}));
  await Promise.all(jobs);await input;check(atInput>0&&atInput<4,'mutation input starved');check(seen.join(',')==='0,1,2,3','mutation order changed');
  return{jobsBeforeInput:atInput,completed:seen.length};
 });
 await run('navigation keeps original page until atomic install',async()=>{
  const b=book();let atInput,visible,page;const input=task().then(()=>{atInput=started;visible=b._objects.length;page=b.notebookPageNumber;});
  try{check(await setNotebookPage(b,2),'navigation failed');await input;check(atInput>0&&atInput<96,'navigation starved input');check(visible===0&&page===1,'partly installed page');check(b._objects.length===96,'missing child');return{constructedBeforeInput:atInput,children:b._objects.length};}finally{b.dispose();}
 });
 await run('stale navigation abandons and releases detached construction',async()=>{
  const b=book();const input=task().then(()=>setNotebookPage(b,1));
  try{check(await setNotebookPage(b,2)===false,'obsolete page won');await input;check(started<96,'obsolete work completed unnecessarily');check(freed.size===made.length,'detached objects leaked');check(b.notebookPageNumber===1,'page changed');return{constructed:started,disposed:freed.size};}finally{b.dispose();}
 });
 await run('obsolete projection releases partial construction',async()=>{
  const b=book();let current=true;const input=task().then(()=>{current=false;});
  try{const work=await prepareNotebookProjection(b,{...b.toObject(['boardObjectId']),notebookPageNumber:2},{isCurrent:()=>current});await input;check(work.apply()===false,'obsolete projection installed');work.dispose();check(started<96&&freed.size===made.length,'obsolete preparation leaked');return{constructed:started,disposed:freed.size};}finally{b.dispose();}
 });
 await run('incoming batch yields but installs in exact operation order',async()=>{
  const b=createBoardNotebook({boardObjectId:'book'});let atInput,visible;const input=task().then(()=>{atInput=started;visible=b._objects.length;});
  try{check((await applyPageDeltaToFabric(b,delta(records(96)))).changed,'delta failed');await input;check(atInput>0&&atInput<96&&visible===0,'delta input/atomicity failed');check(b._objects.map(x=>x.boardObjectId).join(',')===records(96).map(x=>x.boardObjectId).join(','),'wire order changed');return{constructedBeforeInput:atInput,children:b._objects.length};}finally{b.dispose();}
 });
 await run('full notebook restoration yields within the visible page',async()=>{
  let atInput;const input=task().then(()=>{atInput=started;});const b=await BoardNotebook.fromObject({boardObjectId:'book',notebookPages:[records(96)]});
  try{await input;check(atInput>0&&atInput<96,'restoration blocked input');check(b._objects.length===96,'restoration missing children');return{constructedBeforeInput:atInput,children:b._objects.length};}finally{b.dispose();}
 });
 await run('failure leaves old page intact and frees prepared objects',async()=>{
  const data=records(96);data[40].fail=true;const b=createBoardNotebook({boardObjectId:'book',notebookPages:[[],data]});let error;
  try{try{await setNotebookPage(b,2);}catch(e){error=e;}check(error?.message==='broken child','construction error swallowed');check(b.notebookPageNumber===1&&b._objects.length===0,'partial page installed on failure');check(freed.size===made.length,'failed work leaked');return{constructed:started,disposed:freed.size};}finally{b.dispose();}
 });
 await run('abort frees late constructors without attaching them',async()=>{
  let release;gates.set('late',new Promise(resolve=>{release=resolve;}));const b=createBoardNotebook({boardObjectId:'book',notebookPages:[[],[{...records(1)[0],boardObjectId:'late',ignoreAbort:true}]]});const ac=new AbortController();
  const work=setNotebookPage(b,2,{signal:ac.signal});let error;
  try{await task();ac.abort();try{await work;}catch(e){error=e;}check(error?.name==='AbortError','abort was not propagated');release();await task();await task();check(made.length>0&&made.length===freed.size,'late object leaked');check(b._objects.length===0,'late object attached');return{disposed:freed.size};}finally{release();b.dispose();}
 });
 await run('independent notebook is not blocked by a pending image',async()=>{
  let release;gates.set('slow',new Promise(resolve=>{release=resolve;}));const a=createBoardNotebook({boardObjectId:'a',notebookPages:[[],[{...records(1)[0],boardObjectId:'slow'}]]}),b=book();let done=false;const work=setNotebookPage(a,2).then(x=>{done=true;return x;});
  try{check(await setNotebookPage(b,2),'independent page failed');check(!done,'slow image unexpectedly resolved');release();check(await work,'slow image was lost');return{independentPageCompleted:true};}finally{release();await work;a.dispose();b.dispose();}
 });
 return results;
}
