import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAcceptedBoardFile, prepareImageForBoard, copySerializedBoardImages } from '../src/lib/imageStorage.js';
import { attachMediaPixels, MEDIA_PLACEHOLDER_SRC } from '../src/lib/boardMediaRuntime.js';
import { pdfPageGeometry } from '../src/lib/pdfPageGeometry.js';
test('file picker accepts PDF and GIF, GIF bytes never become JPEG',async()=>{
  assert.ok(isAcceptedBoardFile({type:'application/pdf',name:'a.pdf'}));
  assert.ok(isAcceptedBoardFile({type:'image/gif',name:'a.gif'}));
  const file=Object.assign(new Blob(['GIF89a123'],{type:'image/gif'}),{name:'a.gif'});
  const result=await prepareImageForBoard(file);assert.equal(result.blob.type,'image/gif');assert.equal(await result.blob.text(),'GIF89a123');
});
test('media pixels retain geometry and serialize a small source',()=>{
  const object={width:100,height:200,setElement(el){this.el=el;this.width=el.width;this.height=el.height;},set(v){Object.assign(this,v);}};
  attachMediaPixels(object,{width:2000,height:3000});assert.equal(object.width,100);assert.equal(object.height,200);assert.equal(object.getSrc(),MEDIA_PLACEHOLDER_SRC);
  assert.equal(object.objectCaching,false);
  const dimensions=pdfPageGeometry({width:100,scaleX:2,scaleY:1},{width:200,height:100});
  assert.equal(dimensions.height,100);assert.equal(dimensions.width,100);
});
test('cross-board copying registers media references without duplicating history bytes',async()=>{
  const value={objects:[{type:'Image',mediaAssetId:'a'.repeat(64),mediaKind:'pdf',src:MEDIA_PLACEHOLDER_SRC,pageNumber:2}]};
  const calls=[];
  const copied=await copySerializedBoardImages(value,'target',{register:async(board,id)=>calls.push([board,id])});
  assert.deepEqual(copied,value);assert.notEqual(copied,value);assert.deepEqual(calls,[['target','a'.repeat(64)]]);
});

test('media inside groups hydrates once and releases when the group leaves',async()=>{
  const {createBoardMediaRuntime}=await import('../src/lib/boardMediaRuntime.js');
  const events=new Map();let created=0,disposed=0;
  const image={mediaKind:'gif',mediaAssetId:'b'.repeat(64),width:1,height:1,setElement(){},set(v){Object.assign(this,v);},setCoords(){}};
  const group={getObjects:()=>[image]};const objects=[group];
  const canvas={getObjects:()=>objects,on:(event,fn)=>events.set(event,fn),off:()=>{},requestRenderAll(){}};
  const runtime=createBoardMediaRuntime({canvas,boardId:'room',store:{get:async()=>({metadata:{kind:'gif'},blob:new Blob()})},gifFactory:async()=>{created++;return {width:1,height:1,element:{width:1,height:1},advance:async()=>({changed:false,nextDelayMs:null}),dispose(){disposed++;}};}});
  await new Promise(ok=>setTimeout(ok,0));assert.equal(created,1);
  objects.length=0;events.get('object:removed')({target:group});runtime.dispose();assert.equal(disposed,1);
});

test('deleting a PDF during hydration cannot attach late pixels',async()=>{
  const {createBoardMediaRuntime}=await import('../src/lib/boardMediaRuntime.js');
  let resolve,disposed=0,attached=0;
  const image={mediaKind:'pdf',mediaAssetId:'c'.repeat(64),width:1,height:1,setElement(){attached++;},set(){}};
  const events=new Map(),objects=[image];
  const canvas={getObjects:()=>objects,on:(e,fn)=>events.set(e,fn),off(){},requestRenderAll(){}};
  const runtime=createBoardMediaRuntime({canvas,boardId:'room',store:{get:async()=>({metadata:{kind:'pdf'},blob:new Blob()})},pdfFactory:()=>new Promise(ok=>resolve=ok)});
  await new Promise(ok=>setTimeout(ok,0));objects.length=0;events.get('object:removed')({target:image});
  resolve({dispose(){disposed++;}});await new Promise(ok=>setTimeout(ok,0));runtime.dispose();assert.equal(attached,0);assert.equal(disposed,1);
});
test('temporarily unavailable media retries hydration when the file arrives',async t=>{
  const {createBoardMediaRuntime}=await import('../src/lib/boardMediaRuntime.js');
  let now=0,available=false,attached=0;
  t.mock.method(Date,'now',()=>now);
  const image={mediaKind:'gif',mediaAssetId:'d'.repeat(64),width:1,height:1,setElement(){attached++;},set(v){Object.assign(this,v);},setCoords(){}};
  const events=new Map();
  const canvas={getObjects:()=>[image],on:(e,fn)=>events.set(e,fn),off(){},requestRenderAll(){}};
  const runtime=createBoardMediaRuntime({canvas,boardId:'room',store:{get:async()=>available?{metadata:{kind:'gif'},blob:new Blob()}:null},gifFactory:async()=>({width:1,height:1,element:{width:1,height:1},advance:async()=>({changed:false,nextDelayMs:null}),dispose(){}})});
  try {await new Promise(ok=>setTimeout(ok,0));available=true;now=4000;events.get('after:render')();
    await new Promise(ok=>setTimeout(ok,0));assert.equal(attached,1);
  } finally {runtime.dispose();}
});
test('pasted grouped media must reach authority before insertion and deduplicates references',async()=>{
  const {ensureSerializedMediaAssets}=await import('../src/lib/imageStorage.js');
  const id='f'.repeat(64),group=[{type:'Group',objects:[{mediaAssetId:id},{mediaAssetId:id}]}];
  const order=[];let release;
  const pending=ensureSerializedMediaAssets(group,async assetId=>{assert.equal(assetId,id);order.push('upload');await new Promise(ok=>release=ok);order.push('authority-ready');});
  await Promise.resolve();assert.deepEqual(order,['upload']);release();await pending;order.push('insert');assert.deepEqual(order,['upload','authority-ready','insert']);
  const source=(await import('node:fs')).readFileSync(new URL('../src/components/Board.jsx',import.meta.url),'utf8');
  const paste=source.slice(source.indexOf('  const pasteSelection ='),source.indexOf('  const pasteSelection =')+9000);
  assert.ok(paste.indexOf('await ensureSerializedMediaAssets')>=0&&paste.indexOf('await ensureSerializedMediaAssets')<paste.indexOf('const revived ='));
});

test('missing PDF shows progress then a persistent error, manual retry installs pixels and clears the card',async()=>{
  const {createBoardMediaRuntime}=await import('../src/lib/boardMediaRuntime.js');
  const object={mediaKind:'pdf',mediaAssetId:'e'.repeat(64),width:100,height:100,setElement(){},set(){},setCoords(){}};
  const canvas={getObjects:()=>[object],on(){},off(){},getZoom:()=>1,requestRenderAll(){}};
  const phases=[];let failing=true;
  const runtime=createBoardMediaRuntime({canvas,boardId:'room',store:{get:async()=>null},
    requestAsset:async(_id,{onProgress})=>{onProgress({phase:'receiving',loaded:50,total:100});if(failing)throw new Error('transfer disconnected');return {metadata:{kind:'pdf'},blob:new Blob()};},
    onStatusChange:()=>queueMicrotask(()=>phases.push(...runtime.getLoadStates().map(value=>value.phase))),
    pdfFactory:async()=>({renderPage:async()=>({element:{width:100,height:100},width:100,height:100}),dispose(){}})});
  try {
    await new Promise(resolve=>setTimeout(resolve,0));
    assert.equal(runtime.getLoadStates()[0].phase,'error');assert.match(runtime.getLoadStates()[0].error,/disconnected/);
    failing=false;await runtime.retry(object);assert.deepEqual(runtime.getLoadStates(),[]);
    assert.ok(phases.includes('receiving'));assert.ok(phases.includes('rendering'));
  }finally{runtime.dispose();}
});
