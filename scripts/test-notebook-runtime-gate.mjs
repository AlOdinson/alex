import test from 'node:test';
import assert from 'node:assert/strict';
import * as protocol from '../src/lib/notebookProtocol.js';
import { createTeacherBoardRuntime } from '../src/lib/teacherBoardRuntime.js';
import { createStudentBoardRuntime } from '../src/lib/studentBoardRuntime.js';
import { createBrowserBoardRepository } from '../src/lib/browserBoardRepositoryCompat.js';

test('notebook write activation is an explicit build gate, not a user supplied peer capability',()=>{
 assert.equal(typeof protocol.isNotebookRuntimeEnabled,'function','missing trusted runtime activation gate');
 assert.equal(protocol.isNotebookRuntimeEnabled({}),false);
 assert.equal(protocol.isNotebookRuntimeEnabled({VITE_NOTEBOOK_OPERATIONS_V1:'true'}),true);
 assert.equal(protocol.isNotebookRuntimeEnabled({notebookVersion:1}),false);
 assert.equal(protocol.isNotebookRuntimeEnabled({VITE_NOTEBOOK_OPERATIONS_V1:'false'}),false);
});

test('teacher runtime passes trusted activation and exposes one recovery checkpoint',async()=>{
 let enabled;const snapshot={canvas:{objects:[]}};
 const runtime=await createTeacherBoardRuntime({boardId:'book',clientId:'teacher',enableNotebookOperations:true,sendScreenShareSignal:async()=>{},
  openAuthority:async options=>{enabled=options.enableNotebookOperations;return {getNotebookVersion:()=>enabled?1:0,getSnapshot:()=>snapshot,getRevision:()=>7,getTombstones:()=>({old:{}}),getNotebookTombstones:()=>({child:{}})};},
  createHub:()=>({}),createSignaling:()=>({}),createNetwork:()=>({close(){}})});
 assert.equal(enabled,true);assert.equal(runtime.getNotebookVersion(),1);assert.deepEqual(runtime.getNotebookCheckpoint(),{snapshot,revision:7,tombstones:{old:{}},notebookTombstones:{child:{}}});runtime.close();
});

test('student runtime forwards activation but reports only negotiated notebook support',()=>{
 let options,negotiated=0;
 const runtime=createStudentBoardRuntime({boardId:'book',clientId:'student',teacherId:'teacher',enableNotebookOperations:true,sendScreenShareSignal:async()=>{},createSignaling:()=>({}),createNetwork:value=>{options=value;return {getNotebookVersion:()=>negotiated,close(){}};}});
 assert.equal(options.enableNotebookOperations,true);assert.equal(runtime.getNotebookVersion(),0);negotiated=1;assert.equal(runtime.getNotebookVersion(),1);runtime.close();
});

test('owner repository opens migrated notebooks with the same trusted capability',async()=>{
 let enabled;const repo=createBrowserBoardRepository({enableNotebookOperations:true,getBoard:async()=>({boardId:'book',ownerKey:'owner'}),openAuthority:async options=>{enabled=options.enableNotebookOperations;return {getSnapshot:()=>({canvas:{objects:[]}}),getRevision:()=>0};}});
 const access=await repo.getBoardAccess('book','owner');assert.equal(access.permission,'owner');assert.equal(enabled,true);
});
