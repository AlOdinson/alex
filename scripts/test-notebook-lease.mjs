import { readSnapshotRecord } from '../src/lib/indexedBoardModel.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const source=fs.readFileSync(new URL('../src/components/Board.jsx',import.meta.url),'utf8');
function callback(name,scope){scope={canReadDocumentsRef:{current:false},studentDocumentReaderRef:{current:null},notebookRuntimeEnabled:false,incrementalNotebookActions:{},registeredObjectsById:()=>[],...scope};const start=source.indexOf(`  const ${name} = useCallback(`);const end=source.indexOf('\n\n  const ',start+1);return new Function('scope',`with(scope){${source.slice(start,end)};return ${name};}`)(scope);}
test('page hydration must not publish after its notebook lease expires',async()=>{
 let granted=true,published=0;
 const notebook={notebookPageNumber:1,boardObjectId:'book'};
 const canvas={getActiveObject:()=>notebook,getObjects:()=>[notebook],requestRenderAll(){}};
 const scope={useCallback:fn=>fn,queueNotebookMutation:fn=>fn(),fabricCanvasRef:{current:canvas},canEditRef:{current:true},
 isBoardNotebook:o=>o===notebook,acquireLocalSelectionLease:async()=>true,ownsSelectionLease:()=>granted,
 setNotebookBusy(){},getObjectRecords:()=>[{object:{boardObjectId:'book'},zIndex:0}],
 setNotebookPage:async()=>{granted=false;notebook.notebookPageNumber=2;return true;},
 markObject(){},clientIdRef:{current:'teacher'},updatePdfControls(){},
 sendRecordPatches:async()=>{published++},commitNotebookOps:async()=>{published++},
 createConditionalRecordPatchOps:()=>[],syncFromServer:async()=>{},
 };
 if(source.includes('  const assertNotebookLease = useCallback('))scope.assertNotebookLease=callback('assertNotebookLease',scope);
 await assert.rejects(callback('changeNotebookPage',scope)(2), /блокировка истекла/);
 assert.equal(published,0);
});
test('rejected notebook publication reconciles instead of reporting saved', async()=>{
 let repairs=0;
 const scope={useCallback:fn=>fn,sendDurableOps:async()=>[{rejectedObjectIds:['book']}],syncFromServer:async()=>{repairs++}};
 await assert.rejects(callback('commitNotebookOps',scope)([{type:'patch',id:'book',patch:{}}]),/другим участником/);
 assert.equal(repairs,1);
});

// Use the actual UI lease callback and actual teacher lock authority. Notebook
// publication must not confuse display work or superseded selection with denial.
async function pendingLeaseFixture() {
  const { default: vm } = await import('node:vm');
  const { createTeacherObjectLockAuthority } = await import('../src/lib/teacherObjectLocks.js');
  const { operationObjectIds } = await import('../src/lib/operationProtocol.js');
  const authority = createTeacherObjectLockAuthority();
  const book = { boardObjectId: 'book' };
  const other = { boardObjectId: 'other' };
  const canvas = { getActiveObject: () => null, requestRenderAll() {} };
  const controller = { getConfirmedState: () => ({ snapshot: { canvas: { objects: [book, other] } } }) };
  const replies = [], requests = [], ref = current => ({ current }), noop = () => {};
  const scope = { readSnapshotRecord, useCallback: fn => fn, operationObjectIds, boardId: 'board', boardKey: 'key',
    clientIdRef: ref('teacher'), canEditRef: ref(true), applyingRemoteRef: ref(false), applyingHistoryRef: ref(false),
    fabricCanvasRef: ref(canvas), notebookControllerRef: ref(controller), selectionLeaseRef: ref({ generation: 0, ids: [], state: 'none', expiresAt: 0 }),
    selectionLeaseInteractionStateRef: ref(new Map()), localLockIdsRef: ref([]), remoteLocksRef: ref(new Map()),
    transientStatusTimerRef: ref(null), realtimeRef: ref({ sendLock: noop }), window: { clearTimeout: noop, setTimeout: noop },
    flattenTarget: value => Array.isArray(value) ? value : value ? [value] : [], isBoardScreenShareObject: () => false,
    registeredObjectsById: id => [book, other].filter(o => o.boardObjectId === id),
    randomToken: () => `pending-lease-${requests.length}`, console: { warn: noop },
    applyObjectInteractivityToObjects: noop, updateSelectionState: noop, updateSelectionStyleState: noop, setRemoteLocks: noop, setSaveStatus: noop, setSyncTone: noop,
    acquireBoardObjectLocks: (_board, _key, clientId, lockToken, objectIds) => {
      requests.push(objectIds); const result = authority.acquire({ clientId, lockToken, objectIds });
      return new Promise((resolve, reject) => replies.push({ resolve: () => resolve(result), reject }));
    },
    releaseBoardObjectLocks: async (_board, _key, clientId, lockToken) => authority.release({ clientId, lockToken }),
  };
  const start = source.indexOf('  const selectionObjectIds = useCallback(');
  const end = source.indexOf('  const getLiveTransformObjects = useCallback(', start);
  const methodStart = source.indexOf('    async leaseForOperations(ops) {');
  const methodEnd = source.indexOf('\n    },\n  };', methodStart) + '\n    }'.length;
  assert.ok(start >= 0 && end > start && methodStart > end && methodEnd > methodStart);
  vm.runInNewContext(`${source.slice(start, end)}\nglobalThis.api = { acquireLocalSelectionLease, releaseLocalSelectionLease, ${source.slice(methodStart, methodEnd)} };`, scope);
  return { scope, api: scope.api, book, other, requests, authority,
    ops: [{ type: 'notebook', version: 1, id: 'book', pageNumber: 1, changes: [{ type: 'insert', object: { boardObjectId: 'ink', type: 'path' } }] }],
    async reply({ reject = false } = {}) { assert.ok(replies.length, 'real authority request pending'); const next = replies.shift(); reject ? next.reject(Error('network unavailable')) : next.resolve(); await new Promise(setImmediate); },
  };
}

for (const phase of ['applyingRemoteRef', 'applyingHistoryRef']) {
  test(`pending notebook publication remains authorized during ${phase}`, async () => {
    const f = await pendingLeaseFixture(); f.scope[phase].current = true;
    assert.equal(await f.api.acquireLocalSelectionLease(f.book), false, 'new UI gestures still blocked during display/history work');
    const pending = f.api.leaseForOperations(f.ops);
    assert.equal(f.requests.length, 1, 'previously queued edit must request actual authority permission');
    await f.reply(); assert.equal(await pending, true);
  });
}

test('superseded notebook lease waits for the newer covering grant instead of stopping its queue', async () => {
  const f = await pendingLeaseFixture(); const pending = f.api.leaseForOperations(f.ops);
  const newer = f.api.acquireLocalSelectionLease([f.book, f.other]);
  await f.reply(); await f.reply(); assert.equal(await newer, true); assert.equal(await pending, true);
  assert.equal(f.requests.length, 2, 'reuse newer superset, do not displace it with a redundant request');
});

test('selection clear while a notebook permission request is pending does not discard the queued intent', async () => {
  const f = await pendingLeaseFixture(); const pending = f.api.leaseForOperations(f.ops);
  f.api.releaseLocalSelectionLease(f.book); await f.reply();
  assert.equal(f.requests.length, 2, 'reacquire once after local generation change');
  await f.reply(); assert.equal(await pending, true);
});

test('real foreign notebook lock is still denied without retries', async () => {
  const f = await pendingLeaseFixture(); f.authority.acquire({ clientId: 'student', lockToken: 'foreign-lock', objectIds: ['book'] });
  const pending = f.api.leaseForOperations(f.ops); await f.reply(); assert.equal(await pending, false); assert.equal(f.requests.length, 1);
});

test('network failure is not retried as a local selection change', async () => {
  const f = await pendingLeaseFixture(); const pending = f.api.leaseForOperations(f.ops);
  await f.reply({ reject: true }); assert.equal(await pending, false); assert.equal(f.requests.length, 1);
});

test('lost editing permission rejects even a previously granted notebook lease', async () => {
  const f = await pendingLeaseFixture(); const pending = f.api.leaseForOperations(f.ops); await f.reply(); assert.equal(await pending, true);
  f.scope.canEditRef.current = false; assert.equal(await f.api.leaseForOperations(f.ops), false);
});

test('a pending notebook grant never publishes to a replacement canvas', async () => {
  const f = await pendingLeaseFixture(); const pending = f.api.leaseForOperations(f.ops);
  f.scope.fabricCanvasRef.current = { getActiveObject: () => null, requestRenderAll() {} }; await f.reply(); assert.equal(await pending, false);
});
