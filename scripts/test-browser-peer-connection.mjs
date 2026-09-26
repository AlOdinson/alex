import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserPeerConnection } from '../src/lib/browserPeerConnection.js';

class FakeDataChannel {
  constructor(label) {
    this.label = label;
    this.readyState = 'open';
    this.closed = false;
  }
  close() { this.closed = true; this.readyState = 'closed'; }
}

class FakePeerConnection {
  constructor() {
    this.localDescription = null;
    this.remoteDescription = null;
    this.addedCandidates = [];
    this.createdChannels = [];
    this.closed = false;
    this.onicecandidate = null;
    this.ondatachannel = null;
  }
  createDataChannel(label, options) {
    const channel = new FakeDataChannel(label);
    channel.options = options;
    this.createdChannels.push(channel);
    return channel;
  }
  async createOffer() { return { type: 'offer', sdp: 'offer-sdp' }; }
  async createAnswer() { return { type: 'answer', sdp: 'answer-sdp' }; }
  async setLocalDescription(description) { this.localDescription = description; }
  async setRemoteDescription(description) { this.remoteDescription = description; }
  async addIceCandidate(candidate) { this.addedCandidates.push(candidate); }
  close() { this.closed = true; }
  emitDataChannel(channel) { this.ondatachannel?.({ channel }); }
  emitIce(candidate) { this.onicecandidate?.({ candidate }); }
}

test('uses the public Cloudflare STUN server when no ICE servers are configured', () => {
  let receivedConfig = null;
  createBrowserPeerConnection({
    sendSignal: async () => {},
    createPeerConnection: (config) => {
      receivedConfig = config;
      return new FakePeerConnection();
    },
  });
  assert.deepEqual(receivedConfig?.iceServers, [
    { urls: ['stun:stun.cloudflare.com:3478'] },
  ]);
});

test('keeps an explicit ICE server configuration instead of injecting the default STUN server', () => {
  let receivedConfig = null;
  const rtcConfig = {
    iceServers: [{ urls: ['stun:custom.example.test:3478'] }],
    iceCandidatePoolSize: 2,
  };
  createBrowserPeerConnection({
    rtcConfig,
    sendSignal: async () => {},
    createPeerConnection: (config) => {
      receivedConfig = config;
      return new FakePeerConnection();
    },
  });
  assert.deepEqual(receivedConfig, rtcConfig);
});

test('initiator creates durable and independent lossy live channels before sending the offer', async () => {
  const signals = [];
  const durableChannels = [];
  const liveChannels = [];
  const pc = new FakePeerConnection();
  const peer = createBrowserPeerConnection({
    initiator: true,
    sendSignal: async (signal) => signals.push(signal),
    onChannel: (channel) => durableChannels.push(channel),
    onLiveChannel: (channel) => liveChannels.push(channel),
    createPeerConnection: () => pc,
  });
  await peer.start();
  assert.equal(pc.createdChannels.length, 2);
  assert.equal(pc.createdChannels[0].label, 'alex-board-durable-v1');
  assert.equal(pc.createdChannels[0].options.ordered, true);
  assert.equal(pc.createdChannels[1].label, 'alex-board-live-v1');
  assert.equal(pc.createdChannels[1].options.ordered, false);
  assert.equal(pc.createdChannels[1].options.maxRetransmits, 0);
  assert.equal(durableChannels[0], pc.createdChannels[0]);
  assert.equal(liveChannels[0], pc.createdChannels[1]);
  assert.deepEqual(signals, [{ type: 'offer', description: { type: 'offer', sdp: 'offer-sdp' } }]);
});

test('responder answers an offer and routes durable and live channels independently', async () => {
  const signals = [];
  const durableChannels = [];
  const liveChannels = [];
  const pc = new FakePeerConnection();
  const peer = createBrowserPeerConnection({
    initiator: false,
    sendSignal: async (signal) => signals.push(signal),
    onChannel: (channel) => durableChannels.push(channel),
    onLiveChannel: (channel) => liveChannels.push(channel),
    createPeerConnection: () => pc,
  });
  await peer.handleSignal({ type: 'offer', description: { type: 'offer', sdp: 'remote-offer' } });
  const durable = new FakeDataChannel('alex-board-durable-v1');
  const live = new FakeDataChannel('alex-board-live-v1');
  const unknown = new FakeDataChannel('not-alex-board');
  pc.emitDataChannel(durable);
  pc.emitDataChannel(live);
  pc.emitDataChannel(unknown);
  assert.deepEqual(pc.remoteDescription, { type: 'offer', sdp: 'remote-offer' });
  assert.deepEqual(signals, [{ type: 'answer', description: { type: 'answer', sdp: 'answer-sdp' } }]);
  assert.deepEqual(durableChannels, [durable]);
  assert.deepEqual(liveChannels, [live]);
  assert.equal(unknown.closed, true, 'unknown peer data channels must be rejected');
});

test('closing only the live channel does not close durable channel or peer connection', async () => {
  const pc = new FakePeerConnection();
  const peer = createBrowserPeerConnection({
    initiator: true,
    sendSignal: async () => {},
    createPeerConnection: () => pc,
  });
  await peer.start();
  const durable = pc.createdChannels.find((channel) => channel.label === 'alex-board-durable-v1');
  const live = pc.createdChannels.find((channel) => channel.label === 'alex-board-live-v1');
  live.close();
  assert.equal(durable.closed, false);
  assert.equal(pc.closed, false);
});

test('buffers ICE candidates received before the remote description', async () => {
  const pc = new FakePeerConnection();
  const peer = createBrowserPeerConnection({
    initiator: false,
    sendSignal: async () => {},
    createPeerConnection: () => pc,
  });
  await peer.handleSignal({ type: 'ice', candidate: { candidate: 'early' } });
  assert.deepEqual(pc.addedCandidates, []);
  await peer.handleSignal({ type: 'offer', description: { type: 'offer', sdp: 'remote-offer' } });
  assert.deepEqual(pc.addedCandidates, [{ candidate: 'early' }]);
});

test('forwards local ICE candidates through signaling and closes both channels cleanly', async () => {
  const signals = [];
  const pc = new FakePeerConnection();
  const peer = createBrowserPeerConnection({
    initiator: true,
    sendSignal: async (signal) => signals.push(signal),
    createPeerConnection: () => pc,
  });
  await peer.start();
  pc.emitIce({ candidate: 'local' });
  await Promise.resolve();
  assert.deepEqual(signals.at(-1), { type: 'ice', candidate: { candidate: 'local' } });
  peer.close();
  assert.equal(pc.closed, true);
  assert.ok(pc.createdChannels.every((channel) => channel.closed));
});
