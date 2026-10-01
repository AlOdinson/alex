import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createMediaAssetStore } from '../src/lib/mediaAssetStore.js';
import { createMediaAssetTransfer } from '../src/lib/mediaAssetTransfer.js';
import { createPeerMessage, peerFrameByteLength, MAX_PEER_FRAME_BYTES } from '../src/lib/peerProtocol.js';
const store=()=>createMediaAssetStore({indexedDB:null,crypto:webcrypto});
const persistentFake=()=>{const base=store();return {...base,async importFile(...args){return {...await base.importFile(...args),persisted:true};},async get(...args){const record=await base.get(...args);return record?{...record,persisted:true}:null;}};};
test('upload, hash verification, dedup and request by room',async()=>{
  const a=persistentFake(),b=persistentFake(), sent=[];
  const meta=await a.importFile('room',Object.assign(new Blob(['%PDF-1.7\n'+ 'x'.repeat(30_000)]),{name:'file.pdf'}));
  let left,right;
  left=createMediaAssetTransfer({boardId:'room',store:a,send:async(type,payload)=>{sent.push({type,payload}); await right.handleMessage({type,payload});}});
  right=createMediaAssetTransfer({boardId:'room',store:b,send:async(type,payload)=>left.handleMessage({type,payload})});
  await left.ensureRemote(meta.assetId);
    assert.equal((await b.get('room',meta.assetId)).blob.size,meta.size);
    assert.ok(sent.every(m=>peerFrameByteLength(createPeerMessage(m.type,m.payload))<=MAX_PEER_FRAME_BYTES));
  assert.ok(sent.filter(m=>m.type==='asset-chunk').length>1);
  const chunks=sent.filter(m=>m.type==='asset-chunk').length;
  await left.ensureRemote(meta.assetId); assert.equal(sent.filter(m=>m.type==='asset-chunk').length,chunks);
  assert.equal(await b.get('other',meta.assetId),null);
  assert.equal((await right.request(meta.assetId)).metadata.assetId,meta.assetId);
  left.close();right.close();
});
test('active reception outlives the inactivity timeout, stalled reception is released',async()=>{
  const a=store(),b=persistentFake(),replies=[];
  const bytes='%PDF-1.7\n'+'x'.repeat(20_000);
  const meta=await a.importFile('room',Object.assign(new Blob([bytes]),{name:'large.pdf'}));
  const receiver=createMediaAssetTransfer({boardId:'room',store:b,timeoutMs:80,send:async(type,payload)=>replies.push({type,payload})});
  const p={boardId:'room',transferId:'slow',assetId:meta.assetId};
  await receiver.handleMessage({type:'asset-start',payload:{...p,metadata:meta,totalChunks:Math.ceil(bytes.length/8192)}});
  for(let offset=0;offset<bytes.length;offset+=8192){
    await new Promise(r=>setTimeout(r,55));
    await receiver.handleMessage({type:'asset-chunk',payload:{...p,index:offset/8192,base64Chunk:btoa(bytes.slice(offset,offset+8192))}});
  }
  await receiver.handleMessage({type:'asset-end',payload:p});
  assert.equal(replies.at(-1).payload.status,'complete');
  const stalled={...p,assetId:'b'.repeat(64),transferId:'stalled'};
  await receiver.handleMessage({type:'asset-start',payload:{...stalled,metadata:{...meta,assetId:stalled.assetId},totalChunks:3}});
  await new Promise(r=>setTimeout(r,100));
  assert.match(replies.at(-1).payload.error,/прервана/); receiver.close();
});
test('corrupt hash and cross-room request never register/disclose bytes',async()=>{
  const a=store(),b=store(),replies=[];
  const meta=await a.importFile('room',Object.assign(new Blob(['GIF89a123']),{name:'a.gif'}));
  const receiver=createMediaAssetTransfer({boardId:'room',store:b,send:async(type,payload)=>replies.push({type,payload})});
  const p={boardId:'room',transferId:'test',assetId:meta.assetId};
  await receiver.handleMessage({type:'asset-start',payload:{...p,metadata:meta,totalChunks:1}});
  await receiver.handleMessage({type:'asset-chunk',payload:{...p,index:0,base64Chunk:btoa('GIF89a321')}});
  await receiver.handleMessage({type:'asset-end',payload:p});
  assert.equal(await b.get('room',meta.assetId),null);assert.match(replies.at(-1).payload.error,/целостност/);
  const count=replies.length;
  await receiver.handleMessage({type:'asset-request',payload:{...p,boardId:'other'}});
  assert.equal(replies.length,count);receiver.close();
});
test('view-only upload rejected and close releases pending requests',async()=>{
  const a=store(),b=store(); let left,right;
  const meta=await a.importFile('room',Object.assign(new Blob(['GIF89a123']),{name:'a.gif'}));
  left=createMediaAssetTransfer({boardId:'room',store:a,send:(type,payload)=>right.handleMessage({type,payload})});
  right=createMediaAssetTransfer({boardId:'room',store:b,canUpload:async()=>false,send:(type,payload)=>left.handleMessage({type,payload})});
  await assert.rejects(left.ensureRemote(meta.assetId),/прав|view|edit/i);
  assert.equal(await b.get('room',meta.assetId),null); left.close();right.close();
  const solo=createMediaAssetTransfer({boardId:'room',store:b,send:async()=>{}});
  const waiting=solo.request('a'.repeat(64)); solo.close(); await assert.rejects(waiting,/closed|закрыт/i);
});
test('receiver never confirms a media file that could not be persisted',async()=>{
  const a=store(),b=store();let left,right;
  const meta=await a.importFile('room',Object.assign(new Blob(['GIF89a123']),{name:'a.gif'}));
  left=createMediaAssetTransfer({boardId:'room',store:a,send:(type,payload)=>right.handleMessage({type,payload})});
  right=createMediaAssetTransfer({boardId:'room',store:b,send:(type,payload)=>left.handleMessage({type,payload})});
  await assert.rejects(left.ensureRemote(meta.assetId),/сохран/);
  await assert.rejects(left.ensureRemote(meta.assetId),/сохран/);
  left.close();right.close();
});
