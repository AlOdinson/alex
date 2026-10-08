import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

// Real Fabric + Chromium mouse events, with a manually delayed teacher reply.
// This is an isolated interaction fixture, not a live two-device network test.
const source = readFileSync(new URL('../src/components/Board.jsx', import.meta.url), 'utf8');
const from = source.indexOf('  const selectionObjectIds = useCallback(');
const to = source.indexOf('  const getLiveTransformObjects = useCallback(', from);
const end = source.indexOf('    const broadcastLiveTransform =');
const anchor = '      commitAddedObject(path);\n    });';
const start = source.lastIndexOf(anchor, end) + anchor.length;
assert.ok(from > 0 && to > from && end > start);
const callbacks = source.slice(from, to) + source.slice(start, end);
const bundle = readFileSync(new URL('../node_modules/fabric/dist/index.min.js', import.meta.url), 'utf8');
const interactionHelpers = readFileSync(new URL('../src/lib/boardInteractionFixes.js', import.meta.url), 'utf8')
  .replace(/^export /gm, '');
const pivotModule = readFileSync(new URL('../src/lib/boardCornerPivot.js', import.meta.url), 'utf8')
  .replace(/^export /gm, '');
const pivotStart = source.indexOf('const cornerPivotControlAction =');
const pivotEnd = source.indexOf('function moveSelectionFromHandle(', pivotStart);
assert.ok(pivotStart >= 0 && pivotEnd > pivotStart, 'Board combined corner action must exist');
const pivotControlSource = source.slice(pivotStart, pivotEnd);
const fixtureScript = `
${interactionHelpers}
${pivotModule}
const { Canvas, FabricImage, Control, controlsUtils } = window.fabric;
const isBoardNotebook = () => false;
${pivotControlSource}
const noop=()=>{}; const ref=current=>({current}); const useCallback=fn=>fn;
const canvas=new Canvas('board',{width:800,height:600,enablePointerEvents:true,preserveObjectStacking:true});
const pixels=document.createElement('canvas'); pixels.width=200; pixels.height=120;
const ctx=pixels.getContext('2d'); ctx.fillStyle='#2867ad'; ctx.fillRect(0,0,200,120);
const target=new FabricImage(pixels,{left:150,top:150,originX:'left',originY:'top',boardObjectId:'image',objectKind:'image'});
target.snapAngle=90; target.snapThreshold=45; // Old saved rotation snapping is ignored.
installPivotCornerControls(target);
canvas.add(target); canvas.setActiveObject(target); target.setCoords(); canvas.renderAll();
const state={starts:0,ends:0,denied:false,requests:0}; let reply=null; let disposed=false;
// This isolated fixture contains an ordinary image, not a notebook.
const notebookRuntimeEnabled=false;
const fabricCanvasRef=ref(canvas), activeToolRef=ref('select');
const selectionLeaseInteractionStateRef=ref(new Map());
const selectionLeaseRef=ref({generation:0,token:null,ids:[],state:'none',promise:null,expiresAt:0});
const canEditRef=ref(true), applyingRemoteRef=ref(false), applyingHistoryRef=ref(false);
const flattenTarget=o=>o?[o]:[]; const isBoardScreenShareObject=()=>false;
const boardId='test',boardKey='test',clientIdRef=ref('student');
let tokenSequence=0;const randomToken=()=> 'browser-token-'+(++tokenSequence); const localLockIdsRef=ref([]),remoteLocksRef=ref(new Map());
const realtimeRef=ref({sendLock:noop});
const acquireBoardObjectLocks=(_id,_key,_client,token,ids)=>{
 state.requests++;
 return new Promise(resolve=>{reply=()=>resolve(state.denied
  ? {granted:false,conflicts:[{objectId:'image',clientId:'teacher',expiresAt:Date.now()+12000}]}
  : {granted:true,expiresAt:Date.now()+12000,objectIds:ids,lockToken:token});});
};
const releaseBoardObjectLocks=async()=>0;
const registeredObjectsById=id=>id==='image'?[target]:[];
const applyObjectInteractivityToObjects=noop,updateSelectionState=noop,updateSelectionStyleState=noop,setRemoteLocks=noop;
const setSaveStatus=noop,setSyncTone=noop,transientStatusTimerRef=ref(null);
const modifiedBeforeRecordsRef=ref([]),modifiedBeforeRef=ref([]),currentTransformStartRef=ref(null),currentTransformMovedRef=ref(false);
const suppressTargetFindDuringTransform=noop,selectionPenSessionRef=ref({active:false}),penInputRef=ref({active:false});
const transformGestureRef=ref({}),transformViewportPatchRects=()=>[];
const beginLiveTransform=()=>{state.starts++;return 'gesture-'+state.starts;};
const lastLockBroadcastRef=ref(0),sendLocalLock=noop;
const getObjectRecords=objects=>objects.map(o=>({object:{left:o.left,top:o.top,scaleX:o.scaleX,scaleY:o.scaleY}}));
const transformFramesForObjects=getObjectRecords;
${callbacks}
canvas.on('object:modified',()=>state.ends++);
canvas.on('mouse:down',({e})=>{state.pointerId=e.pointerId;});
window.testApi={
 cancel:()=>canvas.upperCanvasEl.dispatchEvent(new PointerEvent('pointercancel',
  {bubbles:true,pointerId:state.pointerId,pointerType:'mouse',buttons:0})),
 grant:async()=>{if(!reply)throw new Error('No pending reply');reply();await selectionLeaseRef.current.promise;await Promise.resolve();},
 deny:()=>{state.denied=true;},
 setup:({angle=0,scaleX=1,scaleY=1,zoom=1,tx=0,ty=0}={})=>{
   target.set({angle,scaleX,scaleY});
   canvas.setViewportTransform([zoom,0,0,zoom,tx,ty]);
   target.setCoords();canvas.renderAll();
 },
 read:()=>{
  const corners={tl:['left','top'],tr:['right','top'],br:['right','bottom'],bl:['left','bottom']};
  const sceneCorners={};
  const handles={};
  for(const [key,[originX,originY]] of Object.entries(corners)){
   const p=target.getPositionByOrigin(originX,originY);
   sceneCorners[key]={x:p.x,y:p.y};
   handles[key]={x:target.oCoords[key].x,y:target.oCoords[key].y};
  }
  return {left:target.left,top:target.top,scaleX:target.scaleX,scaleY:target.scaleY,
   angle:target.angle,snapAngle:target.snapAngle,
   action:canvas._currentTransform?.action??null,lease:selectionLeaseRef.current.state,
   starts:state.starts,ends:state.ends,requests:state.requests,before:modifiedBeforeRecordsRef.current,
   corner:handles.br,corners:sceneCorners,handles,
   viewport:[...canvas.viewportTransform],
   circularControlExists:Boolean(target.controls.alexCornerRotate),
   centerRotationExists:Boolean(target.controls.mtr)};
 }
};
`;

const executablePath=process.env.CHROMIUM_EXECUTABLE
  ?? ['/usr/bin/chromium','/usr/bin/google-chrome'].find(existsSync);
const browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{}),args:['--no-sandbox']});
const results=[];
try {
  for(const scenario of ['drag','scale','released-drag','released-scale','denied-drag','denied-scale','repeated-drag','cancelled-drag','cancelled-scale']){
    const page=await browser.newPage({viewport:{width:900,height:700}});
    const errors=[]; page.on('pageerror',e=>errors.push(e.message));
    await page.setContent('<!doctype html><html><body style="margin:0"><canvas id="board"></canvas></body></html>');
    await page.addScriptTag({content:bundle});
    await page.addScriptTag({content:fixtureScript});
    await page.waitForFunction(()=>Boolean(window.testApi));
    const read=()=>page.evaluate(()=>window.testApi.read());
    const initial=await read();
    const scale=scenario.includes('scale');
    const point=scale?initial.corner:{x:230,y:210};
    if(scenario.startsWith('denied'))await page.evaluate(()=>window.testApi.deny());
    await page.mouse.move(point.x,point.y); await page.mouse.down();
    assert.equal((await read()).action,scale?'scale':'drag',scenario+' must start intended Fabric action');
    await page.mouse.move(point.x+10,point.y+6);
    assert.deepEqual(errors,[],scenario+' must not throw in the native transform handler');
    const waiting=await read();
    assert.equal(waiting.left,initial.left);assert.equal(waiting.scaleX,initial.scaleX);
    assert.equal(waiting.starts,0);
    if(scenario.startsWith('released'))await page.mouse.up();
    if(scenario==='repeated-drag'){
      await page.mouse.up();await page.mouse.move(point.x,point.y);await page.mouse.down();
    }
    if(scenario.startsWith('cancelled'))await page.evaluate(()=>window.testApi.cancel());
    await page.evaluate(()=>window.testApi.grant());
    await page.mouse.move(point.x+100,point.y+60,{steps:4});
    await page.mouse.up();
    const final=await read();
    const shouldMove=!scenario.startsWith('released')&&!scenario.startsWith('denied')&&!scenario.startsWith('cancelled');
    if(shouldMove){
      assert.equal(final.starts,1,scenario+' should initialize once');
      assert.equal(final.ends,1,scenario+' should complete one real modification');
      assert.equal(final.before[0].object.left,initial.left);
      assert.equal(final.before[0].object.scaleX,initial.scaleX);
      if(scale)assert.ok(final.scaleX>initial.scaleX+0.2,'held resize should increase size');
      else assert.ok(final.left>initial.left+50,'held drag should change position');
    }else{
      assert.equal(final.starts,0);assert.equal(final.ends,0);
      assert.equal(final.left,initial.left);assert.equal(final.scaleX,initial.scaleX);
    }
    assert.deepEqual(errors,[],scenario+' must not raise browser errors');
    results.push({scenario,pass:true,left:final.left,scaleX:final.scaleX,modifications:final.ends});
    await page.close();
  }


// Real native mouse drags through intermediate angles around four DIFFERENT
// opposite fixed corners. Each gesture simultaneously changes rotation and scale.
for (const corner of ['tl','tr','br','bl']) {
  const page=await browser.newPage({viewport:{width:900,height:700}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  try {
    await page.setContent('<!doctype html><html><body style="margin:0"><canvas id="board"></canvas></body></html>');
    await page.addScriptTag({content:bundle});
    await page.addScriptTag({content:fixtureScript});
    await page.waitForFunction(()=>Boolean(window.testApi));
    await page.evaluate(()=>window.testApi.setup({angle:24,scaleX:1.24,scaleY:0.8,zoom:1.5,tx:24,ty:18}));
    const read=()=>page.evaluate(()=>window.testApi.read());
    const start=await read();
    assert.equal(start.circularControlExists,false,'no new round handle');
    assert.equal(start.centerRotationExists,false,'no separate rotation-only mtr');
    const opposite={tl:'br',tr:'bl',br:'tl',bl:'tr'}[corner];
    const pivot=start.corners[opposite],grabbed=start.corners[corner];
    const v=start.viewport;
    const toScene=p=>({x:(p.x-v[4])/v[0],y:(p.y-v[5])/v[3]});
    const toScreen=p=>({x:p.x*v[0]+v[4],y:p.y*v[3]+v[5]});
    const control=start.handles[corner];
    const initialPointerScene=toScene(control);
    const offset={x:grabbed.x-initialPointerScene.x,y:grabbed.y-initialPointerScene.y};
    const originalVector={x:grabbed.x-pivot.x,y:grabbed.y-pivot.y};
    function desiredPoint(degrees,factor){
      const a=degrees*Math.PI/180;
      const c=Math.cos(a),s=Math.sin(a);
      return {x:pivot.x+(originalVector.x*c-originalVector.y*s)*factor,
        y:pivot.y+(originalVector.x*s+originalVector.y*c)*factor};
    }
    const moveTo=async(degrees,factor,steps=10)=>{
      const expected=desiredPoint(degrees,factor);
      const cursor=toScreen({x:expected.x-offset.x,y:expected.y-offset.y});
      await page.mouse.move(cursor.x,cursor.y,{steps});
      return {expected,current:await read()};
    };
    await page.mouse.move(control.x,control.y);
    await page.mouse.down();
    assert.equal((await read()).action,'scale','square corner must start the combined transform');
    await moveTo(4,1.05,3);
    assert.equal((await read()).scaleX,start.scaleX,'no edit before selection lease is granted');
    await page.evaluate(()=>window.testApi.grant());
    for(const [degrees,factor] of [[15,1.22],[35,1.4],[60,0.76]]) {
      const {expected,current}=await moveTo(degrees,factor);
      const anchored=current.corners[opposite],follow=current.corners[corner];
      assert.ok(Math.hypot(anchored.x-pivot.x,anchored.y-pivot.y)<0.1,
        corner+' opposite pivot moved under drag');
      assert.ok(Math.hypot(follow.x-expected.x,follow.y-expected.y)<1.4,
        corner+' dragged corner failed to follow pointer');
      assert.ok(Math.abs(current.angle-(start.angle+degrees))<1.5,
        corner+' rotation snapped instead of tracking '+degrees+' degrees');
      assert.ok(Math.abs(current.scaleX-start.scaleX*factor)<0.02,
        corner+' stretch was not proportional to dragged diagonal');
      assert.ok(Math.abs(current.scaleY-start.scaleY*factor)<0.02,
        corner+' height did not scale with width');
    }
    await page.mouse.up();
    const final=await read();
    assert.equal(final.ends,1,'combined gesture saves as one Fabric object modification');
    assert.deepEqual(errors,[],corner+' raised browser errors');
    results.push({scenario:'opposite-pivot-'+corner,pass:true,angle:final.angle,scaleX:final.scaleX});
  }finally{await page.close();}
}
  console.log(JSON.stringify({browser:browser.version(),fabric:'7.4.0',results},null,2));
}finally{await browser.close();}
