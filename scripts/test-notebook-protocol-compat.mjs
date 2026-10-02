import test from 'node:test';
import assert from 'node:assert/strict';
import { createTeacherPeerHub } from '../src/lib/teacherPeerHub.js';
import { createStudentPeerSession } from '../src/lib/studentPeerSession.js';
import { applyReplicaCommit, installReplicaSnapshot, getReplicaRevision } from '../src/lib/browserReplicaStore.js';
import { readStudentOfflineSnapshot } from '../src/lib/studentOfflineCache.js';
const operation = (version=1)=>({type:'notebook',version,id:'book',pageNumber:1,changes:[{type:'insert',ifAbsent:true,object:{type:'Path',boardObjectId:'ink',path:[['M',0,0],['L',1,1]]}}]});
const baseline=()=>({version:2,background:'grid',canvas:{objects:[{type:'BoardNotebook',boardObjectId:'book',notebookPages:[[]],notebookPageNumber:1}]}});
const transport=()=>({sent:[],transfers:[],async send(type,payload){this.sent.push({type,payload});},async sendTextTransfer(kind,text){this.transfers.push({kind,...JSON.parse(text)});}});
function hubFixture({required=0}={}){
  let committed=0, snapshots=0;
  const authority={getRevision:()=>7,getNotebookVersion:()=>1,getNotebookRequirement:()=>required,
    async commitAction(action){committed++;return {...action,revision:8,changed:true};}};
  const hub=createTeacherPeerHub({authority,getSnapshot:async()=>{snapshots++;return{snapshot:baseline(),revision:7};},getCommitsAfter:async()=>[]});
  return {hub, get committed(){return committed;},get snapshots(){return snapshots;}};
}

test('legacy participant receives a read-only update notice, never an unrecognized child delta',async()=>{
  const fixture=hubFixture({required:1}),peer=transport(); fixture.hub.addPeer('old',peer);
  await fixture.hub.handleMessage('old',{type:'head-request',payload:{}});
  assert.ok(peer.sent.some(m=>m.type==='board-control'&&m.payload.event==='mode'&&m.payload.payload.mode==='view'));
  assert.equal(peer.transfers.length,1);
  assert.match(peer.transfers[0].snapshot.canvas.objects[0].text,/обнов|[Rr]efresh/);
  await fixture.hub.broadcastCommit({revision:8,ops:[operation()]});
  assert.equal(peer.sent.some(m=>m.type==='commit'),false);
  assert.equal(fixture.snapshots,0,'notice must not serialize the complete notebook');
  await fixture.hub.handleMessage('old',{type:'action-proposal',payload:{actionId:'spoof',notebookVersion:1,ops:[{type:'delete',id:'book'}]}});
  assert.equal(fixture.committed,0);
  const ack=peer.sent.find(m=>m.type==='ack'); assert.equal(ack.payload.accepted,false);
  assert.match(ack.payload.error,/обнов|update/i);
});

test('capabilities are learned from handshake and gate first migration against older peers',async()=>{
  const fixture=hubFixture(),fresh=transport(),old=transport();
  fixture.hub.addPeer('fresh',fresh);fixture.hub.addPeer('old',old);
  await fixture.hub.handleMessage('fresh',{type:'head-request',payload:{notebookVersion:1}});
  assert.equal(fresh.sent.at(-1).payload.notebookVersion,1);
  assert.equal(typeof fixture.hub.assertNotebookAction,'function');
  await assert.rejects(async()=>fixture.hub.assertNotebookAction([operation()]),/обнов|update/i);
  fixture.hub.removePeer('old');
  await fixture.hub.assertNotebookAction([operation()]);
  await fixture.hub.handleMessage('fresh',{type:'action-proposal',payload:{actionId:'draw',ops:[operation()]}});
  assert.equal(fixture.committed,1);
  assert.equal(fresh.sent.find(m=>m.type==='commit').payload.ops[0].type,'notebook');
});

test('replacement transport must renegotiate and stale cleanup cannot remove fresh capabilities',async()=>{
  const {hub}=hubFixture(), first=transport(), second=transport();
  const stale=hub.addPeer('same',first);
  await hub.handleMessage('same',{type:'head-request',payload:{notebookVersion:1}});
  hub.addPeer('same',second);
  assert.equal(typeof hub.assertNotebookAction,'function');
  await assert.rejects(async()=>hub.assertNotebookAction([operation()]),/обнов|update/i);
  await hub.handleMessage('same',{type:'head-request',payload:{notebookVersion:1}});
  stale();
  await hub.assertNotebookAction([operation()]);
  assert.equal(hub.getPeerCount(),1);
});

test('student advertises support only when enabled and refuses notebook proposals to an old teacher',async()=>{
  const peer=transport(); const session=createStudentPeerSession({transport:peer,enableNotebookOperations:true,getRevision:()=>2,applyCommit:async()=>{},installSnapshot:async()=>{}});
  const ready=session.start();
  assert.equal(peer.sent[0].payload.notebookVersion,1);
  await session.handleMessage({type:'head',payload:{revision:2}}); await ready;
  await assert.rejects(async()=>session.proposeAction({actionId:'new',ops:[operation()]}),/обнов|update/i);
  await session.handleMessage({type:'head',payload:{revision:2,notebookVersion:1}});
  await session.proposeAction({actionId:'supported',ops:[operation()]});
  assert.equal(peer.sent.at(-1).payload.ops[0].type,'notebook');session.close();
});

test('disabled student never applies a child commit just because the payload claims a version',async()=>{
  let applied=0; const session=createStudentPeerSession({transport:transport(),getRevision:()=>0,applyCommit:async()=>{applied++;},installSnapshot:async()=>{}});
  await assert.rejects(session.handleMessage({type:'commit',payload:{revision:1,notebookVersion:1,ops:[operation()]}}),/обнов|update/i);
  assert.equal(applied,0);session.close();
});

test('unknown notebook wire version is rejected without partially applying mixed operations',async()=>{
  installReplicaSnapshot('unknown',baseline(),0);
  assert.throws(()=>applyReplicaCommit('unknown',{revision:1,ops:[{type:'delete',id:'book'},operation(2)]}),/обнов|update|notebook/i);
  assert.equal(getReplicaRevision('unknown'),0);
});

test('offline archive never reports a future notebook journal as successfully replayed',async()=>{
  const errors=[];const source={snapshot:baseline(),revision:0,commits:[{revision:1,ops:[operation(2)]}]};
  const result=await readStudentOfflineSnapshot('unknown','room',{storage:{read:async()=>source},onError:error=>errors.push(error)});
  assert.equal(result,null); assert.equal(errors.length,1);
  assert.equal(source.commits.length,1,'archive remains recoverable');
});

test('negotiated peer path sends 300 compact operations through the real hub, session and replica',async()=>{
  let revision=0;
  const commits=[];
  installReplicaSnapshot('pair',baseline(),0);
  const errors=[];
  let session,hub;
  const upstream={send:async(type,payload)=>hub.handleMessage('student',{type,payload})};
  const downstream={send:async(type,payload)=>session.handleMessage({type,payload}),sendTextTransfer:async(kind,text)=>session.handleTransfer({kind,text})};
  const authority={getRevision:()=>revision,getNotebookVersion:()=>1,getNotebookRequirement:()=>revision?1:0,async commitAction(action){const value={...action,revision:++revision,changed:true};commits.push(value);return value;}};
  hub=createTeacherPeerHub({authority,getSnapshot:async()=>({snapshot:baseline(),revision:0}),getCommitsAfter:async()=>commits});
  session=createStudentPeerSession({transport:upstream,enableNotebookOperations:true,getRevision:()=>getReplicaRevision('pair'),applyCommit:async value=>{assert.equal(applyReplicaCommit('pair',value).applied,true);},installSnapshot:async(snapshot,rev)=>installReplicaSnapshot('pair',snapshot,rev),onError:error=>errors.push(error)});
  hub.addPeer('student',downstream); await session.start();
  assert.equal(typeof session.getNotebookVersion,'function'); assert.equal(session.getNotebookVersion(),1);
  for(let i=0;i<300;i++) {const op=operation();op.changes[0].object.boardObjectId=`ink-${i}`;const ack=await session.proposeActionAndWait({actionId:`ink-${i}`,ops:[op]});assert.equal(ack.accepted,true);}
  assert.equal(revision,300);assert.equal(getReplicaRevision('pair'),300);assert.deepEqual(errors,[]);session.close();
});

test('a new connection is not mislabeled as a legacy viewer before its capability handshake',async()=>{
 const fixture=hubFixture({required:1}),fresh=transport();fixture.hub.addPeer('fresh',fresh);
 await fixture.hub.broadcastCommit({revision:8,ops:[operation()]});
 assert.equal(fresh.sent.length,0,'do not downgrade an unnegotiated updated client');
 assert.equal(fresh.transfers.length,0,'initial head/snapshot recovery supplies any missed commit');
 await fixture.hub.handleMessage('fresh',{type:'head-request',payload:{notebookVersion:1}});
 assert.equal(fresh.sent.at(-1).type,'head');assert.equal(fresh.sent.at(-1).payload.notebookVersion,1);
 await fixture.hub.handleMessage('fresh',{type:'head-request',payload:{}});
 assert.equal(fresh.sent.some(message=>message.type==='board-control'),false,'ordinary later head requests retain known support');
});

test('a migrated notebook permits updated writers while a known legacy viewer receives an update notice',async()=>{
 const fixture=hubFixture({required:1}),fresh=transport(),old=transport();fixture.hub.addPeer('fresh',fresh);fixture.hub.addPeer('old',old);
 await fixture.hub.handleMessage('fresh',{type:'head-request',payload:{notebookVersion:1}});
 await fixture.hub.handleMessage('old',{type:'head-request',payload:{}});
 assert.ok(old.sent.some(message=>message.type==='board-control'&&message.payload.payload.mode==='view'));
 assert.doesNotThrow(()=>fixture.hub.assertNotebookAction([operation()],'fresh'));
 assert.throws(()=>fixture.hub.assertNotebookAction([operation()],'old'),/обнов|update/i);
 await fixture.hub.broadcastCommit({revision:8,ops:[operation()]});
 assert.equal(old.sent.some(message=>message.type==='commit'),false);assert.equal(fresh.sent.at(-1).type,'commit');
});
