import assert from 'node:assert/strict';
import test from 'node:test';
import { createTeacherPeerHub } from '../src/lib/teacherPeerHub.js';

function makeTransport() {
  return {
    sent: [],
    transfers: [],
    async send(type, payload) { this.sent.push({ type, payload }); },
    async sendTextTransfer(kind, text, options) { this.transfers.push({ kind, text, options }); },
  };
}

test('answers head requests from the teacher authority revision', async () => {
  const transport = makeTransport();
  const hub = createTeacherPeerHub({
    authority: { getRevision: () => 42, commitAction: async () => null },
    getSnapshot: async () => ({ snapshot: {}, revision: 42 }),
    getCommitsAfter: async () => [],
  });
  hub.addPeer('student-a', transport);
  await hub.handleMessage('student-a', { type: 'head-request', payload: {} });
  assert.deepEqual(transport.sent, [{ type: 'head', payload: { revision: 42 } }]);
});

test('persists a new proposal before broadcasting commit and ack', async () => {
  const order = [];
  const peerA = makeTransport();
  const peerB = makeTransport();
  peerA.send = async function send(type, payload) { order.push(`A:${type}`); this.sent.push({ type, payload }); };
  peerB.send = async function send(type, payload) { order.push(`B:${type}`); this.sent.push({ type, payload }); };
  const authority = {
    revision: 5,
    getRevision() { return this.revision; },
    async commitAction(action) {
      order.push('persist');
      this.revision += 1;
      return { ...action, revision: this.revision, duplicate: false, needsSync: false };
    },
  };
  const hub = createTeacherPeerHub({
    authority,
    getSnapshot: async () => ({ snapshot: {}, revision: authority.revision }),
    getCommitsAfter: async () => [],
  });
  hub.addPeer('student-a', peerA);
  hub.addPeer('student-b', peerB);
  await hub.handleMessage('student-a', {
    type: 'action-proposal',
    payload: { actionId: 'action-1', clientId: 'student-a', baseRevision: 5, ops: [{ type: 'delete', id: 'x' }] },
  });
  assert.equal(order[0], 'persist');
  assert.deepEqual(order.slice(1), ['A:commit', 'B:commit', 'A:ack']);
  assert.equal(peerA.sent[0].payload.revision, 6);
  assert.equal(peerB.sent[0].payload.revision, 6);
  assert.deepEqual(peerA.sent[1], {
    type: 'ack',
    payload: { actionId: 'action-1', revision: 6, accepted: true, duplicate: false, needsSync: false },
  });
});

test('a duplicate proposal is not rebroadcast to unrelated peers', async () => {
  const peerA = makeTransport();
  const peerB = makeTransport();
  const hub = createTeacherPeerHub({
    authority: {
      getRevision: () => 9,
      commitAction: async (action) => ({ ...action, revision: 9, duplicate: true, needsSync: false }),
    },
    getSnapshot: async () => ({ snapshot: {}, revision: 9 }),
    getCommitsAfter: async () => [],
  });
  hub.addPeer('student-a', peerA);
  hub.addPeer('student-b', peerB);
  await hub.handleMessage('student-a', {
    type: 'action-proposal', payload: { actionId: 'action-old', baseRevision: 8, ops: [] },
  });
  assert.equal(peerB.sent.length, 0);
  assert.equal(peerA.sent[0].type, 'commit');
  assert.equal(peerA.sent[1].type, 'ack');
  assert.equal(peerA.sent[1].payload.duplicate, true);
});

test('sync request sends a contiguous journal instead of a snapshot', async () => {
  const transport = makeTransport();
  const commits = [
    { actionId: 'a6', revision: 6, ops: [] },
    { actionId: 'a7', revision: 7, ops: [] },
  ];
  const hub = createTeacherPeerHub({
    authority: { getRevision: () => 7, commitAction: async () => null },
    getSnapshot: async () => ({ snapshot: { full: true }, revision: 7 }),
    getCommitsAfter: async () => commits,
  });
  hub.addPeer('student-a', transport);
  await hub.handleMessage('student-a', { type: 'sync-request', payload: { revision: 5 } });
  assert.deepEqual(transport.sent.map((entry) => entry.type), ['commit', 'commit', 'head']);
  assert.equal(transport.transfers.length, 0);
});

test('sync request falls back to a snapshot when the journal has a gap', async () => {
  const transport = makeTransport();
  const hub = createTeacherPeerHub({
    authority: { getRevision: () => 8, commitAction: async () => null },
    getSnapshot: async () => ({ snapshot: { full: true }, revision: 8 }),
    getCommitsAfter: async () => [{ actionId: 'a8', revision: 8, ops: [] }],
    createTransferId: () => 'snapshot-transfer',
  });
  hub.addPeer('student-a', transport);
  await hub.handleMessage('student-a', { type: 'sync-request', payload: { revision: 5 } });
  assert.equal(transport.sent.length, 0);
  assert.equal(transport.transfers.length, 1);
  assert.equal(transport.transfers[0].kind, 'snapshot');
  assert.equal(transport.transfers[0].options.transferId, 'snapshot-transfer');
  assert.deepEqual(JSON.parse(transport.transfers[0].text), { snapshot: { full: true }, revision: 8 });
});

test('broadcasts a teacher-originated durable commit to every connected peer', async () => {
  const peerA = makeTransport();
  const peerB = makeTransport();
  const hub = createTeacherPeerHub({
    authority: { getRevision: () => 11, commitAction: async () => null },
    getSnapshot: async () => ({ snapshot: {}, revision: 11 }),
    getCommitsAfter: async () => [],
  });
  hub.addPeer('student-a', peerA);
  hub.addPeer('student-b', peerB);
  const commit = { actionId: 'teacher-action', clientId: 'teacher', revision: 11, ops: [] };
  await hub.broadcastCommit(commit);
  assert.deepEqual(peerA.sent, [{ type: 'commit', payload: commit }]);
  assert.deepEqual(peerB.sent, [{ type: 'commit', payload: commit }]);
});

test('routes peer lock requests through teacher authority without trusting payload clientId', async () => {
  const transport = makeTransport();
  const requests = [];
  const lockAuthority = {
    acquire(request) {
      requests.push(request);
      return {
        granted: true,
        objectIds: request.objectIds,
        lockToken: request.lockToken,
        expiresAt: 12345,
        conflicts: [],
      };
    },
  };
  const hub = createTeacherPeerHub({
    authority: { getRevision: () => 0, commitAction: async () => null },
    getSnapshot: async () => ({ snapshot: {}, revision: 0 }),
    getCommitsAfter: async () => [],
    lockAuthority,
  });
  hub.addPeer('student-a', transport);

  await hub.handleMessage('student-a', {
    type: 'lock-request',
    payload: {
      requestId: 'request-1',
      operation: 'acquire',
      clientId: 'spoofed-client',
      lockToken: 'lock-token-123',
      objectIds: ['shape-1'],
      ttlMs: 12000,
    },
  });

  assert.deepEqual(requests, [{
    clientId: 'student-a',
    lockToken: 'lock-token-123',
    objectIds: ['shape-1'],
    ttlMs: 12000,
  }]);
  assert.deepEqual(transport.sent, [{
    type: 'lock-result',
    payload: {
      requestId: 'request-1',
      operation: 'acquire',
      granted: true,
      objectIds: ['shape-1'],
      lockToken: 'lock-token-123',
      expiresAt: 12345,
      conflicts: [],
    },
  }]);
});

test('default teacher lock authority rejects conflicts atomically and releases replaced selection', async () => {
  const peerA = makeTransport();
  const peerB = makeTransport();
  const hub = createTeacherPeerHub({
    authority: { getRevision: () => 0, commitAction: async () => null },
    getSnapshot: async () => ({ snapshot: {}, revision: 0 }),
    getCommitsAfter: async () => [],
  });
  hub.addPeer('student-a', peerA);
  hub.addPeer('student-b', peerB);

  await hub.handleMessage('student-a', {
    type: 'lock-request',
    payload: {
      requestId: 'a-1', operation: 'acquire', lockToken: 'token-student-a',
      objectIds: ['shape-1'], ttlMs: 12000,
    },
  });
  const first = peerA.sent.at(-1)?.payload;
  assert.equal(first?.granted, true);
  assert.deepEqual(first?.objectIds, ['shape-1']);

  await hub.handleMessage('student-b', {
    type: 'lock-request',
    payload: {
      requestId: 'b-1', operation: 'acquire', lockToken: 'token-student-b',
      objectIds: ['shape-1'], ttlMs: 12000,
    },
  });
  const conflict = peerB.sent.at(-1)?.payload;
  assert.equal(conflict?.granted, false);
  assert.deepEqual(conflict?.objectIds, ['shape-1']);
  assert.equal(conflict?.conflicts?.[0]?.objectId, 'shape-1');
  assert.equal(conflict?.conflicts?.[0]?.clientId, 'student-a');

  await hub.handleMessage('student-a', {
    type: 'lock-request',
    payload: {
      requestId: 'a-2', operation: 'acquire', lockToken: 'token-student-a',
      objectIds: ['shape-2'], ttlMs: 12000,
    },
  });
  assert.equal(peerA.sent.at(-1)?.payload?.granted, true);

  await hub.handleMessage('student-b', {
    type: 'lock-request',
    payload: {
      requestId: 'b-2', operation: 'acquire', lockToken: 'token-student-b',
      objectIds: ['shape-1'], ttlMs: 12000,
    },
  });
  assert.equal(peerB.sent.at(-1)?.payload?.granted, true);
});

test('view-only peer can sync but cannot acquire locks or commit durable actions', async () => {
  const transport = makeTransport();
  let commits = 0;
  let lockAcquires = 0;
  const hub = createTeacherPeerHub({
    authority: {
      getRevision: () => 12,
      async commitAction() {
        commits += 1;
        return { revision: 13 };
      },
    },
    getSnapshot: async () => ({ snapshot: { version: 2 }, revision: 12 }),
    getCommitsAfter: async () => [],
    canPeerEdit: async (peerId) => peerId !== 'student-view',
    lockAuthority: {
      async acquire() {
        lockAcquires += 1;
        return { granted: true, objectIds: ['shape-1'], conflicts: [] };
      },
      async release() { return { released: 0 }; },
    },
  });
  hub.addPeer('student-view', transport);

  await hub.handleMessage('student-view', { type: 'head-request', payload: {} });
  assert.deepEqual(transport.sent.at(-1), { type: 'head', payload: { revision: 12 } });

  await hub.handleMessage('student-view', {
    type: 'lock-request',
    payload: {
      requestId: 'view-lock', operation: 'acquire', lockToken: 'token-view',
      objectIds: ['shape-1'], ttlMs: 12000,
    },
  });
  assert.equal(lockAcquires, 0);
  assert.equal(transport.sent.at(-1)?.type, 'lock-result');
  assert.equal(transport.sent.at(-1)?.payload?.granted, false);
  assert.equal(transport.sent.at(-1)?.payload?.error, 'Board is view-only');

  await hub.handleMessage('student-view', {
    type: 'action-proposal',
    payload: { actionId: 'view-action', baseRevision: 12, ops: [{ type: 'delete', id: 'shape-1' }] },
  });
  assert.equal(commits, 0);
  assert.equal(transport.sent.at(-1)?.type, 'ack');
  assert.equal(transport.sent.at(-1)?.payload?.accepted, false);
  assert.equal(transport.sent.at(-1)?.payload?.needsSync, false);
  assert.equal(transport.sent.at(-1)?.payload?.error, 'Board is view-only');
});


test('teacher hub sends and receives reliable board-control without touching authority revision', async () => {
  const sent = [];
  const received = [];
  let revision = 7;
  const hub = createTeacherPeerHub({
    authority: {
      getRevision: () => revision,
      commitAction: async () => { revision += 1; return { revision }; },
    },
    getSnapshot: async () => ({ snapshot: {}, revision }),
    getCommitsAfter: async () => [],
    onBoardControl: (peerId, event, payload) => received.push({ peerId, event, payload }),
  });
  const transport = {
    async send(type, payload) { sent.push({ type, payload }); },
    async sendTextTransfer() {},
  };
  hub.addPeer('student-a', transport);

  await hub.broadcastBoardControl('mode', { mode: 'edit' });
  assert.deepEqual(sent.at(-1), {
    type: 'board-control',
    payload: { event: 'mode', payload: { mode: 'edit' } },
  });

  await hub.handleMessage('student-a', {
    type: 'board-control',
    payload: { event: 'view-request', payload: { clientId: 'student-a' } },
  });
  assert.deepEqual(received, [{
    peerId: 'student-a',
    event: 'view-request',
    payload: { clientId: 'student-a' },
  }]);
  assert.equal(revision, 7, 'board-control must never advance authority revision');

  await assert.rejects(
    hub.handleMessage('student-a', {
      type: 'board-control',
      payload: { event: 'cursor', payload: { x: 1 } },
    }),
    /board control event/i,
  );
});


test('teacher hub filters student board-control by direction and actual edit permission', async () => {
  const received = [];
  let editable = false;
  const hub = createTeacherPeerHub({
    authority: {
      getRevision: () => 9,
      commitAction: async () => ({ revision: 10 }),
    },
    getSnapshot: async () => ({ snapshot: {}, revision: 9 }),
    getCommitsAfter: async () => [],
    canPeerEdit: async () => editable,
    onBoardControl: (peerId, event, payload) => received.push({ peerId, event, payload }),
  });
  hub.addPeer('student-a', makeTransport());

  await hub.handleMessage('student-a', {
    type: 'board-control',
    payload: { event: 'view-request', payload: { clientId: 'student-a' } },
  });
  assert.deepEqual(received.map((entry) => entry.event), ['view-request']);

  await hub.handleMessage('student-a', {
    type: 'board-control',
    payload: { event: 'background-live', payload: { background: 'dots' } },
  });
  await hub.handleMessage('student-a', {
    type: 'board-control',
    payload: { event: 'lock', payload: { objectIds: ['shape-1'], locked: true } },
  });
  await hub.handleMessage('student-a', {
    type: 'board-control',
    payload: { event: 'selection-transaction', payload: { phase: 'start', transactionId: 'tx-a' } },
  });
  assert.deepEqual(
    received.map((entry) => entry.event),
    ['view-request'],
    'view-only peers must not inject edit-only transient controls',
  );

  editable = true;
  await hub.handleMessage('student-a', {
    type: 'board-control',
    payload: { event: 'background-live', payload: { background: 'blank' } },
  });
  await hub.handleMessage('student-a', {
    type: 'board-control',
    payload: { event: 'lock', payload: { objectIds: ['shape-1'], locked: true } },
  });
  await hub.handleMessage('student-a', {
    type: 'board-control',
    payload: { event: 'selection-transaction', payload: { phase: 'start', transactionId: 'tx-b' } },
  });
  assert.deepEqual(
    received.map((entry) => entry.event),
    ['view-request', 'background-live', 'lock', 'selection-transaction'],
  );

  for (const event of ['mode', 'view-jump', 'game-library-visibility']) {
    await hub.handleMessage('student-a', {
      type: 'board-control',
      payload: { event, payload: { permission: 'owner', visible: true, mode: 'closed' } },
    });
  }
  assert.deepEqual(
    received.map((entry) => entry.event),
    ['view-request', 'background-live', 'lock', 'selection-transaction'],
    'owner-only controls must never be accepted from a student peer',
  );
});

test('verification-only head requests preserve negotiated media upload capability',async()=>{
 const assetId='e'.repeat(64);const record={metadata:{assetId,kind:'gif',name:'a.gif',size:9,mime:'image/gif'},blob:new Blob(['GIF89a123'])};let hub;
 const peer=makeTransport();peer.sendLowPriorityEncoded=async encoded=>{const m=JSON.parse(encoded);if(m.type==='asset-start')await hub.handleMessage('student',{type:'asset-result',payload:{boardId:'room',assetId,transferId:m.payload.transferId,status:'complete'}});};
 hub=createTeacherPeerHub({boardId:'room',mediaStore:{get:async()=>record},authority:{getRevision:()=>0,commitAction:async()=>null},getSnapshot:async()=>({snapshot:{canvas:{objects:[]}},revision:0}),getCommitsAfter:async()=>[]});
 hub.addPeer('student',peer);
 try {await hub.handleMessage('student',{type:'head-request',payload:{mediaVersion:1}});await hub.handleMessage('student',{type:'head-request',payload:{verification:{}}});await assert.doesNotReject(hub.ensureMediaAsset(assetId));}finally{hub.closeMedia();}
});
test('legacy snapshot and journal display an update notice instead of existing grouped media',async()=>{
 const peer=makeTransport();const snapshot={version:2,canvas:{objects:[{type:'Group',boardObjectId:'group',objects:[{type:'Image',mediaAssetId:'a'.repeat(64),mediaKind:'pdf'}]}]}};
 const hub=createTeacherPeerHub({boardId:'room',authority:{getRevision:()=>1,commitAction:async()=>null},getSnapshot:async()=>({snapshot,revision:1}),getCommitsAfter:async()=>[{revision:1,ops:[{type:'upsert',id:'group',object:snapshot.canvas.objects[0]}]}]});hub.addPeer('old',peer);
 try {await hub.handleMessage('old',{type:'head-request',payload:{}});await hub.handleMessage('old',{type:'snapshot-request',payload:{}});
  const delivered=JSON.parse(peer.transfers.at(-1).text).snapshot;assert.match(delivered.canvas.objects[0].text,/обновите|Refresh/);assert.ok(!JSON.stringify(delivered).includes('mediaAssetId'));
  peer.sent.length=0;await hub.handleMessage('old',{type:'sync-request',payload:{revision:0}});assert.ok(!peer.sent.some(m=>m.type==='commit'));
  await hub.broadcastCommit({revision:2,ops:[{type:'patch',id:'group',patch:{objects:snapshot.canvas.objects[0].objects}}]});assert.ok(!peer.sent.some(m=>m.type==='commit'));
 }finally{hub.closeMedia();}
});
test('nested media and page patches cannot publish to a legacy participant',async()=>{
 const id='a'.repeat(64);const obj={type:'Image',boardObjectId:'pdf',mediaAssetId:id,mediaKind:'pdf'};
 const hub=createTeacherPeerHub({boardId:'room',authority:{getRevision:()=>1,commitAction:async()=>null},getSnapshot:async()=>({snapshot:{canvas:{objects:[obj]}},revision:1}),getCommitsAfter:async()=>[]});hub.addPeer('old',makeTransport());
 try {await assert.rejects(hub.assertMediaAction([{type:'upsert',id:'group',object:{objects:[obj]}}]),/обновить/);await assert.rejects(hub.assertMediaAction([{type:'patch',id:'pdf',patch:{pageNumber:2}}]),/обновить/);}finally{hub.closeMedia();}
});
test('a slow legacy update notice never blocks commit delivery to current peers',async()=>{
 let blocked=false,release;const waiting=new Promise(ok=>release=ok);const current=makeTransport(),old=makeTransport();
 const hub=createTeacherPeerHub({boardId:'room',authority:{getRevision:()=>1,commitAction:async()=>null},getSnapshot:async()=>blocked?waiting:{snapshot:{canvas:{objects:[]}},revision:1},getCommitsAfter:async()=>[]});hub.addPeer('old',old);hub.addPeer('current',current);
 await hub.handleMessage('current',{type:'head-request',payload:{mediaVersion:1}});current.sent.length=0;blocked=true;
 const sending=hub.broadcastCommit({revision:2,ops:[]});
 try{await Promise.resolve();await Promise.resolve();assert.ok(current.sent.some(m=>m.type==='commit'));}finally{release({snapshot:{canvas:{objects:[]}},revision:2});await sending;hub.closeMedia();}
});
test('legacy update notices cannot be replaced with media by canvas verification',async()=>{
 let verified=0;const peer=makeTransport();
 const hub=createTeacherPeerHub({boardId:'room',authority:{getRevision:()=>1,commitAction:async()=>null,getVerificationView:()=>({capture(){verified++;throw Error('notice is not a canonical canvas');}})},getSnapshot:async()=>({snapshot:{canvas:{objects:[{boardObjectId:'pdf',mediaKind:'pdf',mediaAssetId:'a'.repeat(64)}]}},revision:1}),getCommitsAfter:async()=>[]});hub.addPeer('old',peer);
 try{await hub.handleMessage('old',{type:'head-request',payload:{}});assert.equal(JSON.parse(peer.transfers.at(-1).text).verificationVersion,undefined);
  await hub.handleMessage('old',{type:'head-request',payload:{verification:{requestId:'check',epoch:'old'}}});assert.equal(verified,0);assert.equal(peer.sent.at(-1).payload.verification.status,'error');
 }finally{hub.closeMedia();}
});
