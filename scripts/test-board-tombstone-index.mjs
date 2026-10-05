import test from 'node:test';
import assert from 'node:assert/strict';
import { createBoardTombstoneIndex, applyBoardTombstoneOperations, readBoardTombstone } from '../src/lib/boardTombstoneIndex.js';

const value = i => ({clientId:'writer', actionId:`a${i}`, mutationId:`m${i}`, revision:i});
test('indexed deletions preserve previous versions and address unrelated records without enumeration', () => {
  const original = Object.fromEntries(Array.from({length:10000}, (_,i)=>[`id-${i}`,value(i)]));
  const first = createBoardTombstoneIndex(original);
  original['id-0'].revision = -1;
  assert.equal(first.get('id-0').revision,0,'input remains externally mutable without changing internal state');
  const next = first.applyDelta([{type:'set',id:'extra',value:value(10001)}, {type:'delete',id:'id-300'}]);
  assert.equal(first.get('extra'),undefined); assert.equal(first.get('id-300').revision,300);
  assert.equal(next.get('id-300'),undefined); assert.equal(next.get('extra').revision,10001);
  assert.strictEqual(next.get('id-9999'),first.get('id-9999'));
  assert.strictEqual(first.fork(),first);
  assert.strictEqual(first.applyDelta([{type:'delete',id:'absent'}]),first);
  assert.equal(next.size,10000);
});

test('tree insertion deletion and serialization match a plain table through long deterministic sequences', () => {
  let state=createBoardTombstoneIndex({}), expected={}; let seed=583;
  for(let i=0;i<3000;i++) {
    seed=(Math.imul(seed,1664525)+1013904223)>>>0;
    const id=`key-${seed%600}`, remove=(seed%5)===0;
    const prior=state;
    if(remove){delete expected[id];state=state.applyDelta([{type:'delete',id}]);}
    else {expected[id]=value(i);state=state.applyDelta([{type:'set',id,value:value(i)}]);}
    if(i%100===0)assert.deepEqual(state.serialize(),expected);
    assert.equal(state.size,Object.keys(expected).length);
    assert.strictEqual(prior.fork(),prior);
  }
  assert.deepEqual(state.serialize(),expected);
});

test('commit delta preserves deletion and conditional-restore metadata without touching empty operations', () => {
  let state=createBoardTombstoneIndex({}); const context={clientId:'writer',actionId:'capture',revision:7};
  state=applyBoardTombstoneOperations(state,[{type:'delete',id:'source',mutationId:'retire'},{type:'notebook',id:'book',changes:[]}],context);
  assert.deepEqual(readBoardTombstone(state,'source'),{clientId:'writer',actionId:'capture',mutationId:'retire',revision:7});
  assert.strictEqual(applyBoardTombstoneOperations(state,[{type:'patch',id:'other',patch:{left:3}}],context),state);
  const restored=applyBoardTombstoneOperations(state,[{type:'upsert',object:{boardObjectId:'source'}}],context);
  assert.equal(restored.get('source'),undefined); assert.ok(state.get('source'));
  assert.deepEqual(readBoardTombstone({'source':value(2)},'source'),value(2));
});

test('prototype-like identities round trip as data and cannot alter ordinary table prototypes', () => {
  const source=Object.fromEntries([['__proto__',value(1)],['constructor',value(2)],['toString',value(3)]]);
  const index=createBoardTombstoneIndex(source), serialized=index.serialize();
  assert.deepEqual(serialized,source);assert.strictEqual(Object.getPrototypeOf(serialized),Object.prototype);
  const changed=index.applyDelta([{type:'delete',id:'__proto__'}]);
  assert.equal(changed.get('__proto__'),undefined); assert.equal(index.get('__proto__').revision,1);
});
