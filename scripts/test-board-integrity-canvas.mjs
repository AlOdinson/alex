import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { createIntegrityBudget } from '../src/lib/boardIntegrityData.js';
const exists = fs.existsSync(new URL('../src/lib/boardIntegrityCanvas.js', import.meta.url));
const mod = exists ? await import('../src/lib/boardIntegrityCanvas.js') : {};
test('Canvas integrity adapter exists', () => assert.ok(exists));
const check = (name, fn) => test(name, { skip: !exists }, fn);
function harness() {
  let revision = 4, busy = false, late = null, background = 'grid';
  const protectedIds = new Set();
  const objects = [{ boardObjectId: 'A', left: 4 }, { transientPreview: true, boardObjectId: 'preview' }, { boardObjectId: 'B', left: 7 }, { boardObjectId: 'A', left: 99 }];
  const calls = [];
  const canvas = { size: () => objects.length, item: (i) => objects[i] };
  const adapter = mod.createCanvasIntegrityAdapter({
    getCanvas: () => canvas, getRevision: () => revision, isReady: () => true, isBusy: () => busy,
    isProtected: (id) => protectedIds.has(id), getBackground: () => background,
    applyRecord: async (record, guard) => {
      if (late) await late();
      if (!guard()) return false;
      calls.push(record.id);
      for (let i = objects.length - 1; i >= 0; i--) if (objects[i].boardObjectId === record.id) objects.splice(i, 1);
      if (record.object) objects.splice(record.zIndex, 0, structuredClone(record.object));
      return true;
    },
    applyBackground: (value) => { background = value; },
  });
  return { adapter, objects, protectedIds, calls, change: () => revision++, busy: () => { busy = true; }, later: (fn) => { late = fn; } };
}
check('captures real duplicate membership and layer order without whole-canvas serialization', async () => {
  const h = harness();
  const records = await h.adapter.capture(['A', 'B', 'deleted'], createIntegrityBudget());
  assert.deepEqual(records.map((r) => [r.id, r.count, r.zIndex]), [['A', 2, 2], ['B', 1, 1], ['deleted', 0, -1]]);
  assert.equal(records[0].object.left, 99);
});
check('protects changed objects including currently absent IDs', async () => {
  const h = harness(); h.protectedIds.add('deleted');
  const [record] = await h.adapter.capture(['deleted'], createIntegrityBudget());
  assert.equal(record.protected, true);
});
check('repair checks the revision again after asynchronous object loading', async () => {
  const h = harness(); h.later(async () => h.change());
  const result = await h.adapter.repair([{ id: 'A', count: 0, object: null, zIndex: -1 }], null, { revision: 4, isCurrent: () => true, budget: createIntegrityBudget() });
  assert.equal(result, false); assert.equal(h.calls.length, 0); assert.equal(h.objects.length, 4);
});
check('repair cannot overwrite a gesture that begins while loading', async () => {
  const h = harness(); h.later(async () => h.busy());
  const result = await h.adapter.repair([{ id: 'A', count: 0, object: null, zIndex: -1 }], null, { revision: 4, isCurrent: () => true, budget: createIntegrityBudget() });
  assert.equal(result, false); assert.equal(h.calls.length, 0);
});
check('targeted deletion removes all duplicate copies without a user action', async () => {
  const h = harness();
  const result = await h.adapter.repair([{ id: 'A', count: 0, object: null, zIndex: -1 }], null, { revision: 4, isCurrent: () => true, budget: createIntegrityBudget() });
  assert.equal(result, true); assert.equal(h.objects.some((o) => o.boardObjectId === 'A'), false); assert.deepEqual(h.calls, ['A']);
});
check('Fabric projection reads real path data and normalizes per-character text styles without cloning the board', async () => {
  assert.equal(typeof mod.projectFabricIntegrityObject, 'function');
  const path = [['M', 0, 0], ['L', 1, 1]];
  const source = { type: 'textbox', boardObjectId: 'T', text: 'abc', path,
    _unwrappedTextLines: [['a','b','c']], styles: { 0: { 0: { fill: 'red' }, 1: { fill: 'red' } } } };
  const view = await mod.projectFabricIntegrityObject(source, createIntegrityBudget(), () => ({ left: 8 }));
  assert.equal(view.path, path);
  assert.equal(view.left, 8);
  assert.deepEqual(view.styles, [{ start: 0, end: 2, style: { fill: 'red' } }]);
  assert.equal(source.left, undefined);
});
test('real Board replay rechecks an audit guard after object enlivening', async () => {
  const source = fs.readFileSync(new URL('../src/components/Board.jsx', import.meta.url), 'utf8');
  const start = source.indexOf('  const replayPendingActionsLocally = useCallback(');
  const end = source.indexOf('\n\n  const ', start + 1);
  const objects = []; let current = true;
  const canvas = { getActiveObjects: () => [], getObjects: () => objects,
    add: (o) => objects.push(o), remove: (o) => objects.splice(objects.indexOf(o), 1), requestRenderAll() {}, renderOnAddRemove: true };
  const scope = { useCallback: (fn) => fn, fabricCanvasRef: { current: canvas }, BACKGROUNDS: new Set(['grid','dots','blank']),
    affectedOperationIds: (ops) => new Set(ops.map((op) => op.object?.boardObjectId ?? op.id)),
    registeredObjectsById: (id) => objects.filter((o) => o.boardObjectId === id),
    removeRegisteredObjectsById: () => {}, applySerializedObjectPatch: () => null,
    serializedObjectCacheRef: { current: new WeakMap() }, serializeObject: (o) => o,
    preloadSerializedImages: async () => {},
    enlivenImageAwareObjects: async (values) => { current = false; return values; },
    createPendingImagePlaceholder: (o) => o,
    applyingRemoteRef: { current: false }, clientIdRef: { current: 'test' },
    activeToolRef: { current: 'pencil' }, penTransformSpatialApiRef: { current: null },
    applyBackground() {}, applyObjectInteractivityToObjects() {}, deduplicateRegisteredObjectIds() {},
  };
  const replay = new Function('scope', `with(scope) { ${source.slice(start, end)}; return replayPendingActionsLocally; }`)(scope);
  const result = await replay([{ ops: [{ type: 'upsert', object: { type: 'Rect', boardObjectId: 'A' } }] }], { isCurrent: () => current });
  assert.equal(result, false);
  assert.equal(objects.length, 0, 'stale loaded replacement must never touch Canvas');
});

test('a completed move can be audited while its object remains selected', () => {
  const source=fs.readFileSync(new URL('../src/components/Board.jsx',import.meta.url),'utf8');
  const start=source.indexOf('    const integrityProtected = (id) => {');
  const end=source.indexOf('\n    };',start)+7;
  const scope={getLocalMutationIds:()=>new Set(['A']),pendingLocalObjectMutationCountsRef:{current:new Map()},remoteLocksRef:{current:new Map()}};
  const isProtected=new Function('scope',`with(scope){${source.slice(start,end)}; return integrityProtected;}`)(scope);
  assert.equal(isProtected('A'),false,'an idle selection alone is not an unconfirmed mutation');
  scope.pendingLocalObjectMutationCountsRef.current.set('A',1);
  assert.equal(isProtected('A'),true);
});
