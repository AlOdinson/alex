import assert from 'node:assert/strict';
import test from 'node:test';
import { createPeerDataChannelTransport } from '../src/lib/peerDataChannel.js';
import { createPeerMessage, splitPeerTextTransfer } from '../src/lib/peerProtocol.js';

class FakeChannel {
  constructor() {
    this.readyState = 'open';
    this.bufferedAmount = 0;
    this.bufferedAmountLowThreshold = 0;
    this.sent = [];
    this.listeners = new Map();
  }
  addEventListener(type, listener, options = {}) {
    const list = this.listeners.get(type) ?? [];
    list.push({ listener, once: Boolean(options.once) });
    this.listeners.set(type, list);
  }
  removeEventListener(type, listener) {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(type, list.filter((item) => item.listener !== listener));
  }
  emit(type, event = {}) {
    const list = [...(this.listeners.get(type) ?? [])];
    for (const item of list) {
      item.listener(event);
      if (item.once) this.removeEventListener(type, item.listener);
    }
  }
  send(value) { this.sent.push(value); }
}

test('sends and receives ordinary protocol messages', async () => {
  const channel = new FakeChannel();
  const received = [];
  const transport = createPeerDataChannelTransport({ channel, onMessage: (message) => received.push(message) });
  await transport.send('head', { revision: 12 });
  assert.equal(JSON.parse(channel.sent[0]).type, 'head');
  channel.emit('message', { data: createPeerMessage('ack', { actionId: 'a1', revision: 12 }) });
  assert.equal(received[0].type, 'ack');
  assert.equal(received[0].payload.revision, 12);
});

test('reassembles incoming snapshot transfer frames', () => {
  const channel = new FakeChannel();
  const transfers = [];
  createPeerDataChannelTransport({ channel, onTransfer: (transfer) => transfers.push(transfer) });
  const frames = splitPeerTextTransfer('snapshot', '{"hello":"world"}', { chunkChars: 5, transferId: 'snap-1' });
  for (const frame of frames) channel.emit('message', { data: JSON.stringify(frame) });
  assert.deepEqual(transfers, [{ transferId: 'snap-1', kind: 'snapshot', text: '{"hello":"world"}' }]);
});

test('sends large text transfers as multiple bounded frames', async () => {
  const channel = new FakeChannel();
  const transport = createPeerDataChannelTransport({ channel });
  await transport.sendTextTransfer('snapshot', 'x'.repeat(100), { transferId: 'snap-2', chunkChars: 16 });
  const decoded = channel.sent.map((value) => JSON.parse(value));
  assert.equal(decoded[0].type, 'transfer-start');
  assert.equal(decoded.at(-1).type, 'transfer-end');
  assert.ok(decoded.filter((frame) => frame.type === 'transfer-chunk').every((frame) => frame.payload.chunk.length <= 16));
});

test('waits for bufferedamountlow before sending more data', async () => {
  const channel = new FakeChannel();
  channel.bufferedAmount = 900_000;
  const transport = createPeerDataChannelTransport({ channel, highWaterMark: 512_000, lowWaterMark: 128_000 });
  let completed = false;
  const sending = transport.send('head', { revision: 1 }).then(() => { completed = true; });
  await Promise.resolve();
  assert.equal(completed, false);
  assert.equal(channel.sent.length, 0);
  channel.bufferedAmount = 100_000;
  channel.emit('bufferedamountlow');
  await sending;
  assert.equal(completed, true);
  assert.equal(channel.sent.length, 1);
});
