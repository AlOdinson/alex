import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function fixture({ busy = false } = {}) {
  const source = readFileSync(new URL('../src/components/Board.jsx', import.meta.url), 'utf8');
  const body = source.split('  const selectInsertedObjects = useCallback((objects) => {')[1].split('\n  }, [')[0];
  const state = { selections: 0, discards: 0, tools: [] };
  const canvas = {
    discardActiveObject() { state.discards++; },
    setActiveObject() { state.selections++; },
    requestRenderAll() {},
  };
  const values = {
    fabricCanvasRef: { current: canvas },
    historyCommandBusyRef: { current: busy },
    selectedShapeRef: { current: null },
    activeToolRef: { current: 'pencil' },
    setToolState: (tool) => state.tools.push(tool),
    configureBrushAndMode() {}, updateSelectionState() {}, updateSelectionStyleState() {},
    createOuterOnlyActiveSelection: (objects) => ({ objects }),
  };
  const run = new Function('objects', ...Object.keys(values), body);
  return { state, select: () => run([{ canvas }], ...Object.values(values)) };
}

test('finishing an image upload during undo must not reselect/relock the image', () => {
  const f = fixture({ busy: true });
  f.select();
  assert.equal(f.state.selections, 0, 'the history command cleared selection before awaiting upload ACK');
  assert.deepEqual(f.state.tools, [], 'an old async upload must not switch tools during history');
});

test('normal completed insertion retains its expected selection behavior', () => {
  const f = fixture();
  f.select();
  assert.equal(f.state.selections, 1);
  assert.deepEqual(f.state.tools, ['select']);
});
