import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BOARD_LIVE_PROTOCOL,
  LIVE_EVENT_TYPES,
  MAX_LIVE_FRAME_BYTES,
  decodeLiveEvent,
  encodeLiveEvent,
} from '../src/lib/liveEventProtocol.js';

const base = (overrides = {}) => ({
  type: 'cursor',
  boardId: 'board-a',
  clientId: 'student-a',
  seq: 1,
  baseRevision: 7,
  timestamp: 123456,
  streamKey: 'cursor',
  payload: { x: 10.25, y: 20.5 },
  ...overrides,
});

test('encodes and decodes a valid live event', () => {
  const highest = new Map();
  const encoded = encodeLiveEvent(base());
  const parsed = JSON.parse(encoded);
  assert.equal(parsed.protocol, BOARD_LIVE_PROTOCOL);
  assert.equal(parsed.type, 'cursor');
  assert.deepEqual(parsed.payload, { x: 10.25, y: 20.5 });

  const decoded = decodeLiveEvent(encoded, {
    boardId: 'board-a',
    remoteClientId: 'student-a',
    highestSeqByStream: highest,
  });

  assert.equal(decoded.protocol, 'alex-board-live-v1');
  assert.equal(decoded.seq, 1);
  assert.equal(decoded.baseRevision, 7);
  assert.equal(decoded.streamKey, 'cursor');
  assert.equal(highest.get('student-a:cursor:cursor'), 1);
});

test('exports only the high-rate live event types', () => {
  assert.deepEqual([...LIVE_EVENT_TYPES].sort(), [
    'cursor',
    'delete-preview',
    'draw',
    'object-live',
    'preview',
    'selection-transaction',
    'transform',
    'view',
  ]);
});

test('ignores frames for another board or source', () => {
  const encoded = encodeLiveEvent(base());
  assert.equal(decodeLiveEvent(encoded, {
    boardId: 'board-b',
    remoteClientId: 'student-a',
    highestSeqByStream: new Map(),
  }), null);
  assert.equal(decodeLiveEvent(encoded, {
    boardId: 'board-a',
    remoteClientId: 'student-b',
    highestSeqByStream: new Map(),
  }), null);
});

test('ignores wrong protocol without poisoning sequence state', () => {
  const highest = new Map();
  const wrong = JSON.stringify({ ...base(), protocol: 'other-live-v1' });
  assert.equal(decodeLiveEvent(wrong, {
    boardId: 'board-a',
    remoteClientId: 'student-a',
    highestSeqByStream: highest,
  }), null);
  assert.equal(highest.size, 0);
});

test('rejects malformed identity, type, sequence and revision', () => {
  assert.throws(() => encodeLiveEvent(base({ boardId: '' })), /boardId/i);
  assert.throws(() => encodeLiveEvent(base({ clientId: '' })), /clientId/i);
  assert.throws(() => encodeLiveEvent(base({ type: 'mode' })), /live event type/i);
  assert.throws(() => encodeLiveEvent(base({ seq: -1 })), /seq/i);
  assert.throws(() => encodeLiveEvent(base({ seq: 1.5 })), /seq/i);
  assert.throws(() => encodeLiveEvent(base({ baseRevision: -1 })), /revision/i);
  assert.throws(() => encodeLiveEvent(base({ streamKey: '' })), /streamKey/i);
  assert.throws(() => encodeLiveEvent(base({ payload: null })), /payload/i);
});

test('drops duplicate and stale sequence numbers per stream', () => {
  const highest = new Map();
  const options = {
    boardId: 'board-a',
    remoteClientId: 'student-a',
    highestSeqByStream: highest,
  };

  assert.equal(decodeLiveEvent(encodeLiveEvent(base({ seq: 5 })), options)?.seq, 5);
  assert.equal(decodeLiveEvent(encodeLiveEvent(base({ seq: 5 })), options), null);
  assert.equal(decodeLiveEvent(encodeLiveEvent(base({ seq: 4 })), options), null);
  assert.equal(decodeLiveEvent(encodeLiveEvent(base({ seq: 6 })), options)?.seq, 6);

  assert.equal(
    decodeLiveEvent(encodeLiveEvent(base({ type: 'view', streamKey: 'view', seq: 1 })), options)?.seq,
    1,
    'a separate stream must have its own sequence cursor',
  );
});

test('rejects encoded frames above the live frame byte limit', () => {
  const huge = base({ payload: { text: 'x'.repeat(MAX_LIVE_FRAME_BYTES * 2) } });
  assert.throws(() => encodeLiveEvent(huge), /frame.*large/i);
});

test('decode rejects malformed JSON and unknown live event types', () => {
  assert.throws(() => decodeLiveEvent('{', {
    boardId: 'board-a',
    remoteClientId: 'student-a',
    highestSeqByStream: new Map(),
  }), /json|unexpected/i);

  const unknown = JSON.stringify({
    ...base({ type: 'unknown' }),
    protocol: BOARD_LIVE_PROTOCOL,
  });
  assert.throws(() => decodeLiveEvent(unknown, {
    boardId: 'board-a',
    remoteClientId: 'student-a',
    highestSeqByStream: new Map(),
  }), /live event type/i);
});
