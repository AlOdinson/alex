import test from 'node:test';
import assert from 'node:assert/strict';
import { createVerificationView, applyVerificationRecords, validVerificationRecords } from '../src/lib/boundedVerificationState.js';
import { buildVerificationReply } from '../src/lib/boundedVerificationProtocol.js';
import { applyAuthorityOpsInPlace } from '../src/lib/authoritySnapshot.js';
import { verificationDigest } from '../src/lib/boundedVerificationDigest.js';
const api=await import('../src/lib/notebookVerification.js').catch(()=>({}));
const records=await import('../src/lib/notebookRecords.js').catch(()=>({}));
const freeze=value=>{assert.equal(typeof records.freezeNotebookRecord,'function');return records.freezeNotebookRecord(value);};
const ink=id=>({type:'Path',boardObjectId:id,path:[['M',1,2],['L',3,4]],stroke:'black'});
const book=(pages=20)=>({type:'BoardNotebook',boardObjectId:'book',left:10,notebookPageNumber:pages,notebookPages:Array.from({length:pages},(_,p)=>[ink(`p${p}`)])});
const state=object=>({version:2,background:'grid',canvas:{objects:[object]}});
const viewFor=snapshot=>createVerificationView({notebookVersion:1,getSnapshot:()=>snapshot,getRevision:()=>5});
const request=entries=>({version:1,digestVersion:2,requestId:'r',epoch:'e',revision:5,entries});
const fingerprint=async(view,id='book')=>{assert.equal(typeof view.fingerprint,'function');return view.fingerprint(view.read(id));};

test('warm page digest caches read no unchanged hidden children after one new stroke',async()=>{
  const counts=Array(20).fill(0),notebook=book();
  notebook.notebookPages=notebook.notebookPages.map((page,p)=>page.map(child=>{
    const path=child.path;
    return {...child,get path(){counts[p]++;return path;}};
  }));
  freeze(notebook.notebookPages); const snapshot=state(notebook),view=viewFor(snapshot);
  const first=await fingerprint(view);assert.equal(view.digestVersion(),2);
  counts.fill(0);
  applyAuthorityOpsInPlace(snapshot,[{type:'notebook',version:1,id:'book',pageNumber:20,changes:[{type:'insert',object:ink('new'),ifAbsent:true}]}]);
  const next=await fingerprint(view);
  assert.notEqual(next.hash,first.hash);
  assert.deepEqual(counts,Array(20).fill(0));
  assert.deepEqual(next.notebook.pageHashes.slice(0,19),first.notebook.pageHashes.slice(0,19));
  assert.notEqual(next.notebook.pageHashes[19],first.notebook.pageHashes[19]);
});

test('frame and content fingerprints are distinct; frame motion does not reread page pixels',async()=>{
  const notebook=book(2);freeze(notebook.notebookPages);const snapshot=state(notebook),view=viewFor(snapshot);
  const before=await fingerprint(view);
  applyAuthorityOpsInPlace(snapshot,[{type:'transform',id:'book',transform:{left:200}}]);
  const after=await fingerprint(view);
  assert.notEqual(before.hash,after.hash);assert.notEqual(before.notebook.frameHash,after.notebook.frameHash);
  assert.deepEqual(before.notebook.pageHashes,after.notebook.pageHashes);
});

test('unregistered mutable or only shallow-frozen records are not incorrectly cached',async()=>{
  assert.equal(typeof api.createNotebookVerificationCache,'function');
  const cache=api.createNotebookVerificationCache(),notebook=book(1),record={id:'book',zIndex:0,object:notebook};
  Object.freeze(notebook.notebookPages[0]);
  const first=await cache.fingerprint(record);
  notebook.notebookPages[0][0].stroke='blue';
  const next=await cache.fingerprint(record);
  assert.notEqual(first.hash,next.hash);
});

test('versioned notebook digest remains canonical over JSON transport and page ordering',async()=>{
  const notebook=book(2);notebook.notebookPages[0][0].unused=undefined;
  const first=await fingerprint(viewFor(state(notebook)));
  const copied=JSON.parse(JSON.stringify(notebook));
  assert.deepEqual(await fingerprint(viewFor(state(copied))),first);
  copied.notebookPages.reverse();assert.notEqual((await fingerprint(viewFor(state(copied)))).hash,first.hash);
  assert.notEqual(first.hash,await verificationDigest({id:'book',zIndex:0,object:notebook}));
});

test('a frame-only repair retains every already-correct page reference',async()=>{
  const source=state(book()),replica=structuredClone(source);replica.canvas.objects[0].left=999;
  const oldPages=replica.canvas.objects[0].notebookPages;
  const local=await fingerprint(viewFor(replica));
  const reply=await buildVerificationReply(viewFor(source),request([{id:'book',...local}]),'e');
  assert.equal(reply.status,'ok');assert.equal(reply.digestVersion,2);assert.equal(reply.repairs.length,1);
  assert.deepEqual(reply.repairs[0].notebookRepair.pages,[]);
  assert.equal(Object.hasOwn(reply.repairs[0].object,'notebookPages'),false);
  assert.equal(applyVerificationRecords(replica,reply.repairs),true);
  assert.equal(replica.canvas.objects[0].left,10);
  assert.equal(replica.canvas.objects[0].notebookPages,oldPages);
});

test('only the divergent page is returned and installed; all other page records stay by reference',async()=>{
  const source=state(book()),replica=structuredClone(source);
  replica.canvas.objects[0].notebookPages[19][0].stroke='red';
  const oldPages=replica.canvas.objects[0].notebookPages;
  const local=await fingerprint(viewFor(replica));
  const reply=await buildVerificationReply(viewFor(source),request([{id:'book',...local}]),'e');
  assert.equal(reply.status,'ok');assert.equal(reply.repairs[0].notebookRepair.pages.length,1);
  assert.equal(reply.repairs[0].notebookRepair.pages[0].pageNumber,20);
  assert.equal(applyVerificationRecords(replica,reply.repairs),true);
  assert.deepEqual(replica,source);
  for(let i=0;i<19;i++)assert.equal(replica.canvas.objects[0].notebookPages[i],oldPages[i]);
});

test('mismatched fingerprint versions never cause a false whole-notebook repair',async()=>{
  const source=state(book()),view=viewFor(source);
  assert.equal(typeof view.digestVersion,'function');
  const reply=await buildVerificationReply(view,{...request([{id:'book',hash:'0'.repeat(64)}]),digestVersion:1},'e');
  assert.equal(reply.status,'incompatible');assert.equal(reply.repairs,undefined);
});

test('malformed targeted page repairs fail atomically before any unrelated object changes',()=>{
  const snapshot=state(book(2));const before=structuredClone(snapshot);
  const partial={id:'book',zIndex:0,object:{type:'BoardNotebook',boardObjectId:'book',left:200},notebookRepair:{version:1,pageCount:2,pages:[{pageNumber:3,objects:[ink('bad')]}]}};
  assert.equal(validVerificationRecords([partial]),false);
  assert.equal(applyVerificationRecords(snapshot,[partial]),false);assert.deepEqual(snapshot,before);
});

test('revision/generation fence cancels an in-flight notebook fingerprint',async()=>{
  const snapshot=state(book(20)),view=viewFor(snapshot);assert.equal(typeof view.fingerprint,'function');
  let clock=0,changed=false;
  const reply=await buildVerificationReply(view,request([{id:'book',hash:'0'.repeat(64)}]),'e',{
    now:()=>++clock,yieldControl:async()=>{if(!changed){changed=true;applyAuthorityOpsInPlace(snapshot,[{type:'patch',id:'book',patch:{left:30}}]);}},
  });
  assert.equal(reply.status,'stale');assert.equal(reply.repairs,undefined);
});

test('Canvas verification reuses hidden page hashes but still checks the actually visible children',async()=>{
  const {createBoundedCanvasVerifier}=await import('../src/lib/boundedCanvasVerifier.js');
  const {createVerificationBudget}=await import('../src/lib/boundedVerificationDigest.js');
  const counts=Array(20).fill(0),notebook=book();
  notebook.notebookPages=notebook.notebookPages.map((page,p)=>page.map(child=>{const path=child.path;return {...child,get path(){counts[p]++;return path;}};}));
  freeze(notebook.notebookPages);
  const actual={...notebook,notebookPages:freeze(structuredClone(notebook.notebookPages)),_objects:structuredClone(notebook.notebookPages[19])};
  actual.getPageObjects=()=>actual._objects;
  const canvas={_objects:[actual]},registry=new Map([['book',new Set([actual])]]),repairs=[];
  const verifier=createBoundedCanvasVerifier({getCanvas:()=>canvas,getRegistry:()=>registry,getRevision:()=>5,getBackground:()=> 'grid',placementMatches:(a,b)=>a.left===b.left,apply:async rows=>{repairs.push(rows);return true;}});
  const context=()=>({revision:5,background:'grid',isCurrent:()=>true,budget:createVerificationBudget()});
  assert.equal(await verifier.check([{id:'book',object:notebook,zIndex:0}],context()),true);
  assert.equal(repairs.length,0);counts.fill(0);
  assert.equal(await verifier.check([{id:'book',object:notebook,zIndex:0}],context()),true);
  assert.deepEqual(counts.slice(0,19),Array(19).fill(0));
  actual._objects=[];
  await verifier.check([{id:'book',object:notebook,zIndex:0}],context());
  assert.equal(repairs.length,1,'matching serialized state cannot hide missing visible ink');
});
