import test from 'node:test';
import assert from 'node:assert/strict';
import { createStudentPeerSession } from '../src/lib/studentPeerSession.js';
import { connectionProgressText, reportConnectionProgress } from '../src/lib/connectionProgress.js';

test('progress reports are optional and cannot break networking when UI throws', () => {
  assert.doesNotThrow(() => reportConnectionProgress(() => { throw new Error('UI'); }, 3, 'route'));
  const text = connectionProgressText({ step: 3, detail: 'offer', path: 'student-initiated', since: 1000, retrying: true }, 9500);
  assert.match(text, /Шаг 3 из 6/);
  assert.match(text, /ожидаем ответ учителя/);
  assert.match(text, /Инициатор: ученик/);
  assert.match(text, /повторяем подключение/);
  assert.match(text, /8 с$/);
});

test('loading badge updates only for current student board, ticks and disappears at readiness', async () => {
  const oldWindow = globalThis.window;
  const oldDocument = globalThis.document;
  const win = new EventTarget();
  win.location = { pathname: '/board/progress-board' };
  let tick;
  let cleared = false;
  win.setInterval = callback => { tick = callback; return 1; };
  win.clearInterval = () => { cleared = true; };
  const appended = [];
  globalThis.window = win;
  globalThis.document = {
    documentElement: { dataset: {} }, body: { append: node => appended.push(node) },
    createElement: () => ({ dataset: {}, style: {}, textContent: '', remove() { this.removed = true; } }),
  };
  const send = (type, detail) => {
    const event = new Event(type);
    event.detail = detail;
    win.dispatchEvent(event);
  };
  try {
    await import(`../src/durableEditGate.js?progress-test`);
    send('alex-board-connection-progress', { boardId: 'progress-board', permission: 'edit', step: 5, detail: 'snapshot-wait', since: Date.now() - 4000 });
    const badge = appended.at(-1);
    assert.match(badge.textContent, /Шаг 5 из 6/);
    send('alex-board-connection-progress', { boardId: 'other', permission: 'edit', step: 1, detail: 'room' });
    assert.match(badge.textContent, /Шаг 5 из 6/);
    tick();
    assert.match(badge.textContent, /4 с$/);
    send('alex-board-runtime-state', { boardId: 'progress-board', permission: 'edit', state: 'ready' });
    assert.equal(badge.removed, true);
    assert.equal(cleared, true);
    send('alex-board-connection-progress', { boardId: 'progress-board', permission: 'edit', step: 6, detail: 'ready' });
    assert.equal(appended.length, 1, 'late progress must not reopen ready badge');
    send('alex-board-runtime-state', { boardId: 'progress-board', permission: 'edit', state: 'teacher-offline' });
    assert.match(appended.at(-1).textContent, /Шаг 2 из 6/);
    assert.match(appended.at(-1).textContent, /Владелец офлайн/);
    assert.doesNotMatch(appended.at(-1).textContent, /Отображаем доску/);
  } finally { globalThis.window = oldWindow; globalThis.document = oldDocument; }
});

test('student reports handshake, snapshot wait and installation at actual boundaries', async () => {
  const progress = [];
  let finishPaint;
  const painting = new Promise(resolve => { finishPaint = resolve; });
  const session = createStudentPeerSession({
    transport: { send: async () => {} }, getRevision: () => 0,
    applyCommit: async () => {}, installSnapshot: () => painting,
    onProgress: event => progress.push(event),
  });
  try {
    const starting = session.start();
    starting.catch(() => {});
    assert.equal(progress.at(-1)?.detail, 'handshake');
    await session.handleMessage({ type: 'head', payload: { revision: 3 } });
    assert.equal(progress.at(-1)?.detail, 'snapshot-wait');
    const installing = session.handleTransfer({ kind: 'snapshot', text: JSON.stringify({ snapshot: { objects: [] }, revision: 3 }) });
    await Promise.resolve();
    assert.equal(progress.at(-1)?.step, 6);
    finishPaint();
    await installing;
    await starting;
  } finally { session.close(); }
});
