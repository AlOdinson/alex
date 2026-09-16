import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { normalizeScreenShareSignal, normalizeCloudScreenShareRoute, screenSharePermissionCanHost, screenShareCloudTrackName, SCREEN_SHARE_PROTOCOL } from '../src/lib/screenShare.js';

const source = readFileSync(new URL('../src/components/useCloudScreenShareFallback.js', import.meta.url), 'utf8');
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function fixture() {
  const pending = [], streams = [], messages = [];
  let state = { transport: 'p2p', cloudPhase: 'off' };
  const deps = {
    normalizeScreenShareSignal, normalizeCloudScreenShareRoute, screenSharePermissionCanHost,
    CLOUD_SIGNAL_TYPES: new Set(['cloud-track', 'cloud-disable', 'cloud-viewer-ready']),
    clientId: 'viewer', authorizationRef: { current: null },
    sessionContextRef: { current: { boardId: 'board-local', sessionId: 'screen-local', hostId: 'teacher', role: 'viewer', sourceMode: 'screen' } },
    subscriberRef: { current: null }, subscriberAttemptRef: { current: null }, mountedRef: { current: true },
    clearCloudSubscriber: null, patchCloudState: (patch) => { state = { ...state, ...patch }; },
    setCloudStream: (stream) => streams.push(stream), sendCloudSignal: async (...args) => { messages.push(args); },
    cloudApi: () => ({}), cloudErrorMessage: (error) => error.message,
    defaultCloudState: () => ({ transport: 'p2p', cloudPhase: 'off', cloudError: '' }),
    createCloudflareSubscriber: (options) => new Promise((resolve, reject) => {
      const item = { ...options, closed: 0, resolve, reject, stream: { id: options.publisherSessionId } };
      item.subscriber = { ...options, stream: item.stream, close: async () => { item.closed++; } };
      pending.push(item);
    }),
  };
  const clearBody = source.split('  const clearCloudSubscriber = useCallback(() => {')[1].split('\n  }, []);')[0];
  deps.clearCloudSubscriber = () => new Function(...Object.keys(deps), clearBody)(...Object.values(deps));
  const handleBody = source.split('  processSignalRef.current = async (rawPayload) => {')[1].split('\n  };')[0];
  const handle = new Function('rawPayload', ...Object.keys(deps), `return (async () => {${handleBody}\n})();`);
  return {
    pending, streams, messages, deps, state: () => state,
    send: (type, publisher = 'publisher-one') => handle({ protocol: SCREEN_SHARE_PROTOCOL, type,
      sessionId: 'screen-local', clientId: 'teacher', permission: 'owner', publisherSessionId: publisher,
      trackName: screenShareCloudTrackName('board-local', 'screen-local'), timestamp: Date.now() }, ...Object.values(deps)),
  };
}

test('repeated Cloud announcements share one in-flight subscription instead of leaking peers', async () => {
  const f = fixture();
  const first = f.send('cloud-track'); await flush();
  const duplicate = f.send('cloud-track'); await flush();
  const count = f.pending.length;
  f.pending.forEach((p) => p.resolve(p.subscriber)); await Promise.all([first, duplicate]);
  assert.equal(count, 1);
});

test('Cloud disable invalidates an in-flight subscription so late completion cannot restore frozen Cloud', async () => {
  const f = fixture();
  const first = f.send('cloud-track'); await flush();
  await f.send('cloud-disable');
  f.pending[0].resolve(f.pending[0].subscriber); await first;
  assert.equal(f.state().transport, 'p2p'); assert.equal(f.state().cloudPhase, 'off');
  assert.equal(f.deps.subscriberRef.current, null); assert.equal(f.pending[0].closed, 1);
  assert.ok(!f.streams.includes(f.pending[0].stream));
});

test('a superseded Cloud subscription cannot overwrite the newer route or close its stream', async () => {
  const f = fixture();
  const old = f.send('cloud-track'); await flush();
  const next = f.send('cloud-track', 'publisher-two'); await flush();
  f.pending[1].resolve(f.pending[1].subscriber); await next;
  f.pending[0].resolve(f.pending[0].subscriber); await old;
  assert.equal(f.deps.subscriberRef.current, f.pending[1].subscriber);
  assert.equal(f.pending[0].closed, 1); assert.equal(f.pending[1].closed, 0);
  assert.equal(f.streams.at(-1), f.pending[1].stream);
});

test('a late failure of an old Cloud attempt does not tear down the current route', async () => {
  const f = fixture();
  const old = f.send('cloud-track'); await flush();
  const next = f.send('cloud-track', 'publisher-two'); await flush();
  f.pending[1].resolve(f.pending[1].subscriber); await next;
  f.pending[0].reject(new Error('obsolete subscription failed')); await old;
  assert.equal(f.deps.subscriberRef.current, f.pending[1].subscriber);
  assert.equal(f.pending[1].closed, 0); assert.equal(f.state().transport, 'cloud');
});

test('Cloud disabled state is immediate even when closing its server track is pending', async () => {
  const f = fixture();
  const first = f.send('cloud-track'); await flush();
  f.pending[0].resolve(f.pending[0].subscriber); await first;
  let closed;
  f.pending[0].subscriber.close = () => new Promise((resolve) => { closed = resolve; });
  const disabling = f.send('cloud-disable'); await flush();
  const state = f.state(); closed(); await disabling;
  assert.equal(state.transport, 'p2p'); assert.equal(state.cloudPhase, 'off');
  assert.equal(f.streams.at(-1), null);
});
