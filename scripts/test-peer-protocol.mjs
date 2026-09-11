import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BOARD_PEER_PROTOCOL_VERSION,
  createPeerMessage,
  decodePeerMessage,
  splitPeerTextTransfer,
  createPeerTextAssembler,
} from '../src/lib/peerProtocol.js';

test('encodes and decodes a versioned action proposal', () => {
  const encoded = createPeerMessage('action-proposal', {
    actionId: 'action-a',
    baseRevision: 4,
    ops: [{ type: 'delete', id: 'object-a' }],
  });
  const decoded = decodePeerMessage(encoded);
  assert.equal(decoded.v, BOARD_PEER_PROTOCOL_VERSION);
  assert.equal(decoded.type, 'action-proposal');
  assert.equal(decoded.payload.actionId, 'action-a');
});

test('rejects unsupported protocol versions and unknown message types', () => {
  assert.throws(
    () => decodePeerMessage(JSON.stringify({ v: 999, type: 'head', payload: {} })),
    /protocol version/i,
  );
  assert.throws(
    () => createPeerMessage('mystery-message', {}),
    /message type/i,
  );
});

test('splits a large snapshot into bounded text chunks and reassembles it', () => {
  const snapshot = JSON.stringify({
    version: 2,
    canvas: { objects: Array.from({ length: 250 }, (_, index) => ({ id: index, text: 'x'.repeat(64) })) },
  });
  const frames = splitPeerTextTransfer('snapshot', snapshot, { chunkChars: 1024, transferId: 'transfer-a' });
  assert.ok(frames.length > 3);
  assert.equal(frames[0].type, 'transfer-start');
  assert.equal(frames.at(-1).type, 'transfer-end');
  for (const frame of frames.filter((item) => item.type === 'transfer-chunk')) {
    assert.ok(frame.payload.chunk.length <= 1024);
  }

  const assembler = createPeerTextAssembler();
  let result = null;
  for (const frame of frames) result = assembler.accept(frame) ?? result;
  assert.deepEqual(result, { transferId: 'transfer-a', kind: 'snapshot', text: snapshot });
});

test('does not complete a transfer with a missing chunk', () => {
  const frames = splitPeerTextTransfer('snapshot', 'abcdefghijklmno', {
    chunkChars: 4,
    transferId: 'transfer-b',
  });
  const assembler = createPeerTextAssembler();
  const withoutOneChunk = frames.filter((frame) => !(frame.type === 'transfer-chunk' && frame.payload.index === 1));
  const results = withoutOneChunk.map((frame) => assembler.accept(frame)).filter(Boolean);
  assert.deepEqual(results, []);
});
