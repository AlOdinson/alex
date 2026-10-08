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
const rotationStart = source.indexOf('function renderCornerRotationHandle(');
const rotationEnd = source.indexOf('function moveSelectionFromHandle(', rotationStart);
assert.ok(rotationStart >= 0 && rotationEnd > rotationStart, 'Board free-rotation control source exists');
const cornerRotationSource = source.slice(rotationStart, rotationEnd);
const fixtureScript = `
${interactionHelpers}
const { Canvas, FabricImage, Control, controlsUtils } = window.fabric;
${cornerRotationSource}
const noop=()=>{}; const ref=current=>({current}); const useCallback=fn=>fn;
const canvas=new Canvas('board',{width:800,height:600,enablePointerEvents:true,preserveObjectStacking:true});
const pixels=document.createElement('canvas'); pixels.width=200; pixels.height=120;
const ctx=pixels.getContext('2d'); ctx.fillStyle='#2867ad'; ctx.fillRect(0,0,200,120);
const target=new FabricImage(pixels,{left:150,top:150,originX:'left',originY:'top',boardObjectId:'image',objectKind:'image'});
target.snapAngle=90; target.snapThreshold=45;
installContinuousCornerRotation(target);
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
 read:()=>({left:target.left,top:target.top,scaleX:target.scaleX,scaleY:target.scaleY,
  angle:target.angle,snapAngle:target.snapAngle,
  action:canvas._currentTransform?.action??null,lease:selectionLeaseRef.current.state,
  starts:state.starts,ends:state.ends,requests:state.requests,before:modifiedBeforeRecordsRef.current,
  corner:{x:target.oCoords.br.x,y:target.oCoords.br.y},
  rotator:{x:target.oCoords.alexCornerRotate.x,y:target.oCoords.alexCornerRotate.y},
  mtr:{x:target.oCoords.mtr.x,y:target.oCoords.mtr.y},
  center:{x:target.getCenterPoint().x,y:target.getCenterPoint().y}})
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

// Exercise the real Fabric controls across intermediate, non-right angles.
// Both controls should rotate smoothly even when the object originally had
// a 90-degree snap and the edit lease was pending on pointerdown.
for (const handle of ['rotator', 'mtr']) {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.setContent('<!doctype html><html><body style="margin:0"><canvas id="board"></canvas></body></html>');
    await page.addScriptTag({ content: bundle });
    await page.addScriptTag({ content: fixtureScript });
    await page.waitForFunction(() => Boolean(window.testApi));
    const read = () => page.evaluate(() => window.testApi.read());
    const initial = await read();
    const grip = initial[handle];
    const radius = Math.hypot(grip.x - initial.center.x, grip.y - initial.center.y);
    const theta = Math.atan2(grip.y - initial.center.y, grip.x - initial.center.x);
    const pointAt = degrees => ({
      x: initial.center.x + radius * Math.cos(theta + degrees * Math.PI / 180),
      y: initial.center.y + radius * Math.sin(theta + degrees * Math.PI / 180),
    });
    await page.mouse.move(grip.x, grip.y);
    await page.mouse.down();
    assert.equal((await read()).action, 'rotate', handle + ' starts native Fabric rotation');
    const first = pointAt(4);
    await page.mouse.move(first.x, first.y, { steps: 3 });
    assert.equal((await read()).angle, 0, 'pending lease cannot rotate the drawing');
    await page.evaluate(() => window.testApi.grant());
    assert.equal((await read()).snapAngle, 0, 'legacy 90-degree snap is cleared after lease');
    for (const degrees of [15, 35, 60]) {
      const point = pointAt(degrees);
      await page.mouse.move(point.x, point.y, { steps: 12 });
      const current = await read();
      const angularError = Math.abs(((current.angle - degrees + 540) % 360) - 180);
      assert.ok(angularError < 9, handle + ': actual ' + current.angle + ' vs expected ' + degrees);
      assert.ok(current.angle > 4 && current.angle < 87, handle + ' snapped to a right angle');
    }
    await page.mouse.up();
    const last = await read();
    assert.equal(last.ends, 1, 'native rotation commits once on release');
    assert.deepEqual(errors, [], 'native Fabric rotation raised errors');
    results.push({ scenario: 'smooth-rotation-' + handle, pass: true, angle: last.angle });
  } finally {
    await page.close();
  }
}
  console.log(JSON.stringify({browser:browser.version(),fabric:'7.4.0',results},null,2));
}finally{await browser.close();}
