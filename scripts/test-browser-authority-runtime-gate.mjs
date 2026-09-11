import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createBrowserBoardSession } from '../src/lib/browserBoardSession.js';

class RuntimeStateEvent extends Event {
  constructor(type, options = {}) {
    super(type);
    this.detail = options.detail ?? null;
  }
}

test('browser session emits waiting and ready runtime state events for UI edit gating', async () => {
  const fakeWindow = new EventTarget();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
  Object.defineProperty(globalThis, 'CustomEvent', { configurable: true, value: RuntimeStateEvent });

  const events = [];
  fakeWindow.addEventListener('alex-board-runtime-state', (event) => events.push(event.detail));

  let authorityChange = null;
  let held = false;
  const session = createBrowserBoardSession({
    boardId: 'gate-board',
    clientId: 'gate-owner',
    permission: 'owner',
    sendScreenShareSignal: async () => {},
    createTeacherTabAuthority: ({ onChange }) => {
      authorityChange = onChange;
      return {
        start: () => new Promise(() => {}),
        stop() { held = false; onChange(false); },
        isAuthority() { return held; },
      };
    },
    createTeacherRuntime: async () => ({
      getRevision: () => 0,
      commitTeacherAction: async (action) => ({ ...action, revision: 1, changed: true, appliedOps: action.ops }),
      close() {},
    }),
    registerRuntime: () => () => {},
  });

  const startTask = session.start();
  await Promise.resolve();
  assert.equal(events.at(-1)?.state, 'waiting');
  assert.equal(events.at(-1)?.permission, 'owner');
  assert.equal(events.at(-1)?.boardId, 'gate-board');

  held = true;
  authorityChange(true);
  await startTask;
  assert.equal(events.at(-1)?.state, 'ready');
  session.close();
});

test('application loads the durable edit gate before rendering the board', async () => {
  const main = await readFile(new URL('../src/main.jsx', import.meta.url), 'utf8');
  assert.match(main, /import ['"]\.\/durableEditGate\.js['"]/,
    'main must install the authority edit gate before React renders Board');
});

test('gate installed on the library route activates after SPA navigation into a board', async () => {
  const fakeWindow = new EventTarget();
  fakeWindow.location = { pathname: '/alex/preview-browser-authority/' };

  const root = { dataset: {} };
  const appended = [];
  const fakeDocument = {
    documentElement: root,
    body: { append: (node) => appended.push(node) },
    createElement() {
      return {
        dataset: {},
        style: {},
        textContent: '',
        remove() {},
      };
    },
  };

  Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: fakeDocument });
  Object.defineProperty(globalThis, 'CustomEvent', { configurable: true, value: RuntimeStateEvent });

  await import(`../src/durableEditGate.js?spa-gate-test=${Date.now()}`);

  fakeWindow.location.pathname = '/alex/preview-browser-authority/board/spa-board';
  fakeWindow.dispatchEvent(new RuntimeStateEvent('alex-board-runtime-state', {
    detail: {
      state: 'waiting',
      boardId: 'spa-board',
      clientId: 'spa-owner',
      permission: 'owner',
    },
  }));

  assert.equal(root.dataset.alexDurableEditState, 'waiting');
  assert.equal(root.dataset.alexDurableEditBlocked, 'true');
  assert.equal(appended.at(-1)?.dataset?.alexDurableEditGate, 'true');

  fakeWindow.dispatchEvent(new RuntimeStateEvent('alex-board-runtime-state', {
    detail: {
      state: 'ready',
      boardId: 'spa-board',
      clientId: 'spa-owner',
      permission: 'owner',
    },
  }));
  assert.equal(root.dataset.alexDurableEditState, 'ready');
  assert.equal(root.dataset.alexDurableEditBlocked, 'false');
});
