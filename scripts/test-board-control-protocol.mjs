import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BOARD_CONTROL_EVENTS,
  normalizeBoardControl,
} from '../src/lib/boardControlProtocol.js';

test('allows only explicitly listed reliable board-control events', () => {
  assert.deepEqual([...BOARD_CONTROL_EVENTS].sort(), [
    'background-live',
    'game-library-visibility',
    'lock',
    'mode',
    'selection-transaction',
    'view-jump',
    'view-request',
  ]);
  assert.deepEqual(normalizeBoardControl('mode', { mode: 'edit' }), {
    event: 'mode',
    payload: { mode: 'edit' },
  });
});

test('rejects unknown board-control events and non-object payloads', () => {
  assert.throws(() => normalizeBoardControl('cursor', { x: 1 }), /board control event/i);
  assert.throws(() => normalizeBoardControl('mode', null), /payload/i);
  assert.throws(() => normalizeBoardControl('mode', []), /payload/i);
});
