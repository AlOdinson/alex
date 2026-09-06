import assert from 'node:assert/strict';
import {
  createCloudflarePublisher,
  createCloudflareScreenShareApi,
  createCloudflareSubscriber,
} from '../src/lib/cloudflareScreenShare.js';

class FakePublisherPeer {
  static instances = [];

  constructor(configuration) {
    this.configuration = configuration;
    this.iceGatheringState = 'complete';
    this.connectionState = 'new';
    this.localDescription = null;
    this.remoteDescription = null;
    this.closed = false;
    this.sender = { kind: 'sender' };
    this.transceiver = null;
    FakePublisherPeer.instances.push(this);
  }

  addTransceiver(track, options) {
    this.transceiver = {
      track,
      options,
      mid: null,
      sender: this.sender,
    };
    return this.transceiver;
  }

  async createOffer() {
    return { type: 'offer', sdp: 'publisher-offer-before-ice' };
  }

  async setLocalDescription(description) {
    this.localDescription = { ...description, sdp: 'publisher-offer-with-ice' };
    if (this.transceiver) this.transceiver.mid = '0';
  }

  async setRemoteDescription(description) {
    this.remoteDescription = description;
  }

  addEventListener() {}
  removeEventListener() {}

  close() {
    this.closed = true;
  }
}

class FakeSubscriberPeer {
  static instances = [];

  constructor(configuration) {
    this.configuration = configuration;
    this.iceGatheringState = 'complete';
    this.localDescription = null;
    this.remoteDescription = null;
    this.closed = false;
    this.ontrack = null;
    FakeSubscriberPeer.instances.push(this);
  }

  async setRemoteDescription(description) {
    this.remoteDescription = description;
  }

  async createAnswer() {
    return { type: 'answer', sdp: 'viewer-answer-before-ice' };
  }

  async setLocalDescription(description) {
    this.localDescription = { ...description, sdp: 'viewer-answer-with-ice' };
    queueMicrotask(() => {
      this.ontrack?.({
        track: { kind: 'video', id: 'cloud-video' },
        streams: [{ id: 'cloud-stream', getVideoTracks: () => [{ kind: 'video' }] }],
      });
    });
  }

  addEventListener() {}
  removeEventListener() {}

  close() {
    this.closed = true;
  }
}

const captureTrack = { kind: 'video', id: 'capture-track' };
const publisherCalls = [];
const publisherApi = {
  async createPublisherSession() {
    publisherCalls.push('createPublisherSession');
    return { sessionId: 'publisher_123456', sessionLease: 'publisher.lease' };
  },
  async publishTrack(details) {
    publisherCalls.push(['publishTrack', details]);
    return {
      sessionDescription: { type: 'answer', sdp: 'cloudflare-answer' },
      tracks: [{ mid: '0', trackName: 'screen:boardABC:sessionXYZ' }],
    };
  },
  async closeTrack(details) {
    publisherCalls.push(['closeTrack', details]);
    return {};
  },
};

const publisher = await createCloudflarePublisher({
  track: captureTrack,
  trackName: 'screen:boardABC:sessionXYZ',
  api: publisherApi,
  RTCPeerConnectionImpl: FakePublisherPeer,
});

const publisherPeer = FakePublisherPeer.instances.at(-1);
assert.equal(publisherPeer.transceiver.track, captureTrack, 'Cloud publisher reuses the exact capture track');
assert.deepEqual(publisherPeer.transceiver.options, { direction: 'sendonly' });
assert.deepEqual(publisherCalls.slice(0, 2).map((entry) => Array.isArray(entry) ? entry[0] : entry), [
  'createPublisherSession',
  'publishTrack',
]);
assert.equal(publisherCalls[1][1].sdp, 'publisher-offer-with-ice', 'publisher sends gathered local SDP');
assert.equal(publisherCalls[1][1].mid, '0');
assert.deepEqual(publisherPeer.remoteDescription, { type: 'answer', sdp: 'cloudflare-answer' });
assert.equal(publisher.sender, publisherPeer.sender);
assert.equal(publisher.sessionId, 'publisher_123456');
assert.equal(publisher.sessionLease, 'publisher.lease');
assert.deepEqual(publisherPeer.configuration, {
  iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }],
  bundlePolicy: 'max-bundle',
});

await publisher.close();
await publisher.close();
assert.equal(publisherPeer.closed, true);
assert.equal(
  publisherCalls.filter((entry) => Array.isArray(entry) && entry[0] === 'closeTrack').length,
  1,
  'publisher teardown is idempotent',
);

const subscriberCalls = [];
const subscriberApi = {
  async createViewerSession() {
    subscriberCalls.push('createViewerSession');
    return { sessionId: 'viewer_123456', sessionLease: 'viewer.lease' };
  },
  async subscribeTrack(details) {
    subscriberCalls.push(['subscribeTrack', details]);
    return {
      requiresImmediateRenegotiation: true,
      sessionDescription: { type: 'offer', sdp: 'cloudflare-viewer-offer' },
      tracks: [{ mid: '7', trackName: 'screen:boardABC:sessionXYZ' }],
    };
  },
  async renegotiateViewer(details) {
    subscriberCalls.push(['renegotiateViewer', details]);
    return {};
  },
  async closeTrack(details) {
    subscriberCalls.push(['closeTrack', details]);
    return {};
  },
};

const subscriber = await createCloudflareSubscriber({
  publisherSessionId: 'publisher_123456',
  trackName: 'screen:boardABC:sessionXYZ',
  api: subscriberApi,
  RTCPeerConnectionImpl: FakeSubscriberPeer,
});

const subscriberPeer = FakeSubscriberPeer.instances.at(-1);
assert.deepEqual(
  subscriberCalls.slice(0, 3).map((entry) => Array.isArray(entry) ? entry[0] : entry),
  ['createViewerSession', 'subscribeTrack', 'renegotiateViewer'],
);
assert.equal(subscriberCalls[1][1].publisherSessionId, 'publisher_123456');
assert.equal(subscriberCalls[2][1].sdp, 'viewer-answer-with-ice');
assert.deepEqual(subscriberPeer.remoteDescription, { type: 'offer', sdp: 'cloudflare-viewer-offer' });
assert.equal(subscriber.stream.id, 'cloud-stream');
assert.equal(subscriber.mid, '7');
assert.equal(subscriber.sessionLease, 'viewer.lease');

await subscriber.close();
assert.equal(subscriberPeer.closed, true);
assert.equal(
  subscriberCalls.filter((entry) => Array.isArray(entry) && entry[0] === 'closeTrack').length,
  1,
);

const invokeCalls = [];
const supabase = {
  functions: {
    async invoke(name, request) {
      invokeCalls.push({ name, request });
      return { data: { ok: true }, error: null };
    },
  },
};
const api = createCloudflareScreenShareApi({
  supabase,
  boardId: 'boardABC',
  boardKey: 'ABCDEFGHIJKLMNOPQRSTUVWX',
  screenShareSessionId: 'sessionXYZ',
});
await api.renegotiateViewer({
  sessionId: 'viewer_123456',
  sessionLease: 'viewer.lease',
  sdp: 'answer-sdp',
});
assert.equal(invokeCalls[0].name, 'cloudflare-realtime');
assert.deepEqual(invokeCalls[0].request.body, {
  boardId: 'boardABC',
  boardKey: 'ABCDEFGHIJKLMNOPQRSTUVWX',
  screenShareSessionId: 'sessionXYZ',
  operation: 'renegotiate-viewer',
  sessionId: 'viewer_123456',
  sessionLease: 'viewer.lease',
  sdp: 'answer-sdp',
});

console.log('Cloudflare screen-share transport tests passed');
