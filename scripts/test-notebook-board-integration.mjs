import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const board=await readFile(new URL('../src/components/Board.jsx',import.meta.url),'utf8');
// These wiring assertions supplement runtime/Fabric behavior tests. They are NOT
// a substitute for the Chromium/WebKit end-to-end release gates.
test('Board uses the same trusted rollout gate as persistence and transport',()=>{
 assert.match(board,/enableNotebookOperations:\s*notebookRuntimeEnabled/);
 assert.match(board,/acquireNotebookClientIdentity\(/);
});
test('Board connects all four notebook gesture adapters rather than unused helpers',()=>{
 for(const name of ['capture','saveText','changePage','erase'])assert.match(board,new RegExp(`incrementalNotebookActions\\.${name}\\(`));
 assert.match(board,/createNotebookBoardController\(/);assert.match(board,/createNotebookOutbox\(/);
});
test('Board projects notebook state in place and distinguishes notebook commit ownership',()=>{
 assert.match(board,/prepareNotebookProjection\(/);assert.match(board,/stageNotebookVisualOperations\(/);
 assert.match(board,/notebookManaged/);assert.match(board,/notebookControllerRef\.current\?\.pendingObjectIds/);
});
test('Board retires its controller with the Canvas and suspends projection during snapshot recovery',()=>{
 assert.match(board,/notebookControllerRef\.current\?\.dispose\(/);
 assert.match(board,/suspendProjection\(/);assert.match(board,/resumeProjection\(/);
});
