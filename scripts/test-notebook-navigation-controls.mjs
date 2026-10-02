// Real React/DOM controls; the only stub is the translation context. Pixel and
// native hit-testing coverage lives in test-notebook-navigation-browser.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { transformSync } from 'rolldown/experimental';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
const url = new URL('../src/components/NotebookPageControls.jsx', import.meta.url);
const source = (await readFile(url, 'utf8')).replace("import { useLanguage } from './LanguageProvider.jsx';", "const useLanguage = () => ({ ui: value => value });");
const temporary = new URL(`../src/components/.notebook-controls-unit-${process.pid}.mjs`, import.meta.url);
await writeFile(temporary, transformSync('NotebookPageControls.jsx', source, { jsx: { runtime: 'automatic' } }).code);
let Controls;
try { Controls = (await import(temporary.href)).default; } finally { await unlink(temporary); }

test('actual component has three opaque islands per notebook, stays visible without selection, and turns only on intentional taps', async () => {
  const dom = new JSDOM('<div id="host"><canvas></canvas><div id="app"></div></div>', { pretendToBeVisual: true });
  const before = { window: globalThis.window, document: globalThis.document, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT };
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const app = document.getElementById('app'), root = createRoot(app), changes = [];
  const notebooks = [{ id: 'a', pageNumber: 1, position: { width: 520, height: 480 } }, { id: 'b', pageNumber: 3, position: { width: 520, height: 480 } }];
  const render = props => act(() => root.render(React.createElement(Controls, { notebooks, canEdit: true, onPageChange: (...args) => changes.push(args), ...props })));
  const emit = async (target, type, fields = {}) => {
    const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { pointerId: 7, pointerType: 'pen', button: 0, isPrimary: true, clientX: 12, clientY: 12 }, fields);
    await act(() => target.dispatchEvent(event)); return event;
  };
  try {
    await render();
    assert.equal(app.querySelectorAll('.notebook-page-controls').length, 2);
    assert.equal(app.querySelectorAll('.notebook-nav-island').length, 6);
    assert.equal(app.querySelectorAll('button').length, 4);
    assert.equal(app.querySelector('.notebook-edit-text'), null, 'selection has no separate notebook action panel');
    const buttons = [...app.querySelectorAll('[data-notebook-id="a"] button')];
    assert.equal(buttons[0].disabled, true); assert.equal(buttons[1].disabled, false);
    const next = buttons[1]; next.getBoundingClientRect = () => ({ left: 0, top: 0, right: 40, bottom: 40 });
    await emit(next, 'pointerdown'); await emit(next, 'pointerup');
    await emit(next, 'click', { detail: 1 });
    assert.deepEqual(changes, [[1, 'a', true]], 'native compatibility click must not double-turn');
    const canvas = document.querySelector('canvas');
    await emit(canvas, 'pointerdown');
    assert.equal(app.querySelector('.notebook-navigation-layer').dataset.gestureActive, 'true');
    await emit(next, 'pointerup'); await emit(next, 'click', { detail: 1 });
    assert.equal(changes.length, 1, 'passing a live pen stroke across an arrow never turns');
    await emit(canvas, 'pointercancel'); await new Promise(resolve => setTimeout(resolve, 5));
    await emit(next, 'click', { detail: 0 }); assert.equal(changes.length, 2, 'keyboard click remains supported');
    await render({ canEdit: false }); assert.ok([...app.querySelectorAll('button')].every(button => button.disabled));
    await render({ notebooks: [notebooks[1]] }); assert.equal(app.querySelectorAll('.notebook-nav-island').length, 3);
    await render({ notebooks: [] }); assert.equal(app.querySelectorAll('.notebook-nav-island').length, 0);
  } finally {
    await act(() => root.unmount()); dom.window.close(); Object.assign(globalThis, before);
  }
});

test('navigation CSS masks only three small islands and allows crossing gestures to hit the canvas', async () => {
  const css = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
  const rule = selector => css.slice(css.indexOf(selector + ' {')).split('}')[0];
  assert.match(rule('.notebook-navigation-layer'), /pointer-events:none/);
  assert.doesNotMatch(rule('.notebook-page-controls'), /background|padding|box-shadow/);
  assert.match(rule('.notebook-nav-island'), /background:#fff;/);
  assert.match(rule('.notebook-nav-island'), /bottom:12px/);
  assert.match(rule('.notebook-nav-previous'), /left:12px/);
  assert.match(rule('.notebook-nav-next'), /right:12px/);
  assert.match(rule('.notebook-page-number'), /left:50%/);
  assert.match(css, /\[data-gesture-active="true"\] \.notebook-nav-island \* \{ pointer-events:none; \}/);
});
