import assert from 'node:assert/strict';
import {
  applySerializedObjectPatch,
  createRecordPatchOps,
} from '../src/lib/operationProtocol.js';
import { applyOpsToSnapshot } from '../src/lib/boardRepository.js';

function clone(value) {
  return structuredClone(value);
}

function applyOperations(sourceState, operations, background = null) {
  const state = clone(sourceState);
  const objects = state.objects;
  const byId = new Map(objects.map((object) => [String(object.boardObjectId), object]));

  for (const operation of operations) {
    if (operation.type === 'delete') {
      const existing = byId.get(String(operation.id));
      if (existing) objects.splice(objects.indexOf(existing), 1);
      byId.delete(String(operation.id));
      continue;
    }
    if (operation.type === 'upsert') {
      const id = String(operation.object.boardObjectId);
      const existing = byId.get(id);
      if (existing) objects.splice(objects.indexOf(existing), 1);
      const index = Math.max(0, Math.min(objects.length, Number(operation.zIndex ?? objects.length)));
      const inserted = clone(operation.object);
      objects.splice(index, 0, inserted);
      byId.set(id, inserted);
      continue;
    }
    if (operation.type === 'patch') {
      const id = String(operation.id);
      const existing = byId.get(id);
      const patched = applySerializedObjectPatch(existing, operation);
      if (!patched) continue;
      const oldIndex = objects.indexOf(existing);
      objects.splice(oldIndex, 1);
      const index = operation.reorder
        ? Math.max(0, Math.min(objects.length, Number(operation.zIndex ?? oldIndex)))
        : oldIndex;
      objects.splice(index, 0, patched);
      byId.set(id, patched);
      continue;
    }
    if (operation.type === 'transform') {
      for (const entry of operation.objects ?? []) {
        const existing = byId.get(String(entry.id));
        if (!existing) continue;
        Object.assign(existing, clone(entry.transform), {
          updatedAt: entry.updatedAt,
          updatedBy: entry.updatedBy,
        });
      }
    }
  }
  if (background) state.background = background;
  return state;
}

class Sequencer {
  constructor(state) {
    this.state = clone(state);
    this.revision = 0;
    this.actions = [];
    this.byActionId = new Map();
  }

  commit(action) {
    if (this.byActionId.has(action.actionId)) return this.byActionId.get(action.actionId);
    this.revision += 1;
    const committed = { ...clone(action), revision: this.revision };
    this.actions.push(committed);
    this.byActionId.set(action.actionId, committed);
    this.state = applyOperations(this.state, committed.ops, committed.background);
    return committed;
  }

  after(revision) {
    return this.actions.filter((action) => action.revision > revision);
  }
}

class ClientReplica {
  constructor(state) {
    this.state = clone(state);
    this.revision = 0;
  }

  receive(action) {
    if (action.revision <= this.revision) return true;
    if (action.revision !== this.revision + 1) return false;
    this.state = applyOperations(this.state, action.ops, action.background);
    this.revision = action.revision;
    return true;
  }

  catchUp(server) {
    for (const action of server.after(this.revision)) {
      assert.equal(this.receive(action), true);
    }
  }
}

const base = {
  background: 'grid',
  objects: [{
    boardObjectId: 'shared',
    type: 'path',
    left: 0,
    top: 0,
    stroke: '#111111',
    opacity: 1,
    updatedAt: 1,
    updatedBy: 'seed',
  }],
};

const before = [{ object: base.objects[0], zIndex: 0 }];
const restyled = [{
  object: { ...base.objects[0], stroke: '#ff0000', updatedAt: 2, updatedBy: 'teacher' },
  zIndex: 0,
}];
const styleOps = createRecordPatchOps(before, restyled);
assert.equal(styleOps.length, 1);
assert.deepEqual(styleOps[0].patch, { stroke: '#ff0000' });
assert.equal(Object.prototype.hasOwnProperty.call(styleOps[0].patch, 'left'), false);

const reducerSnapshot = applyOpsToSnapshot({
  version: 2,
  background: 'grid',
  canvas: { objects: clone(base.objects) },
}, [
  ...styleOps,
  {
    type: 'transform',
    objects: [{
      id: 'shared',
      transform: { left: 240, top: 90 },
      updatedAt: 3,
      updatedBy: 'student-1',
    }],
  },
]);
assert.equal(reducerSnapshot.canvas.objects[0].stroke, '#ff0000');
assert.equal(reducerSnapshot.canvas.objects[0].left, 240);
assert.equal(reducerSnapshot.canvas.objects[0].top, 90);

const tombstoneSnapshot = applyOpsToSnapshot(reducerSnapshot, [
  { type: 'delete', id: 'shared' },
  {
    type: 'patch',
    id: 'shared',
    patch: { stroke: '#00ff00' },
    updatedAt: 999,
    updatedBy: 'late-client',
  },
]);
assert.equal(tombstoneSnapshot.canvas.objects.length, 0);

const server = new Sequencer(base);
const clients = Array.from({ length: 4 }, () => new ClientReplica(base));

server.commit({ actionId: 'style-action', clientId: 'teacher', ops: styleOps });
server.commit({
  actionId: 'move-action',
  clientId: 'student-1',
  ops: [{
    type: 'transform',
    objects: [{
      id: 'shared',
      transform: { left: 240, top: 90 },
      updatedAt: 3,
      updatedBy: 'student-1',
    }],
  }],
});

// Four simultaneous large pastes are four atomic revisions, not hundreds of chunks.
for (let clientIndex = 0; clientIndex < 4; clientIndex += 1) {
  const ops = Array.from({ length: 200 }, (_, objectIndex) => ({
    type: 'upsert',
    object: {
      boardObjectId: `paste-${clientIndex}-${objectIndex}`,
      type: 'circle',
      left: clientIndex * 1000 + objectIndex,
      top: objectIndex,
      fill: '#3b82f6',
      updatedAt: 10 + objectIndex,
      updatedBy: `client-${clientIndex}`,
    },
    zIndex: 1 + clientIndex * 200 + objectIndex,
  }));
  const beforeRevision = server.revision;
  server.commit({ actionId: `paste-action-${clientIndex}`, clientId: `client-${clientIndex}`, ops });
  assert.equal(server.revision, beforeRevision + 1);
}

server.commit({
  actionId: 'delete-action',
  clientId: 'student-2',
  ops: [{ type: 'delete', id: 'paste-1-17' }],
});
server.commit({
  actionId: 'late-style-after-delete',
  clientId: 'student-3',
  ops: [{
    type: 'patch',
    id: 'paste-1-17',
    patch: { fill: '#00ff00' },
    updatedAt: 99999,
    updatedBy: 'student-3',
  }],
});

// A retry with the same actionId is idempotent.
const revisionBeforeRetry = server.revision;
server.commit({ actionId: 'delete-action', clientId: 'student-2', ops: [] });
assert.equal(server.revision, revisionBeforeRetry);

// Deliver deliberately incomplete and out-of-order realtime packets.
clients[0].receive(server.actions[1]);
clients[1].receive(server.actions.at(-1));
clients[2].receive(server.actions[0]);
clients[2].receive(server.actions[0]);
clients[3].receive(server.actions[3]);

// A database head notification makes every replica recover exact missing revisions.
clients.forEach((client) => client.catchUp(server));
const canonical = JSON.stringify(server.state);
clients.forEach((client) => {
  assert.equal(client.revision, server.revision);
  assert.equal(JSON.stringify(client.state), canonical);
});

const shared = server.state.objects.find((object) => object.boardObjectId === 'shared');
assert.equal(shared.stroke, '#ff0000');
assert.equal(shared.left, 240);
assert.equal(shared.top, 90);
assert.equal(server.state.objects.some((object) => object.boardObjectId === 'paste-1-17'), false);

console.log('Authoritative v8 multi-client convergence tests passed.');
