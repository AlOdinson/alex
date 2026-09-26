import assert from 'node:assert/strict';
import test from 'node:test';
import { createPeerLiveChannel } from '../src/lib/peerLiveChannel.js';
import { encodeLiveEvent } from '../src/lib/liveEventProtocol.js';

class FakeChannel {
  constructor() {
    this.readyState = 'open';
    this.bufferedAmount = 0;
    this.bufferedAmountLowThreshold = 0;
    this.sent = [];
    this.closed = false;
    this.listeners = new Map();
  }
  addEventListener(type, listener) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  removeEventListener(type, listener) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((item) => item !== listener));
  }
  emit(type, event = {}) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }
  send(value) { this.sent.push(value); }
  close() { this.closed = true; this.readyState = 'closed'; this.emit('close'); }
}

function createFixture(overrides = {}) {
  const channel = new FakeChannel();
  const events = [];
  const states = [];
  const errors = [];
  const live = createPeerLiveChannel({
    channel,
    boardId: 'board-a',
    localClientId: 'teacher-a',
    remoteClientId: 'student-a',
    getRevision: () => 8,
    onEvent: (type, payload, envelope) => events.push({ type, payload, envelope }),
    onState: (state) => states.push(state),
    onError: (error) => errors.push(error),
    highWaterMark: 100,
    lowWaterMark: 20,
    maxPendingStreams: 2,
    ...overrides,
  });
  return { channel, live, events, states, errors };
}

test('sends healthy live frames immediately with monotonic sequence and revision', () => {
  const { channel, live } = createFixture();
  assert.equal(live.send('cursor', { x: 1, y: 2 }, { streamKey: 'cursor' }), 'sent');
  assert.equal(live.send('cursor', { x: 3, y: 4 }, { streamKey: 'cursor' }), 'sent');
  const frames = channel.sent.map(JSON.parse);
  assert.equal(frames.length, 2);
  assert.equal(frames[0].seq, 1);
  assert.equal(frames[1].seq, 2);
  assert.equal(frames[0].baseRevision, 8);
  assert.equal(frames[0].streamKey, 'cursor');
  assert.deepEqual(live.stats(), {
    sent: 2, received: 0, coalesced: 0, dropped: 0, pending: 0,
  });
});

test('coalesces congested frames by stream key and flushes only newest frame', () => {
  const { channel, live } = createFixture();
  channel.bufferedAmount = 101;
  assert.equal(live.send('cursor', { x: 1 }, { streamKey: 'cursor' }), 'coalesced');
  assert.equal(live.send('cursor', { x: 2 }, { streamKey: 'cursor' }), 'coalesced');
  assert.equal(channel.sent.length, 0);
  assert.equal(live.stats().pending, 1);
  assert.equal(live.stats().coalesced, 1);

  channel.bufferedAmount = 0;
  channel.emit('bufferedamountlow');
  assert.equal(channel.sent.length, 1);
  assert.deepEqual(JSON.parse(channel.sent[0]).payload, { x: 2 });
  assert.equal(live.stats().pending, 0);
});

test('bounds pending streams and drops the oldest pending stream under pressure', () => {
  const { channel, live } = createFixture();
  channel.bufferedAmount = 101;
  live.send('cursor', { x: 1 }, { streamKey: 'cursor' });
  live.send('view', { zoom: 1 }, { streamKey: 'view' });
  live.send('transform', { objectId: 'c' }, { streamKey: 'transform:c' });
  assert.equal(live.stats().pending, 2);
  assert.equal(live.stats().dropped, 1);

  channel.bufferedAmount = 0;
  channel.emit('bufferedamountlow');
  const keys = channel.sent.map((value) => JSON.parse(value).streamKey);
  assert.deepEqual(keys.sort(), ['transform:c', 'view']);
});

test('receives valid remote frames and drops stale reordered frames', () => {
  const { channel, events, live } = createFixture();
  const outbound = encodeLiveEvent({
    type: 'cursor', boardId: 'board-a', clientId: 'student-a', seq: 5, baseRevision: 8,
    timestamp: 1, streamKey: 'cursor', payload: { x: 10 },
  });
  const stale = encodeLiveEvent({
    type: 'cursor', boardId: 'board-a', clientId: 'student-a', seq: 4, baseRevision: 8,
    timestamp: 2, streamKey: 'cursor', payload: { x: 3 },
  });
  channel.emit('message', { data: outbound });
  channel.emit('message', { data: stale });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'cursor');
  assert.deepEqual(events[0].payload, { x: 10 });
  assert.equal(live.stats().received, 1);
});

test('live channel close reports its own state without touching any durable resource', () => {
  let durableClosed = 0;
  const { channel, live, states } = createFixture();
  const durable = { close() { durableClosed += 1; } };
  void durable;
  channel.close();
  assert.equal(durableClosed, 0);
  assert.equal(states.at(-1), 'closed');
  assert.equal(live.send('cursor', { x: 1 }, { streamKey: 'cursor' }), 'closed');
});
