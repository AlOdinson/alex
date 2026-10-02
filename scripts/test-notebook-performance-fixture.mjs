import test from 'node:test';
import assert from 'node:assert/strict';
import {getEnv} from 'fabric/node';
import {setEnv} from 'fabric';
setEnv(getEnv());
globalThis.document=getEnv().document;globalThis.devicePixelRatio=1;
const {BoardNotebook}=await import('../src/lib/boardNotebook.js');
const {benchmarkNotebooks}=await import('./notebook-performance-fixture.js');
test('incremental fixture measures the session path rather than a full notebook patch',async()=>{
 const load=BoardNotebook.fromObject;
 BoardNotebook.fromObject=async(...args)=>{assert.ok(args[0].notebookPages[0].length<=3,'fixture must respect requested stroke counts');return load.apply(BoardNotebook,args);};
 let report;try{report=await benchmarkNotebooks({incremental:true,pageCounts:[1,20],strokeCounts:[3],repeats:1});}finally{BoardNotebook.fromObject=load;}
 const rows=report.results.filter(r=>r.scenario.pages);
 assert.equal(rows.length,2);
 for(const row of rows){assert.equal(row.mode,'incremental-session');assert.ok(row.forwardBytes<=16384);assert.ok(row.inverseBytes<=16384);assert.equal(row.hiddenPageChanges,0);assert.equal(row.pendingActions,1);assert.ok(row.childSerializationVisits<=2);}
 assert.ok(rows[1].forwardBytes/rows[0].forwardBytes<=1.05);
 assert.ok(rows[1].inverseBytes/rows[0].inverseBytes<=1.05);
 assert.equal(report.results.find(r=>r.scenario.images).imageEncodes,0);
});
