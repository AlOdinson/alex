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

test('initiator creates an ordered durable channel and sends an offer', async () => {
  const signals = [];
  const channels = [];
  const pc = new FakePeerConnection();
  const peer = createBrowserPeerConnection({
    initiator: true,
    sendSignal: async (signal) => signals.push(signal),
    onChannel: (channel) => channels.push(channel),
    createPeerConnection: () => pc,
  });
  await peer.start();
  assert.equal(pc.createdChannels.length, 1);
  assert.equal(pc.createdChannels[0].label, 'alex-board-durable-v1');
  assert.equal(pc.createdChannels[0].options.ordered, true);
  assert.equal(channels[0], pc.createdChannels[0]);
  assert.deepEqual(signals, [{ type: 'offer', description: { type: 'offer', sdp: 'offer-sdp' } }]);
});

test('responder answers an offer and accepts the remote durable channel', async () => {
  const signals = [];
  const channels = [];
  const pc = new FakePeerConnection();
  const peer = createBrowserPeerConnection({
    initiator: false,
    sendSignal: async (signal) => signals.push(signal),
    onChannel: (channel) => channels.push(channel),
    createPeerConnection: () => pc,
  });
  await peer.handleSignal({ type: 'offer', description: { type: 'offer', sdp: 'remote-offer' } });
  const incoming = new FakeDataChannel('alex-board-durable-v1');
  pc.emitDataChannel(incoming);
  assert.deepEqual(pc.remoteDescription, { type: 'offer', sdp: 'remote-offer' });
  assert.deepEqual(signals, [{ type: 'answer', description: { type: 'answer', sdp: 'answer-sdp' } }]);
  assert.equal(channels[0], incoming);
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

test('forwards local ICE candidates through signaling and closes cleanly', async () => {
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
  assert.equal(pc.createdChannels[0].closed, true);
});
