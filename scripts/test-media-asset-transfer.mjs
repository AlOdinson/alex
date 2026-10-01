import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
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

test('download progress survives shared requests and reaches verification before resolving',async()=>{
  const a=persistentFake(),b=persistentFake(),progress=[];let left,right;
  const meta=await a.importFile('room',Object.assign(new Blob(['%PDF-1.7\n'+'x'.repeat(40_000)]),{name:'book.pdf'}));
  left=createMediaAssetTransfer({boardId:'room',store:a,send:(type,payload)=>right.handleMessage({type,payload})});
  right=createMediaAssetTransfer({boardId:'room',store:b,send:(type,payload)=>left.handleMessage({type,payload})});
  const [first,second]=await Promise.all([right.request(meta.assetId,{onProgress:value=>progress.push(value)}),right.request(meta.assetId,{onProgress:()=>{throw new Error('observer failure');}})]);
  assert.equal(first.metadata.assetId,second.metadata.assetId);
  assert.equal(progress[0].phase,'receiving');assert.equal(progress[0].percent,0);
  assert.ok(progress.some(value=>value.percent>0&&value.percent<100));
  assert.equal(progress.at(-1).phase,'verifying');assert.equal(progress.at(-1).loaded,meta.size);
  left.close();right.close();
});
test('new lesson receives verified bytes before claiming an existing global original',async()=>{
  const a=createMediaAssetStore({indexedDB:new IDBFactory(),crypto:webcrypto});
  const b=createMediaAssetStore({indexedDB:new IDBFactory(),crypto:webcrypto});
  const blob=Object.assign(new Blob(['GIF89ashared']),{name:'animation.gif'});
  const meta=await a.importFile('new',blob);await b.importFile('old',blob);
  let left,right;const frames=[];
  left=createMediaAssetTransfer({boardId:'new',store:a,send:async(type,payload)=>{
    frames.push(type);
    if(type==='asset-chunk'||type==='asset-end')assert.equal(await b.get('new',meta.assetId),null);
    return right.handleMessage({type,payload});
  }});
  right=createMediaAssetTransfer({boardId:'new',store:b,send:(type,payload)=>left.handleMessage({type,payload})});
  const received=await right.request(meta.assetId);
  assert.deepEqual(frames,['asset-start','asset-chunk','asset-end']);
  assert.equal(await received.blob.text(),'GIF89ashared');
  assert.ok(await b.get('new',meta.assetId));left.close();right.close();
});
test('unsolicited asset-start cannot claim a foreign original or enable disclosure',async()=>{
  const disk=createMediaAssetStore({indexedDB:new IDBFactory(),crypto:webcrypto}),replies=[];
  const meta=await disk.importFile('private',Object.assign(new Blob(['GIF89aprivate']),{name:'private.gif'}));
  const receiver=createMediaAssetTransfer({boardId:'public',store:disk,send:async(type,payload)=>replies.push({type,payload})});
  const p={boardId:'public',transferId:'probe',assetId:meta.assetId};
  await receiver.handleMessage({type:'asset-start',payload:{...p,metadata:meta,totalChunks:1}});
  assert.equal(replies.at(-1).payload.status,'ready');
  assert.equal(await disk.get('public',meta.assetId),null);
  await receiver.handleMessage({type:'asset-request',payload:{...p,transferId:'read'}});
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(replies.at(-1).payload.status,'error');
  assert.ok(replies.every(reply=>reply.type==='asset-result'));
  assert.equal(await disk.get('public',meta.assetId),null);receiver.close();
});
test('global originals are not disclosed or claimed by unauthorized inbound messages',async()=>{
  const disk=createMediaAssetStore({indexedDB:new IDBFactory(),crypto:webcrypto}),replies=[];
  const meta=await disk.importFile('private',Object.assign(new Blob(['GIF89aprivate']),{name:'private.gif'}));
  const receiver=createMediaAssetTransfer({boardId:'public',store:disk,canUpload:async()=>false,send:async(type,payload)=>replies.push({type,payload})});
  const p={boardId:'public',transferId:'probe',assetId:meta.assetId};
  await receiver.handleMessage({type:'asset-request',payload:p});
  // The upload is intentionally detached from the message dispatcher.
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(replies.length,1);assert.equal(replies[0].payload.status,'error');
  await receiver.handleMessage({type:'asset-start',payload:{...p,metadata:meta,totalChunks:1}});
  assert.match(replies.at(-1).payload.error,/прав/);
  assert.equal(await disk.get('public',meta.assetId),null);receiver.close();
});
test('unavailable storage still requests transfer and rejects an unpersisted receipt',async()=>{
  const sender=store(),receiverStore=store();let left,right;const frames=[];
  const blob=Object.assign(new Blob(['GIF89afallback']),{name:'fallback.gif'});
  const meta=await sender.importFile('new',blob);await receiverStore.importFile('old',blob);
  left=createMediaAssetTransfer({boardId:'new',store:sender,send:(type,payload)=>right.handleMessage({type,payload})});
  right=createMediaAssetTransfer({boardId:'new',store:receiverStore,send:async(type,payload)=>{frames.push(type);return left.handleMessage({type,payload});}});
  await assert.rejects(right.request(meta.assetId),/сохран/);
  assert.ok(frames.includes('asset-request'));assert.equal((await receiverStore.get('new',meta.assetId)).persisted,false);
  left.close();right.close();
});
