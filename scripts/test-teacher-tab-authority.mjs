import assert from 'node:assert/strict';
import test from 'node:test';
import { createTeacherTabAuthority } from '../src/lib/teacherTabAuthority.js';

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
