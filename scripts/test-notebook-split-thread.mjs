import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {runNotebookVectorSplit} from '../src/lib/notebookSplitWorkerClient.js';
import {splitVectorPaintsTask} from '../src/lib/notebookSplitGeometryCore.js';
const payload={commands:[['style','strokeStyle','red'],['style','lineWidth',9],['style','lineCap','round'],['beginPath'],['moveTo',20,150],['bezierCurveTo',90,10,260,360,380,150],['stroke']],page:[[{x:100,y:100},{x:300,y:100},{x:300,y:300},{x:100,y:300}]],matrix:[1,0,0,1,0,0],tolerance:.01};
function facade(){
 const worker=new Worker(new URL('./fixtures/notebook-node-split-worker.mjs',import.meta.url));
 const target={postMessage:value=>worker.postMessage(value),terminate:()=>worker.terminate()};
 worker.on('message',data=>target.onmessage?.({data}));worker.on('error',error=>target.onerror?.(error));
 return target;
}
test('the real isolated worker computes canonical curve geometry while input task runs',async()=>{
 const order=[];const pending=runNotebookVectorSplit(payload,{workerFactory:facade}).then(rows=>{order.push('geometry');return rows;});
 setTimeout(()=>order.push('input-task'),0);
 const rows=await pending;assert.deepEqual(rows,splitVectorPaintsTask(payload));assert.equal(order[0],'input-task');
});
test('the real worker can be terminated and a subsequent split still succeeds',async()=>{
 const controller=new AbortController();const pending=runNotebookVectorSplit(payload,{workerFactory:facade,signal:controller.signal});controller.abort();
 await assert.rejects(pending,{name:'AbortError'});assert.deepEqual(await runNotebookVectorSplit(payload,{workerFactory:facade}),splitVectorPaintsTask(payload));
});
