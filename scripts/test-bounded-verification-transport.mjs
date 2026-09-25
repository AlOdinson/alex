import assert from 'node:assert/strict';
import test from 'node:test';
import { createPeerDataChannelTransport } from '../src/lib/peerDataChannel.js';
import { createPeerMessage, peerFrameByteLength, MAX_PEER_FRAME_BYTES } from '../src/lib/peerProtocol.js';
class Channel extends EventTarget {
  readyState = 'open'; bufferedAmount = 0; sent = [];
  send(frame) { this.sent.push(frame); this.onSend?.(JSON.parse(frame)); }
}
test('large verification reply allows action acknowledgement between frames', async () => {
  const channel = new Channel(); const transport = createPeerDataChannelTransport({ channel });
  let inserted = false; let ack;
  channel.onSend = (frame) => {
    if (frame.type === 'transfer-chunk' && !inserted) {
      inserted = true; ack = transport.send('ack', { actionId: 'undo1', revision: 2 });
    }
  };
  const encoded = createPeerMessage('head', { revision: 1, verification: { data: '🙂'.repeat(15000) } });
  await transport.sendLowPriorityEncoded(encoded); await ack;
  const types = channel.sent.map((s) => JSON.parse(s).type);
  assert.ok(types.indexOf('ack') > types.indexOf('transfer-chunk'));
  assert.ok(types.indexOf('ack') < types.indexOf('transfer-end'));
  assert.ok(channel.sent.every((f) => peerFrameByteLength(f) <= MAX_PEER_FRAME_BYTES));
  const receiver = new Channel(); const messages = [];
  const receiving = createPeerDataChannelTransport({ channel: receiver, onMessage: (m) => messages.push(m) });
  for (const data of channel.sent) receiver.dispatchEvent(new MessageEvent('message', { data }));
  assert.equal(messages.length, 2);
  assert.equal(messages.find((m) => m.type === 'head').payload.verification.data, '🙂'.repeat(15000));
  transport.close(); receiving.close();
});
test('small low-priority checks remain one bounded frame', async () => {
  const channel = new Channel(); const transport = createPeerDataChannelTransport({ channel });
  await transport.sendLowPriorityEncoded(createPeerMessage('head', { revision: 1 }));
  assert.equal(channel.sent.length, 1); transport.close();
});
