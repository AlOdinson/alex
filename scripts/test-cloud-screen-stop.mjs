import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../src/components/ScreenShare.jsx', import.meta.url), 'utf8');
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function stopFixture(sendSignal) {
  const session = { sessionId: 'old-screen', hostId: 'teacher' };
  const capture = { id: 'old-capture' };
  const state = { peersClosed: 0, stopped: [], stream: capture, view: { sessionId: 'old-screen' } };
  const values = {
    activeSessionRef: { current: session }, localStreamRef: { current: capture }, clientId: 'teacher', sendSignal,
    clearHostPeers: () => { state.peersClosed++; }, stopStream: (stream) => state.stopped.push(stream),
    networkDegradedRef: { current: true }, currentProfileRef: { current: {} }, SCREEN_SHARE_PROFILES: { idle: {} },
    mountedRef: { current: true }, setStream: (stream) => { state.stream = stream; }, setMinimized() {},
    setView: (view) => { state.view = view; },
  };
  const body = source.split("  const stopHosting = useCallback(async (reason = 'user', announce = true) => {")[1].split('\n  }, [')[0];
  const invoke = new Function('reason', 'announce', ...Object.keys(values), `return (async () => {${body}\n})();`);
  return { state, values, session, capture, stop: (announce = true) => invoke('user', announce, ...Object.values(values)) };
}

test('stopping Cloud screen share releases capture and UI without waiting for a signaling receipt', async () => {
  const f = stopFixture(() => new Promise(() => {}));
  let settled = false; f.stop().then(() => { settled = true; });
  await flush();
  assert.equal(settled, true, 'stop must not await a disconnected signaling channel');
  assert.equal(f.values.activeSessionRef.current, null);
  assert.equal(f.values.localStreamRef.current, null);
  assert.deepEqual(f.state.stopped, [f.capture]);
  assert.equal(f.state.view.sessionId, ''); assert.equal(f.state.stream, null);
});
test('late stop receipt cannot clear a replacement screen session', async () => {
  let acknowledge;
  const f = stopFixture(() => new Promise((resolve) => { acknowledge = resolve; }));
  const stopping = f.stop(); await flush();
  const next = { sessionId: 'new-screen', hostId: 'teacher' }, capture = { id: 'new-capture' };
  f.values.activeSessionRef.current = next; f.values.localStreamRef.current = capture;
  acknowledge(); await stopping; await flush();
  assert.equal(f.values.activeSessionRef.current, next);
  assert.equal(f.values.localStreamRef.current, capture);
  assert.ok(!f.state.stopped.includes(capture));
});
test('rejected stop announcement cannot keep capture alive or reject local cleanup', async () => {
  const f = stopFixture(async () => { throw new Error('Signaling disconnected'); });
  await f.stop(); await flush();
  assert.deepEqual(f.state.stopped, [f.capture]); assert.equal(f.state.view.sessionId, '');
});
test('a viewer cannot stop someone else’s local capture', async () => {
  const f = stopFixture(() => assert.fail('viewer cannot announce host stop'));
  f.values.activeSessionRef.current.hostId = 'someone-else';
  await f.stop(); assert.equal(f.state.peersClosed, 0); assert.deepEqual(f.state.stopped, []);
});
function signalFixture(direct) {
  const messages = [];
  const values = {
    activeSessionRef: { current: { sessionId: 'screen-1' } }, SCREEN_SHARE_PROTOCOL: 'test-protocol',
    directSignalChannelRef: { current: direct }, clientId: 'teacher', participantName: 'Teacher', isOwner: true, canEdit: true,
    realtimeRef: { current: { sendScreenShareSignal: async (payload) => { messages.push(payload); return 'ok'; } } },
  };
  const body = source.split('  const sendSignal = useCallback((type, details = {}, explicitSession = null) => {')[1].split('\n  }, [')[0];
  const invoke = new Function('type', 'details', 'explicitSession', ...Object.keys(values), body);
  return { messages, send: (type) => invoke(type, { reason: 'user' }, { sessionId: 'screen-1' }, ...Object.values(values)) };
}
for (const phase of ['ready', 'send']) test(`host-stop also reaches Ably when direct signaling ${phase} stalls`, async () => {
  const direct = { ready: phase === 'ready' ? new Promise(() => {}) : Promise.resolve(), channel: { send: () => new Promise(() => {}) } };
  const f = signalFixture(direct); f.send('host-stop'); await flush();
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0].type, 'host-stop'); assert.equal(f.messages[0].sessionId, 'screen-1');
});
test('ordinary screen signals still use only their existing preferred channel', async () => {
  let sends = 0;
  const f = signalFixture({ ready: Promise.resolve(), channel: { send: async () => { sends++; return 'ok'; } } });
  await f.send('host-start'); assert.equal(sends, 1); assert.equal(f.messages.length, 0);
});
