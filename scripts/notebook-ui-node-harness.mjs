/** Executes actual Board callback bodies with Fabric/Node-canvas and real authority.
 * No browser navigation, device emulation, video decoder, or claimed browser E2E.
 */
import fs from 'node:fs';
import { parseSync } from 'rolldown/experimental';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import { getEnv } from 'fabric/node';
import { setEnv, Canvas, ActiveSelection, util } from 'fabric';
import { isBoardMedia, MEDIA_OBJECT_FIELDS } from '../src/lib/boardMediaRuntime.js';
import { BoardNotebook, NOTEBOOK_FIELDS, isBoardNotebook, notebookObjectIntersection } from '../src/lib/boardNotebook.js';
import { createNotebookBoardActions } from '../src/lib/notebookBoardActions.js';
import { createNotebookBoardController } from '../src/lib/notebookBoardController.js';
import { createNotebookCommitBridge } from '../src/lib/notebookCommitBridge.js';
import { createNotebookOutbox } from '../src/lib/browserAuthorityStore.js';
import { prepareNotebookProjection } from '../src/lib/notebookProjection.js';
import { stageNotebookVisualOperations } from '../src/lib/notebookVisualBatch.js';
import { operationObjectIds, applySerializedObjectPatch } from '../src/lib/operationProtocol.js';
import { applyNotebookOperation } from '../src/lib/notebookOperations.js';
import { openBrowserBoardAuthority } from '../src/lib/browserBoardAuthority.js';
import { createBrowserAuthorityRealtimeCore } from '../src/lib/browserAuthorityRealtimeCore.js';
import { snapshotNotebookGesturePages,bindNotebookGestureTarget,consumeNotebookGesturePage } from '../src/lib/notebookGestureTarget.js';
import { randomToken } from '../src/lib/ids.js';
setEnv(getEnv());globalThis.indexedDB=indexedDB;globalThis.IDBKeyRange=IDBKeyRange;
const source=fs.readFileSync(new URL('../src/components/Board.jsx',import.meta.url),'utf8');
const ref=current=>({current});
export const fields=['boardObjectId','updatedAt','updatedBy','isEraserPath','objectKind','storagePath','creationSessionId','creationClientId'];
export const serialized=object=>object.toObject(fields);
// Parse the production callback expressions. Text delimiters fail for concise
// callbacks and can accidentally capture a later dependency array/declaration.
const parsed=parseSync('Board.jsx',source);
if(parsed.errors.length)throw new Error(JSON.stringify(parsed.errors));
const nodes=[];
function visit(node){if(!node||typeof node!=='object')return;if(node.type)nodes.push(node);
 for(const value of Object.values(node))if(value&&typeof value==='object'){
  if(Array.isArray(value))value.forEach(visit);else visit(value);
 }}
visit(parsed.program);
function callback(name,scope) {
 const node=nodes.find(node=>node.type==='VariableDeclarator'&&node.id?.name===name&&node.init?.callee?.name==='useCallback');
 const expression=node?.init?.arguments?.[0];
 if(!expression)throw new Error(`Missing Board callback ${name}`);
 return new Function('scope',`with(scope){return (${source.slice(expression.start,expression.end)});}`)(scope);
}
function globalFunction(name,scope){const node=nodes.find(node=>node.type==='FunctionDeclaration'&&node.id?.name===name);if(!node)throw Error(`Missing Board function ${name}`);return new Function('scope',`with(scope){${source.slice(node.start,node.end)};return ${name};}`)(scope);}
function onCommit(scope){const node=nodes.find(node=>node.type==='Property'&&node.method&&node.key?.name==='onCommit');if(!node)throw Error('Missing Board onCommit');return new Function('scope',`with(scope){return ({${source.slice(node.start,node.end)}}).onCommit;}`)(scope);}
export async function authorityFixture(objects){
 const outcomes=new Map(),commits=[];
 const authority=await openBrowserBoardAuthority({boardId:'node-board',enableNotebookOperations:true,
  loadBoard:async()=>({boardId:'node-board',snapshot:{version:2,background:'blank',canvas:{objects}},revision:0,snapshotRevision:0}),loadCommitsAfter:async()=>[],
  loadActionOutcome:async(_id,id)=>outcomes.get(id)??null,persistCommit:async(_id,commit)=>{commits.push(commit);outcomes.set(commit.actionId,structuredClone(commit));return {commit,duplicate:false};},persistNoopOutcome:async(_id,result)=>{outcomes.set(result.actionId,structuredClone(result));return {result,duplicate:false};}});
 return {authority,commits};
}
export async function createUiHarness({authority,clientId='teacher',beforeCommit=async()=>{},deliver=async()=>{}}){
 const canvas=new Canvas(null,{width:800,height:700,renderOnAddRemove:false});
 await canvas.loadFromJSON(authority.getSnapshot().canvas);
 const errors=[],statuses=[],savedCaches=[],history=[];
 const scope={
  notebookRuntimeEnabled:true,disposed:false,canvas,clientId,boardId:`node-${clientId}-${randomToken(10)}`,boardKey:'key',isOwner:true,
  BACKGROUNDS:new Set(['blank','grid','dots']),HISTORY_LIMIT:1000,window:{setTimeout:()=>0,clearTimeout(){}},navigator:{onLine:true},console:{warn(){},error:error=>errors.push(error)},
  fabricCanvasRef:ref(canvas),boardReadyRef:ref(true),clientIdRef:ref(clientId),canEditRef:ref(true),activeToolRef:ref('select'),
  revisionRef:ref(authority.getRevision()),authoritativeApplyQueueRef:ref(Promise.resolve()),applyingRemoteRef:ref(false),applyingHistoryRef:ref(false),
  notebookControllerRef:ref(null),notebookControllerInitRef:ref(null),notebookControllerEpochRef:ref(0),notebookGapRevisionRef:ref(null),notebookCommitBridgeRef:ref(null),notebookHandlersRef:ref({}),
  notebookQueueRef:ref(Promise.resolve()),notebookMutationActiveRef:ref(false),notebookTextEditRef:ref(null),
  historyGenerationRef:ref(0),undoStackRef:ref(history),redoStackRef:ref([]),localDeletionMutationIdsRef:ref(new Map()),
  authoritativeObjectStatesRef:ref(new Map()),authoritativeSelectionTransactionsRef:ref(new Map()),authoritativeBackgroundStateRef:ref({revision:0,background:'blank'}),
  remoteSelectionTransactionsRef:ref(new Map()),remoteDrawSessionsRef:ref(new Map()),remoteTransformSessionsRef:ref(new Map()),remotePreviewTokensRef:ref(new Map()),remotePreviewPendingRef:ref({records:new Map()}),remoteDeletedObjectIdsRef:ref(new Map()),
  pendingLocalObjectMutationCountsRef:ref(new Map()),pendingServerWritesRef:ref(0),pendingLocalBackgroundMutationCountRef:ref(0),rebasingPendingActionsRef:ref(false),
  syncRequestedRef:ref(false),syncForceRef:ref(false),pencilDiagnosticsRef:ref(null),deferredTransformFlushRef:ref(null),deferredTransformEntries:new Map(),deferredTransformTimer:null,deferredTransformFlushPromise:null,penTransformSpatialApiRef:ref(null),serializedObjectCacheRef:ref(new WeakMap()),objectRegistryRef:ref(new Map()),
  viewingArchiveRef:ref(false),transientStatusTimerRef:ref(null),backgroundRef:ref('blank'),
  ActiveSelection,util,NOTEBOOK_FIELDS,MEDIA_OBJECT_FIELDS,stageNotebookVisualOperations,prepareNotebookProjection,isBoardNotebook,notebookObjectIntersection,isBoardMedia,
  snapshotNotebookGesturePages,bindNotebookGestureTarget,consumeNotebookGesturePage,operationObjectIds,affectedOperationIds:operationObjectIds,applySerializedObjectPatch,applyNotebookOperation,createNotebookBoardController,createNotebookOutbox,randomToken,
  serializeObject:serialized,serializedCharSize:value=>JSON.stringify(value).length,splitDurableOperations:ops=>[ops],
  clamp:(value,min,max)=>Math.min(max,Math.max(min,value)),
  registeredObjectsById:id=>canvas.getObjects().filter(object=>String(object.boardObjectId)===String(id)),
  removeRegisteredObjectsById:id=>canvas.remove(...canvas.getObjects().filter(object=>String(object.boardObjectId)===String(id))),
  deduplicateRegisteredObjectIds:()=>{},rebuildObjectRegistry:()=>{},deduplicateBoardObjects:()=>{},
  preloadSerializedImages:async()=>{},enlivenImageAwareObjects:records=>util.enlivenObjects(records),
  createPendingImagePlaceholder:()=>{throw Error('unexpected missing fixture image');},
  createOuterOnlyActiveSelection:(objects,canvas)=>new ActiveSelection(objects,{canvas}),
  applyObjectInteractivityToObjects:()=>{},applyObjectInteractivity:()=>{},
  applyBackground:background=>scope.backgroundRef.current=background,
  schedulePersistence:()=>{},bufferSnapshotAction:()=>{},updatePdfControls:()=>{},updateSelectionState:()=>{},updateSelectionStyleState:()=>{},updateHistoryButtons:()=>{},
  setPendingCount:()=>{},setNotebookBusy:()=>{},setNotebookTextEditor:()=>{},setSyncTone:()=>{},setSaveStatus:value=>statuses.push(value),
  acquireLocalSelectionLease:async()=>true,ownsSelectionLease:()=>true,releaseLocalSelectionLease:()=>{},
  getLocalMutationIds:()=>new Set(),retryPendingServerImages:()=>{},reconcileBoardScreenShare:()=>{},updateBackgroundTransform:()=>{},
  loadCanvasJsonProgressively:(canvas,json)=>canvas.loadFromJSON(json),setCachedSnapshot:async(_id,record)=>savedCaches.push(record),pruneConfirmedActionsThrough:async()=>{},
  applyOpsToSnapshot:snapshot=>structuredClone(snapshot),
  syncFromServer:async()=>{errors.push(Error('unexpected full synchronization'));},
  getObjectRecords:objects=>objects.map(object=>({object:scope.serializeObject(object),zIndex:canvas.getObjects().indexOf(object)})),
 };
 for(const name of ['isActiveSelectionObject','captureSerializedObjectTransform','patchSerializedObjectTransform','serializeObject'])scope[name]=globalFunction(name,scope);
 scope.isTextObject=globalFunction('isTextObject',scope);
 scope.isImageObject=globalFunction('isImageObject',scope);
 scope.applySharpRenderingPolicy=globalFunction('applySharpRenderingPolicy',scope);
 scope.createLightweightTransformOp=globalFunction('createLightweightTransformOp',scope);
 scope.isNotebookControlledAction=globalFunction('isNotebookControlledAction',scope);
 scope.transformOperationEntries=globalFunction('transformOperationEntries',scope);
 for(const name of ['recordAction','rememberAuthoritativeOps','sendDurableOps','sendLightweightTransforms','sendRecordUpserts','addImageFiles','replayPendingActionsLocally','ensureNotebookController','applyRemoteOps','applyAuthoritativeSnapshot','queueNotebookMutation','notebookForObject'])scope[name]=callback(name,scope);
 scope.notebookCommitBridgeRef.current=createNotebookCommitBridge({getController:()=>scope.notebookControllerRef.current,getRevision:()=>scope.revisionRef.current,setRevision:value=>scope.revisionRef.current=value,remember:scope.rememberAuthoritativeOps});
 scope.incrementalNotebookActions=createNotebookBoardActions({getCanvas:()=>canvas,getController:()=>scope.ensureNotebookController(),clientId,getRecords:scope.getObjectRecords,recordAction:scope.recordAction,
  acquireLease:scope.acquireLocalSelectionLease,ownsLease:scope.ownsSelectionLease,releaseLease:scope.releaseLocalSelectionLease,
  mutate:work=>{const previous=scope.applyingRemoteRef.current;scope.applyingRemoteRef.current=true;try{return work();}finally{scope.applyingRemoteRef.current=previous;}},
  onError:error=>errors.push(error)});
 for(const name of ['captureIntoNotebook','captureNotebookSelection','changeNotebookPage','saveNotebookText','eraseNotebookChildren','commitConditionalHistoryOps'])scope[name]=callback(name,scope);
 for(const name of ['cacheLightweightTransformEntry','scheduleDeferredTransformFlush','flushDeferredTransformPersistence','queueDeferredTransformPersistence'])scope[name]=globalFunction(name,scope);
 scope.deferredTransformFlushRef.current=scope.flushDeferredTransformPersistence;
 scope.commitAddedObject=globalFunction('commitAddedObject',scope);
 scope.recordForJustAddedObject=globalFunction('recordForJustAddedObject',scope);
 scope.markObject=callback('markObject',scope);
 const commit=onCommit(scope);
 const realtime=createBrowserAuthorityRealtimeCore({clientId,permission:'owner',session:{whenRuntimeReady:async()=>{},getRevision:()=>authority.getRevision(),sendOps:async(ops,{actionId})=>{
  await beforeCommit({ops,actionId,clientId});const result=await authority.commitAction({ops,actionId,clientId,baseRevision:authority.getRevision()});await deliver(result,clientId);return result;
 }},onCommit:commit,onPendingChange:count=>{scope.pendingServerWritesRef.current=count;},onStatus:()=>{}});
 Object.assign(realtime,{whenRuntimeReady:async()=>{},getNotebookVersion:()=>1,getNotebookCheckpoint:()=>({snapshot:authority.getSnapshot(),revision:authority.getRevision(),tombstones:authority.getTombstones(),notebookTombstones:authority.getNotebookTombstones()}),getVerificationStats:()=>({enabled:true})});
 scope.realtimeRef=ref(realtime);scope.notebookHandlersRef.current={leaseForOperations:async()=>true,refreshControls:()=>{}};
 await scope.ensureNotebookController();
 return {canvas,scope,errors,statuses,history,savedCaches,book:()=>canvas.getObjects().find(isBoardNotebook),
  async flush(){await scope.notebookControllerRef.current.flush();await scope.authoritativeApplyQueueRef.current;},
  async receive(result,sourceClientId){return scope.applyRemoteOps(result.appliedOps,result.revision,false,result.appliedBackground,result.actionId,sourceClientId);},
  async close(){scope.boardReadyRef.current=false;scope.notebookControllerEpochRef.current++;scope.notebookControllerRef.current?.dispose();scope.notebookControllerRef.current=null;await realtime.disconnect();await canvas.dispose();},
 };
}
