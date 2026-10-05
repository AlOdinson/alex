import { queueNotebookWork } from '../src/lib/notebookWorkScheduler.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { callback } from './notebook-ui-node-harness.mjs';
const ref = current => ({current});
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const burn = () => { const until=performance.now()+6; while(performance.now()<until) {} };
function fixture() {
  const errors=[],lease=[];
  const canvas={ getActiveObject:()=> 'selected' };
  const scope={queueNotebookWork,notebookQueueRef:ref(Promise.resolve()),notebookMutationActiveRef:ref(false),
    notebookControllerEpochRef:ref(0),fabricCanvasRef:ref(canvas),boardReadyRef:ref(true),
    acquireLocalSelectionLease:o=>lease.push(o),setSaveStatus:e=>errors.push(e),setSyncTone:()=>{}};
  return {scope,errors,lease,queue:callback('queueNotebookMutation',scope)};
}
test('actual Board queue lets an input task run between heavy resolved jobs without losing gesture order',async()=>{
  const f=fixture(),seen=[]; let seenAtInput,activeAtInput;
  const input=tick().then(()=>{seenAtInput=seen.length;activeAtInput=f.scope.notebookMutationActiveRef.current;});
  const jobs=Array.from({length:4},(_,i)=>f.queue(async()=>{await Promise.resolve();burn();seen.push(i);return i;}));
  assert.deepEqual(await Promise.all(jobs),[0,1,2,3]); await input;
  assert.ok(seenAtInput>0 && seenAtInput<4,`all ${seenAtInput} jobs blocked input`);
  assert.equal(activeAtInput,false); assert.deepEqual(seen,[0,1,2,3]);assert.equal(f.lease.length,4);
  await f.scope.notebookQueueRef.current;
});
test('short Board queue job still completes before a timer and exposes the original result',async()=>{
 const f=fixture();let timer=false; const input=tick().then(()=>{timer=true;});
 assert.equal(await f.queue(async()=>17),17);assert.equal(timer,false);assert.equal(f.scope.notebookMutationActiveRef.current,false);await input;
});
test('failed preparation does not poison the page-turn barrier or leave mutation active',async()=>{
 const f=fixture(),seen=[];const error=new Error('preparation rejected');
 const first=f.queue(async()=>{burn();seen.push('stroke');throw error;});
 const next=f.queue(async()=>{seen.push('page-turn');return 'page2';});
 await assert.rejects(first,error);assert.equal(await next,'page2');await f.scope.notebookQueueRef.current;
 assert.deepEqual(seen,['stroke','page-turn']);assert.equal(f.scope.notebookMutationActiveRef.current,false);
});
test('closing the board during a yield cancels unstarted jobs without running them on another canvas',async()=>{
 const f=fixture(),seen=[];const input=tick().then(()=>{f.scope.notebookControllerEpochRef.current++;f.scope.fabricCanvasRef.current=null;});
 const jobs=[f.queue(async()=>{burn();seen.push('started');}),f.queue(async()=>{seen.push('stale');})];
 const settled=await Promise.allSettled(jobs);await input;
 assert.deepEqual(seen,['started']);assert.equal(settled[1].status,'rejected');
 assert.equal(f.scope.notebookMutationActiveRef.current,false);
});
test('I/O wait does not force another idle timer before the next short job',async()=>{
 const f=fixture();let afterIO=false;
 const first=f.queue(()=>new Promise(resolve=>setTimeout(()=>{setTimeout(()=>{afterIO=true;},0);resolve('image');},20)));
 const second=f.queue(()=>{assert.equal(afterIO,false);return 'stroke';});
 assert.deepEqual(await Promise.all([first,second]),['image','stroke']);await tick();
});
