// CPU stages only: no canvas, network or persistence. The browser real-input
// suite is separate and must still pass; these numbers are not pen latency.
import {createNotebookSession} from '../src/lib/notebookSession.js';
const baseline={version:2,background:'blank',canvas:{objects:[]}};
const pending=()=>new Promise(()=>{});
const percentile=(values,p)=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*p)-1];
const results=[];
for(const count of [0,1000,5000]){
 const snapshot={...baseline,canvas:{objects:[
  ...Array.from({length:count},(_,i)=>({boardObjectId:`other-${i}`,type:'Path',left:i,path:[['M',0,0],['L',3,2]]})),
  {boardObjectId:'book',type:'BoardNotebook',notebookPages:[[]],notebookPageNumber:1},
 ]}};
 const samples=[];
 for(let repeat=0;repeat<3;repeat++){
  const s=createNotebookSession({confirmedState:{snapshot,revision:0},publish:pending});s.pause();
  for(let i=0;i<80;i++){
   const actionId=`a${i}`;
   const op={type:'notebook',version:1,id:'book',pageNumber:1,updatedAt:i,updatedBy:'writer',atomicGroup:actionId,
    changes:[{type:'insert',object:{type:'Path',boardObjectId:`child-${i}`,path:[['M',0,0],['L',5,2]]},zIndex:i,ifAbsent:true}]};
   const deletion={type:'delete',id:`source-${i}`,atomicGroup:actionId,mutationId:actionId};
   let start=performance.now();s.enqueue({actionId,ops:[op,deletion]});const enqueueMs=performance.now()-start;
   const {ifAbsent,...change}=op.changes[0];start=performance.now();
   s.ack({actionId,clientId:'writer',revision:i+1,ops:[{...op,changes:[change]},deletion],changed:true});
   const ackMs=performance.now()-start;
   if(i>=16)samples.push({enqueueMs,ackMs});
  }
  s.dispose();
 }
 results.push({boardObjects:count,samples:samples.length,enqueueP50:percentile(samples.map(s=>s.enqueueMs),.5),
  enqueueP95:percentile(samples.map(s=>s.enqueueMs),.95),ackP50:percentile(samples.map(s=>s.ackMs),.5),ackP95:percentile(samples.map(s=>s.ackMs),.95)});
}
console.log(JSON.stringify({runtime:process.version,results,limitations:['CPU model only','short child paths','80 source tombstones, not a long lesson','no rendering/storage/network']},null,2));
