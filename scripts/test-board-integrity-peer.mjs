import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { createIntegrityBudget, captureIntegrityRecords, fingerprintIntegrityRecord } from '../src/lib/boardIntegrityData.js';
const url = new URL('../src/lib/boardIntegrityPeer.js', import.meta.url);
test('negotiated integrity peer module is present', () => assert.ok(existsSync(url)));
const mod = existsSync(url) ? await import(url.href) : null;
const empty = { version: 2, background: 'grid', canvas: { objects: [] } };
const turn = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
async function digest(source, ids) {
  const b = createIntegrityBudget(); const records = await captureIntegrityRecords(source, ids, b);
  const result = [];
  for (const record of records) result.push({ id: record.id, hash: await fingerprintIntegrityRecord(record, b) });
  return result;
}
for (const [name, fn] of [
  ['old peer stays disabled and sends no new messages', async () => {
    const sent = []; const client = mod.createIntegrityPeerClient({ send: async (...a) => sent.push(a) });
    assert.equal((await client.request({ revision: 0, records: [] })).status, 'disabled');
    client.configure({ version: 0 }); assert.equal(sent.length, 0); client.close();
  }],
  ['one request per connection; old-session replies cannot settle it', async () => {
    const sent = []; const client = mod.createIntegrityPeerClient({ send: async (...a) => sent.push(a) });
    client.configure({ version: 1, sessionId: 'session-1', boardId: 'b' });
    const pending = client.request({ revision: 1, records: [] });
    await assert.rejects(() => client.request({ revision: 1, records: [] }), /already|pending/i);
    await turn(); assert.equal(sent.length, 1);
    assert.equal(client.handleMessage({ type: 'integrity-result', payload: { ...sent[0][1], sessionId: 'old', status: 'done' } }), false);
    client.close(); await assert.rejects(() => pending, /closed/i);
  }],
  ['same revision and same count do not conceal an old wrong color', async () => {
    const primary = { version: 1, boardId: 'b', revision: 3, snapshot: { ...empty, canvas: { objects: [{ boardObjectId: 'old', stroke: 'black' }, { boardObjectId: 'new' }] } } };
    const replica = structuredClone(primary); replica.snapshot.canvas.objects[0].stroke = 'red';
    let responder;
    const client = mod.createIntegrityPeerClient({ send: async (type,payload) => responder.handle({ type, payload }) });
    client.configure({ version: 1, sessionId: 's', boardId: 'b' });
    responder = mod.createIntegrityPeerResponder({ getSource: () => primary, sessionId: 's', boardId: 'b', send: async (type,payload) => client.handleMessage({ type,payload }), sendTextTransfer: async (kind,text) => client.handleTransfer({kind,text}) });
    const result = await client.request({ revision: 3, records: await digest(replica, ['old','new']), background: 'grid' });
    assert.equal(result.status, 'done'); assert.equal(result.records.length, 1);
    assert.equal(result.records[0].object.stroke, 'black'); client.close(); responder.close();
  }],
  ['ghost and position differences return only targeted canonical records', async () => {
    const primary = { version: 1, boardId: 'b', revision: 3, snapshot: { ...empty, canvas: { objects: [{ boardObjectId: 'x', left: 50 }] } } };
    const local = { ...primary, snapshot: { ...empty, canvas: { objects: [{ boardObjectId: 'x', left: 1 }, { boardObjectId: 'ghost' }] } } };
    let responder;
    const client = mod.createIntegrityPeerClient({ send: async (type,payload) => responder.handle({type,payload}) });
    client.configure({ version:1, sessionId:'s', boardId:'b' });
    responder = mod.createIntegrityPeerResponder({ getSource: () => primary, sessionId:'s',boardId:'b',send:async(type,payload)=>client.handleMessage({type,payload}),sendTextTransfer:async(kind,text)=>client.handleTransfer({kind,text}) });
    const result = await client.request({revision:3,records:await digest(local,['x','ghost']),background:'blank'});
    assert.equal(result.records.find((r)=>r.id==='ghost').count,0);
    assert.equal(result.records.find((r)=>r.id==='x').object.left,50); assert.equal(result.background,'grid');
    client.close(); responder.close();
  }],
  ['different revision returns stale with no repair payload', async () => {
    const replies=[];
    const responder=mod.createIntegrityPeerResponder({getSource:()=>({version:1,revision:8,snapshot:empty}),sessionId:'s',boardId:'b',send:async(t,p)=>replies.push(p),sendTextTransfer:async()=>assert.fail()});
    await responder.handle({type:'integrity-request',payload:{version:1,requestId:'r',sessionId:'s',boardId:'b',revision:7,records:[]}});
    assert.equal(replies[0].status,'stale'); assert.equal(replies[0].records,undefined); responder.close();
  }],
  ['oversized or wrong-board requests do not start expensive checks', async () => {
    let reads=0;
    const responder=mod.createIntegrityPeerResponder({getSource:()=>{reads++;return {version:1,revision:8,snapshot:empty};},sessionId:'s',boardId:'b',send:async()=>{},sendTextTransfer:async()=>{}});
    await responder.handle({type:'integrity-request',payload:{version:1,requestId:'r',sessionId:'s',boardId:'other',revision:8,records:[]}});
    await responder.handle({type:'integrity-request',payload:{version:1,requestId:'r',sessionId:'s',boardId:'b',revision:8,records:Array.from({length:101},(_,i)=>({id:`${i}`,hash:'x'}))}});
    assert.equal(reads,0); responder.close();
  }],
]) test(name,{skip:!mod},fn);
