import test from 'node:test';
import assert from 'node:assert/strict';
const api = await import('../src/lib/notebookClientIdentity.js').catch(()=>({}));
function environment() {
 const values=new Map(),held=new Set();
 return {storage:{getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)},
  locks:{async request(key,options,work){if(options.ifAvailable && options.signal)throw new DOMException('ifAvailable cannot be combined with signal','NotSupportedError');if(held.has(key))return work(null);held.add(key);try{return await work({name:key});}finally{held.delete(key);}}},held,values};
}
const acquire=options=>{assert.equal(typeof api.acquireNotebookClientIdentity,'function','missing reload-stable notebook actor');return api.acquireNotebookClientIdentity(options);};
const tick=()=>new Promise(r=>setImmediate(r));
test('same tab reload restores actor and queued-action namespace',async()=>{
 const env=environment();let n=0;const options={...env,boardId:'board',newId:()=>`actor-${++n}`};
 const first=await acquire(options);first.release();await tick();const second=await acquire(options);
 assert.equal(second.clientId,first.clientId);assert.equal(n,1);second.release();await tick();assert.equal(env.held.size,0);
});
test('duplicated live tab cannot claim another writer pending namespace',async()=>{
 const env=environment();let n=0;const options={...env,boardId:'board',newId:()=>`actor-${++n}`};
 const first=await acquire(options),second=await acquire(options);
 assert.notEqual(first.clientId,second.clientId);assert.equal(env.held.size,2);first.release();second.release();
});
test('storage failure releases actor and refuses false durable recovery guarantee',async()=>{
 const env=environment();await assert.rejects(acquire({...env,boardId:'board',newId:()=>`actor`,storage:{getItem:()=>null,setItem(){throw Error('quota');}}}),/quota/);
 await tick();assert.equal(env.held.size,0);
});
test('unsupported locks fail explicitly; abort releases acquired identity',async()=>{
 await assert.rejects(acquire({boardId:'board',storage:{},locks:null}),/lock/i);
 const env=environment(),abort=new AbortController();const result=await acquire({...env,boardId:'board',newId:()=>`actor`,signal:abort.signal});abort.abort();await tick();assert.equal(env.held.size,0);result.release();
});
test('board actors have separate namespaces and an aborted mount does not persist an identity',async()=>{
 const env=environment();let n=0;const a=await acquire({...env,boardId:'a',newId:()=>`actor-${++n}`});const b=await acquire({...env,boardId:'b',newId:()=>`actor-${++n}`});assert.notEqual(a.clientId,b.clientId);
 const abort=new AbortController();abort.abort();await assert.rejects(acquire({...env,boardId:'c',signal:abort.signal}),{name:'AbortError'});assert.equal(env.values.size,2);a.release();b.release();
});

test('abort before the non-waiting lock callback releases it without persisting an actor',async()=>{
 const env=environment(),abort=new AbortController();const request=env.locks.request;
 env.locks.request=async(key,options,work)=>{await tick();return request(key,options,work);};
 const pending=acquire({...env,boardId:'delayed',signal:abort.signal,newId:()=>`actor`});
 abort.abort();await assert.rejects(pending,{name:'AbortError'});await tick();
 assert.equal(env.values.size,0);assert.equal(env.held.size,0);
});
