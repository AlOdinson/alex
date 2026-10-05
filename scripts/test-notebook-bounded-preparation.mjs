import test from 'node:test';
import assert from 'node:assert/strict';
import { getEnv } from 'fabric/node';
import { setEnv, Rect, classRegistry } from 'fabric';
import { BoardNotebook, createBoardNotebook, setNotebookPage, applyPageDeltaToFabric } from '../src/lib/boardNotebook.js';
import { prepareNotebookProjection } from '../src/lib/notebookProjection.js';
setEnv(getEnv());
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const made=[],freed=new Set(),gates=new Map();
let started=0;
class PreparationProbe extends Rect {
 static type='PreparationProbe';
 static async fromObject(value,options){
  started++;
  if(gates.has(value.boardObjectId))await gates.get(value.boardObjectId);
  const until=performance.now()+(value.workMs??.3);while(performance.now()<until){}
  if(value.fail)throw Error('broken child');
  const object=await Rect.fromObject(value,value.ignoreAbort?{}:options);made.push(object);
  const original=object.dispose.bind(object);object.dispose=()=>{freed.add(object);return original();};
  return object;
 }
}
classRegistry.setClass(PreparationProbe);
const records=(n,prefix='child')=>Array.from({length:n},(_,i)=>({type:'PreparationProbe',boardObjectId:`${prefix}-${i}`,width:4,height:3,fill:'black'}));
const reset=()=>{made.length=0;freed.clear();gates.clear();started=0;};
const book=()=>createBoardNotebook({boardObjectId:'book',notebookPages:[[],records(96)]});
const op=items=>({type:'notebook',version:1,id:'book',pageNumber:1,changes:items.map(object=>({type:'insert',object}))});
test('navigation yields during construction and never exposes a partly prepared page',async()=>{
 reset();const b=book();let atInput,visibleAtInput;
 const input=tick().then(()=>{atInput=started;visibleAtInput=b.getPageObjects().length;assert.equal(b.notebookPageNumber,1);});
 try{assert.equal(await setNotebookPage(b,2),true);await input;
  assert.ok(atInput>0&&atInput<96,`constructed ${atInput} children before input`);assert.equal(visibleAtInput,0);assert.equal(b.getPageObjects().length,96);
 }finally{b.dispose();}
});
test('new navigation cancels remaining stale construction and releases every detached child',async()=>{
 reset();const b=book();
 const input=tick().then(()=>setNotebookPage(b,1));
 try{assert.equal(await setNotebookPage(b,2),false);await input;
  assert.ok(started<96,`obsolete page constructed all ${started} children`);
  assert.equal(b.notebookPageNumber,1);assert.equal(b.getPageObjects().length,0);assert.equal(freed.size,made.length);
 }finally{b.dispose();}
});
test('obsolete projection stops between chunks without damaging the installed page',async()=>{
 reset();const b=book();let current=true;
 const target={...b.toObject(['boardObjectId']),notebookPageNumber:2};
 const input=tick().then(()=>{current=false;});
 try{const pending=await prepareNotebookProjection(b,target,{isCurrent:()=>current});await input;
  assert.equal(pending.isCurrent(),false);assert.equal(pending.apply(),false);pending.dispose();
  assert.ok(started<96,`obsolete projection constructed ${started} children`);assert.equal(freed.size,made.length);assert.equal(b.notebookPageNumber,1);
 }finally{b.dispose();}
});
test('incoming batch yields during child preparation and installs every record atomically',async()=>{
 reset();const b=createBoardNotebook({boardObjectId:'book'});let atInput,visibleAtInput;
 const input=tick().then(()=>{atInput=started;visibleAtInput=b.getPageObjects().length;});
 try{assert.equal((await applyPageDeltaToFabric(b,op(records(96)))).changed,true);await input;
  assert.ok(atInput>0&&atInput<96,`incoming constructed ${atInput} children before input`);assert.equal(visibleAtInput,0);
  assert.deepEqual(b.getPageObjects().map(x=>x.boardObjectId),records(96).map(x=>x.boardObjectId));
 }finally{b.dispose();}
});
test('loading a full notebook yields within its visible page rather than hydrating it all in one task',async()=>{
 reset();let atInput;const input=tick().then(()=>{atInput=started;});
 const b=await BoardNotebook.fromObject({boardObjectId:'book',notebookPages:[records(96)]});
 try{await input;assert.ok(atInput>0&&atInput<96,`load constructed ${atInput} children before input`);assert.equal(b.getPageObjects().length,96);}finally{b.dispose();}
});
test('failure in a later chunk preserves the old page and releases detached objects',async()=>{
 reset();const broken=records(96);broken[40].fail=true;const b=createBoardNotebook({boardObjectId:'book',notebookPages:[[],broken]});
 try{await assert.rejects(setNotebookPage(b,2),/broken child/);assert.equal(b.notebookPageNumber,1);assert.equal(b.getPageObjects().length,0);assert.equal(freed.size,made.length);}
 finally{b.dispose();}
});
test('independent notebook preparation is not held behind another notebook image',async()=>{
 reset();let release;gates.set('slow',new Promise(resolve=>{release=resolve;}));
 const a=createBoardNotebook({boardObjectId:'a',notebookPages:[[],[{...records(1)[0],boardObjectId:'slow'}]]}),b=book();
 let aDone=false;const work=setNotebookPage(a,2).then(result=>{aDone=true;return result;});
 try{assert.equal(await setNotebookPage(b,2),true);assert.equal(aDone,false);release();assert.equal(await work,true);}
 finally{release();await work;a.dispose();b.dispose();}
});
test('abort promptly rejects and also releases objects whose constructors finish later',async()=>{
 reset();let release;gates.set('late',new Promise(resolve=>{release=resolve;}));
 const b=createBoardNotebook({boardObjectId:'book',notebookPages:[[],[{...records(1)[0],boardObjectId:'late',ignoreAbort:true}]]});
 const ac=new AbortController(),work=setNotebookPage(b,2,{signal:ac.signal});
 try{
  await tick();ac.abort();await assert.rejects(work,e=>e.name==='AbortError');
  release();await tick();await tick();assert.equal(freed.size,made.length);assert.ok(made.length>0);
  assert.equal(b.notebookPageNumber,1);assert.equal(b.getPageObjects().length,0);
 }finally{release();b.dispose();}
});
test('target-page edits during a yield are included by the guarded navigation retry',async()=>{
 reset();const b=book();const input=tick().then(()=>applyPageDeltaToFabric(b,{...op(records(1,'arrived')),pageNumber:2}));
 try{assert.equal(await setNotebookPage(b,2),true);await input;
  assert.equal(b.getPageObjects().length,97);assert.equal(b.getPageObjects().at(-1).boardObjectId,'arrived-0');
 }finally{b.dispose();}
});
test('a rejected incoming batch does not block a later valid operation on the same page',async()=>{
 reset();const b=createBoardNotebook({boardObjectId:'book'}),broken=records(30);broken[15].fail=true;
 const failed=applyPageDeltaToFabric(b,op(broken)),good=applyPageDeltaToFabric(b,op(records(1,'good')));
 try{await assert.rejects(failed,/broken child/);assert.equal((await good).changed,true);
  assert.deepEqual(b.getPageObjects().map(x=>x.boardObjectId),['good-0']);
 }finally{b.dispose();}
});
test('failed full-notebook restoration disposes constructed children instead of returning an incomplete notebook',async()=>{
 reset();const broken=records(30);broken[17].fail=true;
 await assert.rejects(BoardNotebook.fromObject({boardObjectId:'book',notebookPages:[broken]}),/broken child/);
 assert.equal(freed.size,made.length);
});
test('one ordinary child does not force an extra task before page navigation finishes',async()=>{
 const b=createBoardNotebook({boardObjectId:'book',notebookPages:[[],[{type:'Rect',width:3,height:3}]]});let timer=false;
 const input=tick().then(()=>{timer=true;});
 try{assert.equal(await setNotebookPage(b,2),true);assert.equal(timer,false);}finally{b.dispose();await input;}
});
test('abort during an asynchronous reviver rejects promptly and releases owned children',async()=>{
 const {enlivenNotebookObjects}=await import('../src/lib/notebookObjectPreparation.js');reset();
 let release;const wait=new Promise(resolve=>{release=resolve;}),ac=new AbortController();let outcome;
 const work=enlivenNotebookObjects(records(1),{signal:ac.signal,reviver:()=>wait}).then(()=>{outcome='success';},e=>{outcome=e.name;});
 try{await tick();ac.abort();await tick();assert.equal(outcome,'AbortError');assert.equal(freed.size,made.length);}
 finally{release();await work;}
});
test('an aborted asynchronous fallback is disposed even if it resolves after cancellation',async()=>{
 const {enlivenNotebookObjects}=await import('../src/lib/notebookObjectPreparation.js');reset();
 let release;const wait=new Promise(resolve=>{release=resolve;}),ac=new AbortController();let outcome,disposed=false;
 const fallback=new Rect({width:3,height:4}),dispose=fallback.dispose.bind(fallback);fallback.dispose=()=>{disposed=true;dispose();};
 const work=enlivenNotebookObjects([{...records(1)[0],fail:true}],{signal:ac.signal,reviver:async()=>{await wait;return fallback;}}).then(()=>{outcome='success';},e=>{outcome=e.name;});
 try{await tick();ac.abort();await tick();assert.equal(outcome,'AbortError');}
 finally{release();await work;await tick();}
 assert.equal(disposed,true);
});
