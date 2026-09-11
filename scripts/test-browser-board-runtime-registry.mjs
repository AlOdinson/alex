import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getBoardRuntime,
  registerBoardRuntime,
} from '../src/lib/browserBoardRuntimeRegistry.js';

test('registers one active runtime per board and unregisters its own instance', () => {
  const runtime = { id: 'runtime-a' };
  const unregister = registerBoardRuntime('board-a', runtime);
  assert.equal(getBoardRuntime('board-a'), runtime);
  unregister();
  assert.equal(getBoardRuntime('board-a'), null);
});

test('stale cleanup cannot remove a newer runtime for the same board', () => {
  const first = { id: 'first' };
  const second = { id: 'second' };
  const unregisterFirst = registerBoardRuntime('board-replaced', first);
  const unregisterSecond = registerBoardRuntime('board-replaced', second);

  unregisterFirst();
  assert.equal(getBoardRuntime('board-replaced'), second);
  unregisterSecond();
  assert.equal(getBoardRuntime('board-replaced'), null);
});

test('rejects an invalid runtime registration', () => {
  assert.throws(() => registerBoardRuntime('', {}), /boardId/i);
  assert.throws(() => registerBoardRuntime('board-a', null), /runtime/i);
});
