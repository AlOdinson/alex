// Real browser, IndexedDB, Web Locks, SCTP and live channels; local test signaling only.
// No TURN, no cloud credentials. This measures application recovery on a direct route.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright-core';
const engine = process.env.VERIFICATION_BROWSER ?? 'chromium';
const home = process.env.VERIFICATION_TEST_URL ?? 'http://127.0.0.1:5173/alex/';
if (!['127.0.0.1','localhost'].includes(new URL(home).hostname)) throw new Error('Local test origin required');
const browser = await (engine === 'webkit' ? webkit : chromium).launch({ headless:true, args:engine === 'webkit' ? [] : ['--no-sandbox','--disable-dev-shm-usage'] });
const pages = new Map(), pending = new Map(), results = [], errors = [], signals = [];
const boardId = `direct-${Date.now()}`;
const out = 'connection-direct-results'; await mkdir(out,{recursive:true});
const pause = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function wait(label, check, timeout=25000) {
  const end=Date.now()+timeout;
  while(Date.now()<end){if(await check())return;await pause(50);}
  throw new Error(`${label}: timed out`);
}
const user=(id,owner=false)=>({clientId:id,permission:owner?'owner':'edit',authorityReady:true,capabilities:{webrtcLiveV1:true}});
async function createPage(context,id,owner=false,createBoard=false) {
  const page=await context.newPage();pages.set(id,page);
  await page.route('**/__connection-test',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Connection regression</title>'}));
  await page.exposeFunction('routeSignal',payload=>{
    signals.push({source:payload.sourceId,target:payload.targetId,type:payload.signal?.type,attempt:payload.signal?.attemptId,id:payload.signal?.negotiationId,seq:payload.signal?.pathSequence});
    const target=pages.get(payload.targetId);
    if(target && !target.isClosed()) {
      // Ably-like asynchronous delivery: do not serialize SDP on the receipt of its answer.
      setTimeout(()=>target.evaluate(value=>{
        if(window.__session) return window.__session.handleRealtimeSignal(value);
        (window.__earlySignals??=[]).push(value);
      },payload).catch(error=>signals.push({deliveryError:error.message})),0);
    } else {const queued=pending.get(payload.targetId)??[];queued.push(payload);pending.set(payload.targetId,queued.slice(-128));}
    return 'ok';
  });
  page.on('pageerror',error=>errors.push({id,message:error.message}));
  await page.goto(`${home}__connection-test`);
  await page.evaluate(async ({boardId,id,owner,createBoard})=>{
    const {createBrowserBoardSession}=await import('/alex/src/lib/browserBoardSession.js');
    const {createTeacherBoardRuntime}=await import('/alex/src/lib/teacherBoardRuntime.js');
    const {createStudentBoardRuntime}=await import('/alex/src/lib/studentBoardRuntime.js');
    const {createTeacherPeerNetwork}=await import('/alex/src/lib/teacherPeerNetwork.js');
    const {createStudentPeerNetwork}=await import('/alex/src/lib/studentPeerNetwork.js');
    const {createBrowserPeerConnection}=await import('/alex/src/lib/browserPeerConnection.js');
    const {createDualPathPeerPair}=await import('/alex/src/lib/dualPathPeerPair.js');
    if(createBoard){const {createAuthorityBoard}=await import('/alex/src/lib/browserAuthorityStore.js');
      await createAuthorityBoard({boardId,ownerKey:'test-owner',shareKey:'test-share',realtimeKey:'test-share',guestMode:'edit',snapshot:{version:2,background:'grid',canvas:{objects:[]}}});}
    window.__connections=[];window.__pairs=[];window.__live=[];window.__states=[];window.__errors=[];
    const createConnection=options=>{const peer=createBrowserPeerConnection(options);window.__connections.push(peer);return peer;};
    const createPair=options=>{const pair=createDualPathPeerPair(options);window.__pairs.push(pair);return pair;};
    const session=createBrowserBoardSession({boardId,clientId:id,permission:owner?'owner':'edit',webrtcLiveV1:true,
      sendScreenShareSignal:payload=>window.routeSignal(JSON.parse(JSON.stringify(payload))),
      onLiveEvent:(type,payload,envelope)=>window.__live.push({type,payload,envelope}),
      onRuntimeState:(state,detail)=>window.__states.push({state,detail}),onError:error=>window.__errors.push(error.message),
      createTeacherRuntime:options=>createTeacherBoardRuntime({...options,createNetwork:o=>createTeacherPeerNetwork({...o,createConnection,createPair})}),
      createStudentRuntime:options=>createStudentBoardRuntime({...options,createNetwork:o=>createStudentPeerNetwork({...o,createConnection,createPair})}),
    });
    window.__session=session;window.__starting=session.start();window.__starting.catch(error=>window.__errors.push(error.message));
    for(const payload of window.__earlySignals??[]) session.handleRealtimeSignal(payload);
  },{boardId,id,owner,createBoard});
  for(const payload of pending.get(id)??[])await page.evaluate(value=>window.__session.handleRealtimeSignal(value),payload);
  pending.delete(id);return page;
}
async function participants(page,list){await page.evaluate(users=>{window.__session.updateParticipants(users).catch(e=>window.__errors.push(e.message));},list);}
async function ready(page){return page.evaluate(()=>window.__session.getRuntimeState()==='ready');}
async function revision(page){return page.evaluate(()=>window.__session.getRevision());}
async function change(page,id){return page.evaluate(id=>window.__session.sendOps([{type:'upsert',object:{boardObjectId:id,type:'rect',left:10,top:20,width:30,height:40}}],{actionId:id}),id);}
async function live(page,x){return page.evaluate(x=>window.__session.sendLive('cursor',{clientId:'student-a',x,y:2}),x);}
let owner,s1,s2;
try {
  const ownerContext=await browser.newContext();
  owner=await createPage(ownerContext,'owner',true,true);
  s1=await createPage(await browser.newContext(),'student-a');
  s2=await createPage(await browser.newContext(),'student-b');
  const users=[user('owner',true),user('student-a'),user('student-b')];
  await wait('owner authority',()=>ready(owner));
  await Promise.all([participants(owner,users),participants(s1,users),participants(s2,users)]);
  await wait('two students ready',async()=>await ready(s1)&&await ready(s2));
  await change(s1,'student-shape');await wait('durable fanout',async()=>await revision(owner)===1&&await revision(s2)===1);
  await wait('live channels',()=>owner.evaluate(()=>window.__connections.filter(p=>p.getDataChannel()?.readyState==='open').every(p=>p.getLiveDataChannel()?.readyState==='open')));
  await live(s1,41);await wait('group live fanout',()=>s2.evaluate(()=>window.__live.some(e=>e.payload.x===41&&e.envelope.clientId==='student-a')));
  results.push('direct join, durable edits and group live relay');

  await owner.evaluate(()=>{window.__restartPeer=window.__connections.find(p=>p.getDataChannel()?.readyState==='open');window.__durable=window.__restartPeer.getDataChannel();window.__recoverPair=window.__pairs.find(p=>p.canProbe());window.__recoverPair.recover();});
  await wait('ICE restart answer',()=>owner.evaluate(async()=>(await window.__restartPeer.getDiagnostics()).iceRevision===1&&window.__restartPeer.getPeerConnection().signalingState==='stable'));
  await wait('pair recovery watchdog settled',()=>owner.evaluate(async()=>!(await window.__recoverPair.getDiagnostics()).recovering));
  assert.equal(await owner.evaluate(()=>window.__restartPeer.getDataChannel()===window.__durable),true);
  await change(s1,'after-ice');await wait('edits after ICE restart',async()=>await revision(s2)===2);
  results.push('native ICE restart keeps durable channel and edits');

  await owner.evaluate(()=>{window.__retiredLive=window.__restartPeer.getLiveDataChannel();window.__retiredLive.close();});
  await wait('live replacement',()=>owner.evaluate(()=>window.__restartPeer.getLiveDataChannel()!==window.__retiredLive&&window.__restartPeer.getLiveDataChannel()?.readyState==='open'));
  await live(s1,99);await wait('live after replacement',()=>s2.evaluate(()=>window.__live.some(e=>e.payload.x===99)));
  await s1.evaluate(()=>window.__session.recoverConnections());
  assert.equal(await ready(s1),true);results.push('live-only repair and wake probe');

  const replacement=await createPage(ownerContext,'owner-next',true,false);
  assert.equal(await ready(replacement),false,'another owner tab must wait for Web Lock');
  await owner.close();pages.delete('owner');owner=replacement;
  await wait('owner reload reacquires native lock',()=>ready(owner));
  const nextUsers=[user('owner-next',true),user('student-a'),user('student-b')];
  await Promise.all([participants(owner,nextUsers),participants(s1,nextUsers),participants(s2,nextUsers)]);
  await wait('students rejoin new owner',async()=>await ready(s1)&&await ready(s2));
  assert.equal(await revision(owner),2,'IndexedDB authority survives owner replacement');
  await change(s2,'after-reload');await wait('durable edit after owner reload',async()=>await revision(owner)===3&&await revision(s1)===3);
  results.push('exclusive owner tab handoff, persisted board and student reconnect');
  assert.deepEqual(errors,[]);
  const diagnostics=await owner.evaluate(()=>window.__session.getConnectionDiagnostics());
  for(const peer of diagnostics)assert.notEqual(peer.route?.localType,'relay');
  await writeFile(`${out}/${engine}.json`,JSON.stringify({engine,results,diagnostics,errors},null,2));
  console.log(JSON.stringify({engine,results,errors}));
} catch(error) {
  const evidence={engine,results,error:error.stack,errors,signals,pages:{}};
  for(const [id,page] of pages){if(!page.isClosed())evidence.pages[id]=await page.evaluate(async()=>({states:window.__states,errors:window.__errors,connections:await window.__session?.getConnectionDiagnostics?.(),native:window.__connections?.map(p=>({local:p.getPeerConnection().localDescription?.type,remote:p.getPeerConnection().remoteDescription?.type,state:p.getPeerConnection().signalingState}))})).catch(()=>null);}
  await writeFile(`${out}/${engine}-failure.json`,JSON.stringify(evidence,null,2));throw error;
} finally {await browser.close();}
