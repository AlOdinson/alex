import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPeerSignalingAssistance } from '../src/lib/peerSignalingAssistance.js';
import { createDualPathPeerPair } from '../src/lib/dualPathPeerPair.js';
import { createBrowserBoardSession } from '../src/lib/browserBoardSession.js';
import { createStudentPeerNetwork } from '../src/lib/studentPeerNetwork.js';
import { createTeacherBoardRuntime } from '../src/lib/teacherBoardRuntime.js';
import { createTeacherTabAuthority } from '../src/lib/teacherTabAuthority.js';

// Regression scenarios from the connection audit; assertions describe repaired behavior.
const flush = async () => { for(let i=0;i<80;i++) await Promise.resolve(); };
const presence = [{clientId:'owner-a',permission:'owner',authorityReady:true,capabilities:{webrtcLiveV1:true}}];
const baseSession = {
  boardId:'audit-board',clientId:'student-a',permission:'edit',sendScreenShareSignal:async()=>{},
  getReplica:()=>({revision:1}),applyReplicaCommit:()=>({applied:true}),
  installReplicaSnapshot:()=>{},registerRuntime:()=>()=>{},
};

test('A: duplicate offer preserves active ICE replay',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const sent=[];
  const assist=createPeerSignalingAssistance({enabled:true,initiator:false,send:async s=>sent.push(s)});
  t.after(()=>assist.stop());
  assist.rememberCandidate({type:'ice',candidate:{candidate:'candidate:one'}});
  assist.rememberDescription({type:'answer',description:{type:'answer',sdp:'answer'}});
  t.mock.timers.tick(1000);await flush();
  assert.deepEqual(sent.map(s=>s.type),['answer']);
  // A duplicate offer invokes assistance.replay() in browserPeerConnection.
  assert.equal(assist.replay(),false);
  t.mock.timers.tick(75);await flush();
  assert.deepEqual(sent.map(s=>s.type),['answer','ice']);
});

test('B: stale path-switch cannot close a fresh owner negotiation',async t=>{
  const created=[];
  const pair=createDualPathPeerPair({localRole:'student',peerId:'owner-a',signaling:{send:async()=>{}},
    createConnection:options=>{
      const item={options,closes:0};created.push(item);
      return {start:async()=>{},handleSignal:async()=>{},close:()=>item.closes++};
    }});
  t.after(()=>pair.close());await pair.start();
  await pair.handleSignal({type:'offer',path:'owner-initiated',negotiationId:'current',description:{type:'offer',sdp:'current'}});
  assert.equal(pair.getCandidateState('owner-initiated').negotiationId,'current');
  await pair.handleSignal({type:'path-switch',path:'student-initiated',negotiationId:'retired'});
  assert.equal(created[0].closes,0);
  assert.equal(pair.getCandidateState('owner-initiated').negotiationId,'current');
  assert.equal(pair.getCandidateState('student-initiated'),null);
});

test('C: unchanged presence preserves retry backoff',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let count=0,session;
  session=createBrowserBoardSession({...baseSession,
    onPeerState:state=>{if(state==='failed') Promise.resolve(session.updateParticipants(presence)).catch(()=>{});},
    createStudentRuntime:options=>{
      const index=++count;
      return {close(){},getRevision:()=>1,start:async()=>{
        if(index===1){options.onState('failed');throw new Error('transient failure');}
      }};
    },
  });
  t.after(()=>session.close());await session.start();
  await assert.rejects(session.updateParticipants(presence));await flush();
  assert.equal(count,1,'unchanged presence preserves retry delay');
  t.mock.timers.tick(2000);await flush();
  assert.equal(count,2);
  assert.equal(session.getRuntimeState(),'ready');
});

test('D: live-only closure starts repair without closing durable network',async t=>{
  let pairOptions,liveOptions,pairCloses=0,repairs=0;const states=[];
  const network=createStudentPeerNetwork({boardId:'audit-board',clientId:'student-a',teacherId:'owner-a',
    signaling:{send:async()=>{}},getRevision:()=>1,applyCommit:async()=>{},installSnapshot:async()=>{},
    createPair:options=>{pairOptions=options;return {start:async()=>{},close:()=>pairCloses++,repairLiveChannel:()=>{repairs++;return true;}};},
    createTransport:()=>({send:async()=>{},close(){}}),
    createSession:()=>({start:async()=>{},close(){}}),
    createLiveTransport:options=>{liveOptions=options;return {send:()=>liveOptions.channel.readyState==='closed'?'closed':'sent',close(){}};},
    onState:s=>states.push(s)});
  t.after(()=>network.close());const starting=network.start();
  pairOptions.onSelectedChannel({readyState:'open'},'owner-initiated');
  pairOptions.onSelectedLiveChannel({readyState:'open'});await starting;
  liveOptions.channel.readyState='closed';liveOptions.onState('closed');await flush();
  assert.equal(network.isReady(),true);assert.equal(network.getLiveState(),'closed');
  assert.equal(network.sendLive('cursor',{x:1,y:1}),'unavailable');
  assert.equal(pairCloses,0);assert.equal(repairs,1);
});

test('E: failed readiness publication is reconciled on recovery',async t=>{
  let source=await readFile(new URL('../src/lib/browserAuthorityRealtime.js',import.meta.url),'utf8');
  // Only external Supabase dependency is stubbed; tested startup/recovery code is unchanged.
  source=source.replace("import { supabase } from './supabase.js';","const supabase = {};");
  source=source.replace(/from '(\.\/[^']+)'/g,(_,p)=>`from '${new URL(p,new URL('../src/lib/browserAuthorityRealtime.js',import.meta.url)).href}'`);
  const {connectBoardRealtime}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
  let transportOptions,updates=0;
  const oldWarn=console.warn;console.warn=()=>{};t.after(()=>{console.warn=oldWarn;});
  const realtime=connectBoardRealtime({boardId:'audit-board',clientId:'owner-a',permission:'owner',realtimeKey:'test-key',webrtcLiveV1:true},{
    createSession:()=>({start:async()=>{},updateParticipants:async()=>{},getRevision:()=>1,close(){}}),
    createCore:()=>({flushPending:async()=>{},disconnect:async()=>{}}),
    createTransport:options=>{transportOptions=options;return {
      start:async()=>{},updatePresence:async()=>{updates++;throw new Error('temporary presence error');},disconnect:async()=>{}
    };},
  });
  t.after(()=>realtime.disconnect());await flush();assert.equal(updates,1);
  await transportOptions.onRecover();await flush();
  assert.ok(updates>=2,'recovery reconciles desired owner readiness');
});

test('F: regained teacher authority recreates its runtime',async t=>{
  let lockOptions,creates=0;
  const session=createBrowserBoardSession({...baseSession,clientId:'owner-a',permission:'owner',
    createTeacherTabAuthority:options=>{lockOptions=options;return {start:()=>{options.onChange(true);return new Promise(()=>{});},stop(){}};},
    createTeacherRuntime:async()=>{creates++;return {getRevision:()=>1,updateParticipants(){},close(){}};},
  });
  t.after(()=>session.close());await session.start();assert.equal(session.getRuntimeState(),'ready');
  lockOptions.onChange(false);lockOptions.onChange(true);await flush();
  assert.equal(creates,2);assert.notEqual(session.getRuntime(),null);
  assert.equal(session.getRuntimeState(),'ready');
});

test('G: teacher forwards validated student live events',async t=>{
  let networkOptions,broadcasts=0,received=0;
  const runtime=await createTeacherBoardRuntime({boardId:'audit-board',clientId:'owner-a',
    sendScreenShareSignal:async()=>{},
    openAuthority:async()=>({getRevision:()=>1,closeVerification(){}}),getBoardMetadata:async()=>({guestMode:'edit'}),
    createHub:()=>({removePeer(){},handleMessage(){}}),
    createSignaling:()=>({send:async()=>{}}),createLockAuthority:()=>({release(){}}),
    createNetwork:options=>{networkOptions=options;return {relayLive:()=>{broadcasts++;},close(){}};},
    onLiveEvent:()=>received++,
  });
  t.after(()=>runtime.close());networkOptions.onLiveEvent('student-a','cursor',{clientId:'student-a',x:1,y:2},{});
  assert.equal(received,1);assert.equal(broadcasts,1);
});

test('H: teacher waits for an unexpired fallback lease',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date']});
  const storage=new Map([['alex-board-authority-lease:audit-board',JSON.stringify({token:'departed-tab',expiresAt:Date.now()+6000})]]);
  let creates=0;
  const session=createBrowserBoardSession({...baseSession,clientId:'owner-a',permission:'owner',
    createTeacherTabAuthority:options=>createTeacherTabAuthority({...options,lockManager:{},storage:{
      getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)
    }}),
    createTeacherRuntime:async()=>{creates++;return {close(){}};},
  });
  t.after(()=>session.close());
  let done=false;const starting=session.start().then(()=>{done=true});await flush();
  assert.equal(done,false);assert.equal(session.getRuntimeState(),'waiting');
  for(let n=0;n<10;n++){t.mock.timers.tick(750);await flush();}
  await starting;assert.equal(creates,1);assert.equal(session.getRuntimeState(),'ready');
});

test('I: standard-compliant Web Locks accepts production options',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let rejected=0;const storage=new Map();
  const authority=createTeacherTabAuthority({boardId:'audit-board',
    lockManager:{request:async(_name,options,callback)=>{
      if(options.signal && options.ifAvailable){rejected++;throw new DOMException('signal and ifAvailable cannot be combined','NotSupportedError');}
      return callback({});
    }},
    storage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},
  });
  t.after(()=>authority.stop());const running=authority.start();await flush();
  assert.equal(rejected,0);assert.equal(authority.isBestEffortFallback(),false);
  assert.equal(authority.isAuthority(),true);authority.stop();await running;
});
