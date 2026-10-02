import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const source=fs.readFileSync(new URL('../src/components/Board.jsx',import.meta.url),'utf8');
function callback(name,scope){scope={notebookRuntimeEnabled:false,incrementalNotebookActions:{},...scope};const start=source.indexOf(`  const ${name} = useCallback(`);const end=source.indexOf('\n\n  const ',start+1);return new Function('scope',`with(scope){${source.slice(start,end)};return ${name};}`)(scope);}
test('page hydration must not publish after its notebook lease expires',async()=>{
 let granted=true,published=0;
 const notebook={notebookPageNumber:1,boardObjectId:'book'};
 const canvas={getActiveObject:()=>notebook,getObjects:()=>[notebook],requestRenderAll(){}};
 const scope={useCallback:fn=>fn,queueNotebookMutation:fn=>fn(),fabricCanvasRef:{current:canvas},canEditRef:{current:true},
 isBoardNotebook:o=>o===notebook,acquireLocalSelectionLease:async()=>true,ownsSelectionLease:()=>granted,
 setNotebookBusy(){},getObjectRecords:()=>[{object:{boardObjectId:'book'},zIndex:0}],
 setNotebookPage:async()=>{granted=false;notebook.notebookPageNumber=2;return true;},
 markObject(){},clientIdRef:{current:'teacher'},updatePdfControls(){},
 sendRecordPatches:async()=>{published++},commitNotebookOps:async()=>{published++},
 createConditionalRecordPatchOps:()=>[],syncFromServer:async()=>{},
 };
 if(source.includes('  const assertNotebookLease = useCallback('))scope.assertNotebookLease=callback('assertNotebookLease',scope);
 await assert.rejects(callback('changeNotebookPage',scope)(2), /блокировка истекла/);
 assert.equal(published,0);
});
test('rejected notebook publication reconciles instead of reporting saved', async()=>{
 let repairs=0;
 const scope={useCallback:fn=>fn,sendDurableOps:async()=>[{rejectedObjectIds:['book']}],syncFromServer:async()=>{repairs++}};
 await assert.rejects(callback('commitNotebookOps',scope)([{type:'patch',id:'book',patch:{}}]),/другим участником/);
 assert.equal(repairs,1);
});
