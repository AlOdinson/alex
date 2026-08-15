import assert from 'node:assert/strict';

class FakeElement extends EventTarget {
  constructor(tagName) {
    super();
    this.tagName = String(tagName).toUpperCase();
    this.dataset = {};
    this.style = { cssText: '' };
    this.children = [];
    this.textContent = '';
    this.hidden = false;
    this.scrollTop = 0;
    this.scrollHeight = 0;
  }

  append(...children) {
    this.children.push(...children);
  }

  setAttribute() {}

  focus() {}

  select() {}

  remove() {
    this.removed = true;
  }
}

const fakeWindow = new EventTarget();
Object.assign(fakeWindow, {
  location: {
    search: '?pencilDebug=1',
    origin: 'https://example.test',
    pathname: '/alex/board/test',
  },
  innerWidth: 820,
  innerHeight: 1056,
  devicePixelRatio: 2,
  PointerEvent: function PointerEvent() {},
  TouchEvent: function TouchEvent() {},
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
});
let nextFrame = 0;
fakeWindow.requestAnimationFrame = (callback) => {
  const id = nextFrame + 1;
  nextFrame = id;
  queueMicrotask(() => callback(performance.now()));
  return id;
};
fakeWindow.cancelAnimationFrame = () => {};

const fakeDocument = {
  body: new FakeElement('body'),
  createElement: (tagName) => new FakeElement(tagName),
  execCommand: () => true,
};

Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
Object.defineProperty(globalThis, 'document', { configurable: true, value: fakeDocument });
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    userAgent: 'diagnostic-runtime-test',
    platform: 'test',
    maxTouchPoints: 5,
    clipboard: { writeText: async () => {} },
  },
});

const { createPencilDiagnostics } = await import('../src/lib/pencilDiagnostics.js');

function diagnosticEvent(type, properties) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries(properties)) {
    Object.defineProperty(event, key, { configurable: true, value });
  }
  return event;
}

const diagnostics = createPencilDiagnostics({ version: 'runtime-test' });
assert.ok(diagnostics, 'pencilDebug=1 must create the diagnostic observer');

fakeWindow.dispatchEvent(diagnosticEvent('pointermove', {
  pointerType: 'pen', pointerId: 91, buttons: 1, pressure: 0.18, clientX: 100, clientY: 120,
}));
fakeWindow.dispatchEvent(diagnosticEvent('pointerrawupdate', {
  pointerType: 'pen', pointerId: 91, buttons: 1, pressure: 0.24, clientX: 108, clientY: 128,
}));
fakeWindow.dispatchEvent(diagnosticEvent('pointermove', {
  pointerType: 'pen', pointerId: 91, buttons: 0, pressure: 0, clientX: 112, clientY: 132,
}));

const stylus = {
  identifier: 92,
  touchType: 'stylus',
  clientX: 140,
  clientY: 160,
  force: 0.3,
  radiusX: 0,
  radiusY: 0,
};
fakeWindow.dispatchEvent(diagnosticEvent('touchmove', {
  changedTouches: [stylus], touches: [stylus],
}));
fakeWindow.dispatchEvent(diagnosticEvent('touchend', {
  changedTouches: [{ ...stylus, force: 0 }], touches: [],
}));

fakeWindow.dispatchEvent(diagnosticEvent('mousemove', {
  buttons: 1, button: 0, clientX: 170, clientY: 180, sourceCapabilities: { firesTouchEvents: true },
}));
fakeWindow.dispatchEvent(diagnosticEvent('mouseup', {
  buttons: 0, button: 0, clientX: 180, clientY: 190, sourceCapabilities: { firesTouchEvents: true },
}));

await Promise.resolve();
const exported = diagnostics.exportText();
assert.match(exported, /summary=P:0 · T:0 · OrphanP:1 · OrphanT:1 · Mouse:1 · Raw:1/);
assert.match(exported, /RAW orphan pen contact start/);
assert.match(exported, /RAW orphan pen contact sample/);
assert.match(exported, /RAW orphan pen contact end by hover/);
assert.match(exported, /RAW orphan stylus touchmove start/);
assert.match(exported, /RAW orphan stylus touchend/);
assert.match(exported, /RAW orphan compatibility mouse contact/);
assert.match(exported, /RAW compatibility mouseup/);

diagnostics.destroy();
assert.equal(fakeDocument.body.children[0]?.removed, true, 'destroy must remove the panel');

console.log('Apple Pencil orphan diagnostic runtime checks passed.');
