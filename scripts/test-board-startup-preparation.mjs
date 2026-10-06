import { loadBoardCanvasJson, cancelBoardCanvasLoad } from '../src/lib/boardLoadPreparation.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getEnv } from 'fabric/node';
import { setEnv, StaticCanvas, Rect, classRegistry } from 'fabric';
import { boardFunction } from './notebook-ui-node-harness.mjs';
setEnv(getEnv());
const scope = { loadBoardCanvasJson,
  serializedImagePayload: record => record?.type === 'Image' ? record : null,
  createPendingImagePlaceholder: record => new Rect({ width: 10, height: 10, boardObjectId: record.boardObjectId,
    pendingImage: true, pendingImageSerialized: record }),
  clamp: (n, min, max) => Math.min(max, Math.max(min, n)),
};
const load = (...args) => boardFunction('loadInitialCanvasJsonProgressively', scope)(...args);
const canvas = () => new StaticCanvas(null, {width:160,height:120,renderOnAddRemove:true,enableRetinaScaling:false});
const record = (id, type='Rect') => ({type,boardObjectId:id,left:10,top:10,width:10,height:10,fill:'black'});
const ids = c => c.getObjects().map(o=>o.boardObjectId);

test('real Board startup yields while preparing top-level objects and keeps old scene coherent', async () => {
  const c = canvas(), old = new Rect(record('old'));
  c.add(old); c.cancelRequestedRender();
  let constructed=0, observed;
  class StartupCostRect extends Rect {
    static type='StartupCostRect';
    static fromObject(value, options) {
      constructed++; const until=performance.now()+1; while(performance.now()<until) {}
      return super.fromObject(value, options);
    }
  }
  classRegistry.setClass(StartupCostRect);
  const input=Array.from({length:96},(_,i)=>record(`new-${i}`,'StartupCostRect'));
  const task=new Promise(resolve=>setTimeout(()=>{observed={constructed,ids:ids(c)};resolve();},0));
  try {
    await load(c,{objects:input});await task;
    assert.ok(observed.constructed<96,`pending input waited for ALL ${observed.constructed} constructors`);
    assert.deepEqual(observed.ids,['old'],'no partial installation while loading');
    assert.deepEqual(ids(c),input.map(o=>o.boardObjectId));
    assert.equal(c.renderOnAddRemove,true);
  } finally {await c.dispose();}
});

test('failed detached preparation leaves scene and rendering policy unchanged', async () => {
  const c=canvas();c.add(new Rect(record('old')));c.cancelRequestedRender();
  class StartupFailRect extends Rect { static type='StartupFailRect'; static async fromObject(){throw Error('startup failure');} }
  classRegistry.setClass(StartupFailRect);
  try {
    await assert.rejects(load(c,{objects:[record('bad','StartupFailRect')]}),/startup failure/);
    assert.deepEqual(ids(c),['old']);
    assert.equal(c.renderOnAddRemove,true,'rejected load must not disable normal rendering');
  } finally {await c.dispose();}
});

test('image placeholders preserve exact interleaved order without decoding remote images', async () => {
  const c=canvas();const images=[{...record('image-a','Image'),src:'https://unreachable.invalid/a'}, {...record('image-b','Image'),src:'https://unreachable.invalid/b'}];
  const objects=[record('first'),images[0],record('middle'),images[1],record('last')];
  const source={objects,background:'rgb(245, 245, 245)',overlay:'rgba(0,0,0,0)',customLesson:'kept'};
  const before=structuredClone(source);
  try {
    assert.equal(await load(c,source),2);
    assert.deepEqual(ids(c),objects.map(o=>o.boardObjectId));
    assert.equal(c.getObjects()[1].pendingImageSerialized,images[0]);
    assert.equal(c.backgroundColor,source.background); assert.equal(c.customLesson,'kept');
    assert.deepEqual(source,before);
  } finally {await c.dispose();}
});

test('superseded slow load cannot replace a newer completed scene; late child is disposed', async () => {
  const c=canvas();c.add(new Rect({width:10,height:10,boardObjectId:'old'}));c.cancelRequestedRender();
  let finish, disposed=0;
  class StartupSlowRect extends Rect {
    static type='StartupSlowRect';
    static fromObject(value) { return new Promise(resolve=>{finish=()=>{
      const object=new Rect({width:10,height:10,boardObjectId:value.boardObjectId});
      const original=object.dispose.bind(object);object.dispose=()=>{disposed++;original();};resolve(object);
    };}); }
  }
  classRegistry.setClass(StartupSlowRect);
  const obsolete=load(c,{objects:[record('slow','StartupSlowRect')]});
  const rejected=assert.rejects(obsolete, error=>error.code==='notebook_work_cancelled');
  try {
    await load(c,{objects:[record('new')]});await rejected;
    assert.deepEqual(ids(c),['new']);
    finish();await new Promise(r=>setTimeout(r,0));
    assert.deepEqual(ids(c),['new']);assert.equal(disposed,1);
  } finally {await c.dispose();}
});

test('cancellation closes all prepared resources including a bitmap-like child that resolves late', async () => {
  const c=canvas();c.add(new Rect({width:10,height:10,boardObjectId:'old'}));c.cancelRequestedRender();
  let finish, disposals=0;
  class StartupBlockedRect extends Rect {
    static type='StartupBlockedRect';
    static fromObject(value) { return new Promise(resolve=>{finish=()=>{const child=new Rect({width:1,height:1});
      child.dispose=()=>{disposals++;};resolve(child);};}); }
  }
  classRegistry.setClass(StartupBlockedRect);
  const task=load(c,{objects:[record('blocked','StartupBlockedRect')]});
  const rejected=assert.rejects(task, error=>error.code==='notebook_work_cancelled');
  try {
    cancelBoardCanvasLoad(c);await rejected;
    assert.deepEqual(ids(c),['old']);finish();await new Promise(r=>setTimeout(r,0));
    assert.equal(disposals,1);assert.equal(c.renderOnAddRemove,true);
  } finally {await c.dispose();}
});

test('complete background, overlay and clip rendering equals Fabric canonical load pixel for pixel', async () => {
  const a=canvas(),b=canvas();
  const source={objects:[record('r'), {...record('second'),left:22,top:25,fill:'rgba(25,50,90,.4)'}],
    background:'rgb(238,240,241)',overlay:'rgba(180,70,35,.2)',clipPath:{type:'Rect',left:5,top:5,width:100,height:100,fill:'black'}};
  const pixels=c=>new Uint8Array(c.getContext().getImageData(0,0,c.width,c.height).data);
  try {await a.loadFromJSON(source);await load(b,source);a.renderAll();b.renderAll();assert.deepEqual(pixels(a),pixels(b));}
  finally {await a.dispose();await b.dispose();}
});

test('shared browser fixtures pass against real Node/Fabric as well',async()=>{
 const {runBoardStartupCases}=await import('./board-startup-fixture.js');
 const results=await runBoardStartupCases();assert.equal(results.length,7);
 for(const result of results)assert.equal(result.error,undefined,JSON.stringify(result));
});
