import assert from 'node:assert/strict';
import test from 'node:test';
import { createTeacherTabAuthority } from '../src/lib/teacherTabAuthority.js';

const flush = async () => { for (let i = 0; i < 30; i += 1) await Promise.resolve(); };

test('holds an exclusive board-scoped Web Lock until stopped', async () => {
  const events = [];
  let requestedName = '';
  let requestedOptions = null;
  let callbackStartedResolve;
  const callbackStarted = new Promise((resolve) => { callbackStartedResolve = resolve; });

  const lockManager = {
    async request(name, options, callback) {
      requestedName = name;
      requestedOptions = options;
      callbackStartedResolve();
      return callback({ name });
    },
  };

  const authority = createTeacherTabAuthority({
    boardId: 'board-a',
    lockManager,
    onChange: (isAuthority) => events.push(isAuthority),
  });

  const running = authority.start();
  await callbackStarted;
  await Promise.resolve();

  assert.equal(requestedName, 'alex-board-authority:board-a');
  assert.equal(requestedOptions.mode, 'exclusive');
  assert.equal(requestedOptions.ifAvailable, true);
  assert.ok(requestedOptions.signal);
  assert.equal(authority.isAuthority(), true);

  authority.stop();
  await running;

  assert.equal(authority.isAuthority(), false);
  assert.deepEqual(events, [true, false]);
});

test('rejects starting the same authority lease twice', async () => {
  let releaseCallback;
  const lockManager = {
    request(_name, _options, callback) {
      return new Promise((resolve) => {
        releaseCallback = () => Promise.resolve(callback({ name: 'held' })).then(resolve);
      });
    },
  };
  const authority = createTeacherTabAuthority({ boardId: 'board-b', lockManager });
  const first = authority.start();
  assert.throws(() => authority.start(), /already started/i);
  authority.stop();
  releaseCallback?.();
  await first;
});


test('falls back to best-effort single-tab authority when Web Locks are unavailable', async () => {
  const events = [];
  const authority = createTeacherTabAuthority({
    boardId: 'board-no-locks',
    lockManager: {},
    onChange: (value) => events.push(value),
  });
  await authority.start();
  assert.equal(authority.isAuthority(), true);
  assert.equal(authority.isBestEffortFallback(), true);
  authority.stop();
  assert.equal(authority.isAuthority(), false);
  assert.deepEqual(events, [true, false]);
});


test('does not fall back when another tab legitimately holds the Web Lock', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const authority = createTeacherTabAuthority({
    boardId: 'board-busy',
    storage: {
      getItem() { return null; },
      setItem() { throw new Error('fallback must not be used for a busy real lock'); },
      removeItem() {},
    },
    lockManager: {
      async request(_name, options, callback) {
        calls += 1;
        assert.equal(options.ifAvailable, true);
        return callback(null);
      },
    },
  });
  const running = authority.start();
  await flush();
  assert.equal(authority.isAuthority(), false);
  assert.equal(calls, 1);
  t.mock.timers.tick(750);
  await flush();
  assert.ok(calls >= 2);
  authority.stop();
  await running;
});

test('falls back when a present Web Locks API never answers', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const values = new Map();
  const storage = {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
  const authority = createTeacherTabAuthority({
    boardId: 'board-hung-locks',
    storage,
    lockManager: { request: () => new Promise(() => {}) },
  });
  const running = authority.start();
  await flush();
  t.mock.timers.tick(1500);
  await flush();
  assert.equal(authority.isAuthority(), true);
  assert.equal(authority.isBestEffortFallback(), true);
  authority.stop();
  await running;
});
