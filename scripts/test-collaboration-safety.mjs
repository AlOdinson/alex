import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  createConditionalDeleteOps,
  createConditionalRecordPatchOps,
} from '../src/lib/operationProtocol.js';

const before = [{
  object: {
    type: 'path',
    boardObjectId: 'object-1',
    left: 10,
    top: 20,
    fill: '#111111',
    opacity: 0.5,
    updatedAt: 10,
    updatedBy: 'client-a',
    selectable: true,
  },
  zIndex: 3,
}];
const after = [{
  object: {
    ...before[0].object,
    fill: '#ff0000',
    opacity: undefined,
    updatedAt: 11,
  },
  zIndex: 4,
}];
delete after[0].object.opacity;

const [patch] = createConditionalRecordPatchOps(after, before, { reorder: true });
assert.equal(patch.type, 'patch');
assert.equal(patch.patch.fill, '#111111');
assert.equal(patch.patch.opacity, 0.5);
assert.equal(patch.ifFields.fill, '#ff0000');
assert.ok(patch.ifAbsent.includes('opacity'));
assert.equal(patch.ifZIndex, 4);
assert.equal(patch.zIndex, 3);

const [conditionalDelete] = createConditionalDeleteOps(before);
assert.equal(conditionalDelete.type, 'delete');
assert.equal(conditionalDelete.ifObjectVersion.left, 10);
assert.equal(conditionalDelete.ifObjectVersion.fill, '#111111');
assert.equal(conditionalDelete.ifObjectVersion.boardObjectId, undefined);
assert.equal(conditionalDelete.ifObjectVersion.updatedAt, undefined);
assert.equal(conditionalDelete.ifObjectVersion.selectable, undefined);
assert.equal(conditionalDelete.ifZIndex, 3);

const boardSource = await readFile(new URL('../src/components/Board.jsx', import.meta.url), 'utf8');
assert.match(boardSource, /object\.isEraserPath\s*\n\s*\|\| object\.pendingImage/g);
assert.match(boardSource, /acquireLocalSelectionLease\(active\)/);
assert.match(boardSource, /!ownsSelectionLease\(transform\.target\)/);
assert.match(boardSource, /refreshBoardObjectLocks\(/);
assert.match(boardSource, /createConditionalRecordPatchOps\(sourceRecords, records/);

const sqlSource = await readFile(new URL('../supabase/collaboration_safety_v8.sql', import.meta.url), 'utf8');
assert.match(sqlSource, /create table if not exists public\.board_object_locks_v8/);
assert.match(sqlSource, /l\.client_id <> coalesce\(p_client_id, ''\)/);
assert.match(sqlSource, /'skipped_conflicts', v_skipped/);
assert.match(sqlSource, /ifFields/);
assert.match(sqlSource, /ifTransform/);

console.log('Collaborative selection, conditional history, and image hydration safety tests passed.');
