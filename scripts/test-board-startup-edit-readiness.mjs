import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseSync } from 'rolldown/experimental';
import { callback } from './notebook-ui-node-harness.mjs';
const source=fs.readFileSync(new URL('../src/components/Board.jsx',import.meta.url),'utf8');
const nodes=[];function visit(n){if(!n||typeof n!=='object')return;if(n.type)nodes.push(n);for(const v of Object.values(n))if(v&&typeof v==='object'){if(Array.isArray(v))v.forEach(visit);else visit(v);}}
visit(parseSync('Board.jsx',source).program);
const evaluate=(n,scope)=>new Function('scope',`with(scope){return (${source.slice(n.start,n.end)});}`)(scope);
const ref=current=>({current});

test('rendered edit capability requires both connected runtime and installed initial scene',()=>{
 const expression=nodes.find(n=>n.type==='VariableDeclarator'&&n.id?.name==='canEdit'&&n.init?.type==='LogicalExpression').init;
 for(const permission of ['owner','edit']){
  assert.equal(evaluate(expression,{permission,runtimeReady:true,sceneReady:false}),false,'toolbar admitted editing before scene installation');
  assert.equal(evaluate(expression,{permission,runtimeReady:true,sceneReady:true}),true);
  assert.equal(evaluate(expression,{permission,runtimeReady:false,sceneReady:true}),false);
 }
 assert.equal(evaluate(expression,{permission:'view',runtimeReady:true,sceneReady:true}),false);
});

test('actual runtime readiness callback cannot admit editing ahead of scene installation',async()=>{
 const n=nodes.find(n=>n.type==='VariableDeclarator'&&n.id?.name==='update'&&n.init?.type==='ArrowFunctionExpression'&&source.slice(n.start,n.end).includes('runtimeReadyRef.current = ready'));
 const scope={boardId:'board',permission:'owner',stateGeneration:0,restoringReading:false,
  studentDocumentReaderRef:ref(null),canEditRef:ref(false),canReadDocumentsRef:ref(false),
  resumeToolRef:ref('pencil'),activeToolRef:ref('pencil'),runtimeReadyRef:ref(false),viewedSnapshotRef:ref(false),
  boardReadyRef:ref(false),fabricCanvasRef:ref(null),setRuntimeReady(){},setSaveStatus(){},setSyncTone(){},applyObjectInteractivity(){},configureBrushAndMode(){}};
 const update=evaluate(n.init,scope);await update({boardId:'board',state:'ready'});
 assert.equal(scope.canEditRef.current,false,'synchronous runtime callback bypassed initial-scene readiness');
 scope.boardReadyRef.current=true;await update({boardId:'board',state:'ready'});assert.equal(scope.canEditRef.current,true);
 await update({boardId:'board',state:'offline'});assert.equal(scope.canEditRef.current,false);
});

test('remote edit permission cannot bypass the same initial scene readiness fence',()=>{
 const scope={isOwner:false,initialAccess:{},runtimeReadyRef:ref(true),boardReadyRef:ref(false),canEditRef:ref(false),activeToolRef:ref('select'),cancelCreationDraftRef:ref(null),
 setGuestModeState(){},onAccessChange(){},setPermission(){},activateDrawingStyle(){},setToolState(){},applyObjectInteractivity(){},configureBrushAndMode(){}};
 const change=callback('handleRemoteMode',scope);change('edit');assert.equal(scope.canEditRef.current,false,'remote mode enabled early edits');
 scope.boardReadyRef.current=true;change('edit');assert.equal(scope.canEditRef.current,true);
 change('view');assert.equal(scope.canEditRef.current,false);
});
