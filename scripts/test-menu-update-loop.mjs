import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';

// Run the production menu scripts with real DOM/MutationObserver semantics.
// Only layout (absent in jsdom) and animation-frame timing are supplied here.
function menuFixture() {
  const dom = new JSDOM(`<!doctype html><html><body>
    <header class="toolbar-shell"><div class="toolbar-primary-row"></div>
    <div class="toolbar-secondary-row"><div class="language-toggle"><button class="active">RU</button><button>EN</button></div>
    <label class="background-control"><select><option value="grid">grid</option><option value="dots">dots</option></select></label></div>
    <button class="toolbar-share-button">Share</button><button class="toolbar-export-button">Export</button>
    <div class="desktop-screen-share"><button class="navigation-text-button">ShareScreen</button></div></header>
    <div class="board-tool-dock"><button class="dock-tool-button active" data-tool="pencil">Pencil</button><button class="dock-tool-button" data-tool="eraser">Eraser</button></div>
  </body></html>`, { url: 'https://example.test/', runScripts: 'outside-only' });
  const { window } = dom;
  const observers = [];
  const NativeMutationObserver = window.MutationObserver;
  window.MutationObserver = class extends NativeMutationObserver {
    constructor(callback) { super(callback); observers.push(this); }
  };
  const frames = new Map();
  let frameId = 0;
  window.requestAnimationFrame = (callback) => { frames.set(++frameId, callback); return frameId; };
  window.cancelAnimationFrame = (id) => frames.delete(id);
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    const hidden = this.hidden || this.closest('[hidden]');
    return { left: 400, top: 600, right: hidden ? 400 : 800, bottom: hidden ? 600 : 660,
      width: hidden ? 0 : 400, height: hidden ? 0 : 60 };
  };
  function load(file, exports = []) {
    const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8')
      .replace(/^import[\s\S]*?from ['"][^'"]+['"];\s*/gm, '')
      .replace(/^export /gm, '');
    window.eval(`(() => { ${source}\n${exports.map((name) => `window.${name} = ${name};`).join('\n')} })();`);
  }
  load('dock-layout-controller.js', ['getDockLayoutMode', 'advanceDockLayoutMode', 'contextualDirectionForMode', 'DOCK_LAYOUT_CHANGE_EVENT']);
  load('lib/historyDockLayout.js', ['historyDockPlacement']);
  for (const file of ['floating-drawing-controls-enhancer.js', 'dock-style-accessories.js',
    'dock-layout-runtime.js', 'dock-history-icons.js', 'dock-style-presets-gear.js', 'board-settings-gear.js']) load(file);
  async function settle() {
    for (let i = 0; i < 12; i++) {
      await new Promise((resolve) => setImmediate(resolve));
      if (!frames.size) return;
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach((callback) => callback(i * 16));
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(frames.size, 0, 'unchanged menu must stop scheduling animation frames');
  }
  function controls(kind = 'drawing') {
    const root = window.document.createElement('div');
    root.className = kind === 'selection' ? 'selected-style-controls' : 'floating-drawing-controls';
    root.setAttribute('aria-label', 'Параметры рисования');
    root.innerHTML = `<label class="color-control"><input type="color" value="#111827"></label>
      <button class="eyedropper-button">Pick</button>
      <label class="compact-slider"><input type="range" min="0.05" max="1" step="0.05" value="1"><strong>100%</strong></label>
      <label class="compact-slider"><input type="range" min="1" max="12" value="3"><strong>3px</strong></label>`;
    window.document.body.append(root);
    return root;
  }
  return { window, document: window.document, settle, controls, close: () => {
    observers.forEach((observer) => observer.disconnect());
    window.close();
  } };
}

test('pencil/eraser switches settle without losing layout or accessory visibility', async () => {
  const f = menuFixture();
  try {
    for (let i = 0; i < 3; i++) {
      const drawing = f.controls();
      await f.settle();
      assert.equal(f.document.querySelector('.dock-style-right-accessories').hidden, false);
      drawing.remove();
      f.document.querySelector('[data-tool="pencil"]').classList.remove('active');
      f.document.querySelector('[data-tool="eraser"]').classList.add('active');
      await f.settle();
      assert.equal(f.document.querySelector('.dock-style-right-accessories').hidden, true);
      assert.equal(f.document.querySelector('.dock-history-accessories').hidden, false);
      f.document.querySelector('[data-tool="eraser"]').classList.remove('active');
      f.document.querySelector('[data-tool="pencil"]').classList.add('active');
    }
    for (const mode of ['2', '3', '1']) {
      f.document.querySelector('.dock-layout-mode-button').click();
      await f.settle();
      assert.equal(f.document.documentElement.dataset.dockLayout, mode);
      assert.equal(f.document.querySelector('.dock-layout-mode-button').textContent, mode);
    }
  } finally { f.close(); }
});

test('selection controls settle and still forward changed color/opacity/width', async () => {
  const f = menuFixture();
  try {
    const source = f.controls('selection');
    await f.settle();
    const proxy = f.document.querySelector('.selection-floating-proxy');
    assert.equal(proxy.hidden, false);
    for (const [kind, value, selector] of [
      ['color', '#ff0000', 'input[type="color"]'],
      ['opacity', '0.5', 'input[max="1"]'],
      ['width', '6', 'input[max="12"]'],
    ]) {
      const input = proxy.querySelector(`[data-selection-proxy-input="${kind}"]`);
      input.value = value;
      input.dispatchEvent(new f.window.Event('input', { bubbles: true }));
      await f.settle();
      assert.equal(source.querySelector(selector).value, value);
    }
    assert.equal(proxy.querySelector('input[data-selection-proxy-input="opacity"]').closest('label').querySelector('strong').textContent, '50%');
    assert.equal(proxy.querySelector('input[data-selection-proxy-input="width"]').closest('label').querySelector('strong').textContent, '8px');
    for (const disabled of [true, false]) {
      source.querySelectorAll('input').forEach((input) => { input.disabled = disabled; });
      await f.settle();
      for (const input of proxy.querySelectorAll('input')) assert.equal(input.disabled, disabled);
    }
    source.remove();
    await f.settle();
    assert.equal(proxy.hidden, true);
  } finally { f.close(); }
});

test('history and settings buttons retain their actions after menu settles', async () => {
  const f = menuFixture();
  try {
    await f.settle();
    const history = [];
    f.window.addEventListener('keydown', (event) => history.push([event.key, event.shiftKey, event.alexBoardHistoryCommand]));
    f.document.querySelector('.dock-history-undo').click();
    f.document.querySelector('.dock-history-redo').click();
    assert.deepEqual(history, [['z', false, true], ['z', true, true]]);
    let shares = 0;
    f.document.querySelector('.toolbar-share-button').addEventListener('click', () => shares++);
    f.document.querySelector('.alex-settings-gear').click();
    f.document.querySelector('[data-action="share"]').click();
    await f.settle();
    assert.equal(shares, 1);
    for (const [action, selector] of [['export', '.toolbar-export-button'], ['screenShare', '.desktop-screen-share button']]) {
      let activations = 0;
      f.document.querySelector(selector).addEventListener('click', () => activations++);
      f.document.querySelector('.alex-settings-gear').click();
      f.document.querySelector(`[data-action="${action}"]`).click();
      await f.settle();
      assert.equal(activations, 1);
    }
    f.document.querySelector('[data-background="dots"]').click();
    await f.settle();
    assert.equal(f.document.querySelector('.background-control select').value, 'dots');
    assert.equal(f.document.querySelector('[data-current-background]').textContent, 'Точки');
    const languageButtons = [...f.document.querySelectorAll('.language-toggle button')];
    languageButtons[1].addEventListener('click', () => {
      languageButtons[0].classList.remove('active');
      languageButtons[1].classList.add('active');
    });
    f.document.querySelector('[data-action="language"]').click();
    await f.settle();
    assert.equal(f.document.querySelector('.alex-settings-gear').getAttribute('aria-label'), 'Settings');
    assert.equal(f.document.querySelector('[data-current-background]').textContent, 'Dots');
  } finally { f.close(); }
});
