// CPU-only reducer pipeline; no browser, raster, network, storage or physical pen.
import { performance } from 'node:perf_hooks';
import { applyNotebookOperation, evaluateNotebookOperation, invertNotebookOperation } from '../src/lib/notebookOperations.js';
import { freezeNotebookRecord } from '../src/lib/notebookRecords.js';
const child = id => ({type:'Path',boardObjectId:id,path:[['M',0,0],['L',10,4]],left:0,stroke:'black'});
const operation = (changes, tick = 1) => ({type:'notebook',version:1,id:'book',pageNumber:1,updatedAt:tick,updatedBy:'writer',changes});
const quantile=(values,q)=>[...values].sort((a,b)=>a-b)[Math.min(values.length-1,Math.floor(values.length*q))];
const output=[];
for(const count of [100,1000,5000,10000]) {
  for(const type of ['insert','patch','delete']) {
    const notebook={type:'BoardNotebook',boardObjectId:'book',notebookPageNumber:1,
      notebookPages:freezeNotebookRecord([Array.from({length:count},(_,i)=>child(`old-${i}`))])};
    evaluateNotebookOperation(notebook,operation([{type:'insert',object:child('old-0')} ])); // owned load/index warmup
    const times=[];
    for(let i=0;i<64;i++) {
      const change=type==='insert'?{type,object:child(`new-${i}`)}:type==='patch'?{type,id:`old-${i}`,patch:{left:i+10}}:{type,id:`old-${i}`};
      const op=operation([change],i+2),before={...notebook},context={clientId:'writer',actionId:`a-${i}`};
      const start=performance.now();
      const checked=evaluateNotebookOperation(notebook,op,{},context);
      if(!checked.changed)throw new Error('Benchmark action was not applied');
      const accepted={...op,changes:checked.appliedChanges};applyNotebookOperation(notebook,accepted);
      const undo=invertNotebookOperation(before,accepted,{...context,afterState:notebook});
      if(!undo.length)throw new Error('Benchmark inverse was not prepared');
      const elapsed=performance.now()-start;
      if(i>=16)times.push(elapsed);
    }
    output.push({initialChildren:count,operation:type,samples:times.length,medianMs:quantile(times,.5),p95Ms:quantile(times,.95)});
  }
}
console.log(JSON.stringify({scope:'warm CPU evaluate + apply + inverse, sequential edits; not browser or physical pen latency',node:process.version,results:output},null,2));
