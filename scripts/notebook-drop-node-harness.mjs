import { ActiveSelection, FabricImage, Point, Rect, Text, Group, util } from 'fabric';
import { NOTEBOOK_FIELDS } from '../src/lib/boardNotebook.js';
import { MEDIA_OBJECT_FIELDS } from '../src/lib/boardMediaRuntime.js';
import { callback, globalFunction, canvasListener } from './notebook-ui-node-harness.mjs';
const ref=current=>({current});

/** Real Board transform/persistence bodies. Timers are held so ordering is tested,
 * not hidden by a 24ms sleep. This is native Canvas, not a physical input test. */
export function attachDropHarness(ui) {
 const s=ui.scope;
 Object.assign(s,{ActiveSelection,FabricImage,Point,Rect,Text,Group,util,NOTEBOOK_FIELDS,MEDIA_OBJECT_FIELDS,
  modifiedBeforeRef:ref([]),modifiedBeforeRecordsRef:ref([]),liveTransformSendRef:ref({zIndexMap:null}),
  transformGestureRef:ref({}),currentTransformStartRef:ref(null),currentTransformMovedRef:ref(false),
  deferredTransformEntries:new Map(),deferredTransformTimer:null,deferredTransformFlushPromise:null,
  restoreTargetFindAfterTransform(){},updateTransformSpatialObjects(){},registerCanvasObject(){},sendLocalLock(){},endLiveTransform(){},
  isBoardScreenShareObject:()=>false,finalizePencilTransformPatches(){},
 });
 for(const name of ['compactTransformMatrix','isActiveSelectionObject','flattenTarget','captureSerializedObjectTransform',
  'patchSerializedObjectTransform','serializeObject','transformFramesForObjects','createLightweightTransformOp',
  'cacheLightweightTransformEntry','queueDeferredTransformPersistence','scheduleDeferredTransformFlush','flushDeferredTransformPersistence'])s[name]=globalFunction(name,s);
 for(const name of ['getObjectRecords','captureTransformRecordInputs','sendLightweightTransforms'])s[name]=callback(name,s);
 s.deferredTransformFlushRef.current=s.flushDeferredTransformPersistence;
 Object.assign(s.notebookHandlersRef.current,{capture:s.captureIntoNotebook,candidate:s.notebookForObject});
 // Added by the fix. Baseline intentionally goes through its original single-object listener.
 try{s.dropSelectionIntoNotebook=callback('dropSelectionIntoNotebook',s);s.notebookHandlersRef.current.drop=s.dropSelectionIntoNotebook;}catch(error){if(!String(error).includes('Missing Board callback'))throw error;}
 const modified=canvasListener('object:modified',s);
 return {
  begin(target) {
   const members=s.flattenTarget(target);
   s.modifiedBeforeRef.current=s.transformFramesForObjects(members,ui.canvas);
   s.modifiedBeforeRecordsRef.current=s.getObjectRecords(members);
   s.transformGestureRef.current.activeId=s.randomToken(12);
  },
  release(target,action='drag'){modified({target,action,transform:{action}});},
  async settle(){await s.notebookQueueRef.current;await s.flushDeferredTransformPersistence({force:true});await ui.flush();},
 };
}
