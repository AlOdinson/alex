import assert from 'node:assert/strict';
import {
  DOCK_LAYOUT_CHANGE_EVENT,
  DOCK_LAYOUT_STORAGE_KEY,
  advanceDockLayoutMode,
  contextualDirectionForMode,
  getDockLayoutMode,
  initializeDockLayout,
  nextDockLayoutMode,
  normalizeDockLayoutMode,
  setDockLayoutMode,
} from '../src/dock-layout-controller.js';

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
  };
}

function fakeDocument() {
  const events = [];
  return {
    documentElement: { dataset: {} },
    dispatchEvent(event) { events.push(event); return true; },
    events,
  };
}

assert.equal(normalizeDockLayoutMode(null), '1');
assert.equal(normalizeDockLayoutMode('nope'), '1');
assert.equal(normalizeDockLayoutMode('1'), '1');
assert.equal(normalizeDockLayoutMode('2'), '2');
assert.equal(normalizeDockLayoutMode('3'), '3');
assert.equal(nextDockLayoutMode('1'), '2');
assert.equal(nextDockLayoutMode('2'), '3');
assert.equal(nextDockLayoutMode('3'), '1');
assert.equal(contextualDirectionForMode('1'), 'above');
assert.equal(contextualDirectionForMode('2'), 'below');
assert.equal(contextualDirectionForMode('3'), 'right');

{
  const doc = fakeDocument();
  const storage = memoryStorage({ [DOCK_LAYOUT_STORAGE_KEY]: '3' });
  assert.equal(initializeDockLayout({ doc, storage }), '3');
  assert.equal(doc.documentElement.dataset.dockLayout, '3');
  assert.equal(getDockLayoutMode(doc), '3');
}

{
  const doc = fakeDocument();
  const storage = memoryStorage();
  assert.equal(initializeDockLayout({ doc, storage }), '1');
  assert.equal(setDockLayoutMode('2', { doc, storage }), '2');
  assert.equal(storage.getItem(DOCK_LAYOUT_STORAGE_KEY), '2');
  assert.equal(advanceDockLayoutMode({ doc, storage }), '3');
  assert.equal(doc.documentElement.dataset.dockLayout, '3');
  assert.equal(doc.events.at(-1).type, DOCK_LAYOUT_CHANGE_EVENT);
  assert.deepEqual(doc.events.at(-1).detail, { mode: '3', direction: 'right' });
}

{
  const doc = fakeDocument();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() { throw new Error('storage blocked'); },
  });
  try {
    assert.equal(initializeDockLayout({ doc }), '1');
    assert.equal(setDockLayoutMode('2', { doc }), '2');
    assert.equal(advanceDockLayoutMode({ doc }), '3');
    assert.equal(doc.documentElement.dataset.dockLayout, '3');
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete globalThis.localStorage;
  }
}

console.log('Dock layout controller regression passed.');
