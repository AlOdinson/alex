import assert from 'node:assert/strict';

class FakeElement extends EventTarget {
  constructor(tagName) {
    super();
    this.tagName = String(tagName).toUpperCase();
    this.dataset = {};
    this.style = { cssText: '' };
    this.children = [];
    this.textContent = '';
    this.scrollTop = 0;
    this.scrollHeight = 0;
  }

  append(...children) { this.children.push(...children); }
  remove() { this.removed = true; }
}

const fakeWindow = new EventTarget();
Object.assign(fakeWindow, {
  location: { search: '', pathname: '/alex/board/gate-board' },
  setInterval: globalThis.setInterval.bind(globalThis),
  clearInterval: globalThis.clearInterval.bind(globalThis),
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
  requestAnimationFrame(callback) {
    return globalThis.setTimeout(() => callback(performance.now()), 0);
  },
  cancelAnimationFrame(handle) {
    globalThis.clearTimeout(handle);
  },
});

const root = new FakeElement('html');
root.dataset.alexDurableEditState = 'waiting';
root.dataset.alexDurableEditPermission = 'owner';
root.dataset.alexDurableEditBlocked = 'true';

let freezePanel = null;
const fakeDocument = Object.assign(new EventTarget(), {
  visibilityState: 'visible',
  documentElement: root,
  body: new FakeElement('body'),
  hasFocus() { return true; },
  createElement(tagName) {
    const element = new FakeElement(tagName);
    if (String(tagName).toLowerCase() === 'aside') freezePanel = element;
    return element;
  },
  querySelector(selector) {
    if (selector === '[data-pencil-freeze-debug="true"]') {
      return freezePanel?.dataset?.pencilFreezeDebug === 'true' ? freezePanel : null;
    }
    if (selector === '[data-pencil-debug-summary="true"]') return { textContent: 'P:0 · T:0' };
    if (selector === '[data-pencil-debug-output="true"]') return { textContent: 'journal' };
    return null;
  },
});

Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
Object.defineProperty(globalThis, 'document', { configurable: true, value: fakeDocument });
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { userAgent: 'freeze-diagnostic-test', clipboard: { writeText: async () => {} } },
});

const { installFreezeDiagnostics } = await import('../src/pencilFreezeDiagnostics.js');
fakeWindow.location.search = '?pencilDebug=1';
const diagnostics = installFreezeDiagnostics();
assert.ok(diagnostics, 'pencilDebug=1 must install freeze diagnostics');

const exported = diagnostics.exportText();
assert.match(exported, /maxRafGapMs=0/);
assert.match(exported, /pageVisibility=visible/);
assert.match(exported, /pageHasFocus=true/);
assert.match(exported, /durableEditState=waiting/);
assert.match(exported, /durableEditPermission=owner/);
assert.match(exported, /durableEditBlocked=true/);

diagnostics.destroy();
console.log('Pencil freeze diagnostics render-loop and durable edit gate checks passed.');
