import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserAuthorityRealtimeCore } from '../src/lib/browserAuthorityRealtimeCore.js';

test('durable send waits for teacher authority, reports pending state, and calls Board onCommit after ack', async () => {
  const events = [];
  let readyResolve;
  const ready = new Promise((resolve) => { readyResolve = resolve; });
  const session = {
    whenRuntimeReady: () => ready,
    async sendOps(ops, options) {
      events.push(['session-send', ops, options.actionId]);
      return {
        actionId: options.actionId,
        revision: 4,
        accepted: true,
        changed: true,
        appliedOps: ops,
        appliedBackground: null,
        rejectedObjectIds: [],
        skippedConflicts: [],
      };
    },
  };
  const core = createBrowserAuthorityRealtimeCore({
    session,
    clientId: 'student-a',
    name: 'Student',
    permission: 'edit',
    getKnownRevision: () => 3,
    createActionId: () => 'action-1',
    publish: async () => 'ok',
    onPendingChange: (count) => events.push(['pending', count]),
    onCommit: (result, action) => events.push(['commit', result.revision, action.actionId]),
  });

  let settled = false;
  const task = core.sendOps([{ type: 'delete', id: 'x' }]).then((value) => {
    settled = true;
    return value;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.deepEqual(events[0], ['pending', 1]);

  readyResolve({});
  const result = await task;
  assert.equal(result.revision, 4);
  assert.deepEqual(events, [
    ['pending', 1],
    ['session-send', [{ type: 'delete', id: 'x' }], 'action-1'],
    ['commit', 4, 'action-1'],
    ['pending', 0],
  ]);
});

test('durable writes are serialized and pause/resume prevents later writes from overtaking recovery', async () => {
  const order = [];
  let firstResolve;
  const firstGate = new Promise((resolve) => { firstResolve = resolve; });
  const session = {
    whenRuntimeReady: async () => ({}),
    async sendOps(_ops, { actionId }) {
      order.push(`start:${actionId}`);
      if (actionId === 'a1') await firstGate;
      order.push(`finish:${actionId}`);
      return { actionId, revision: actionId === 'a1' ? 1 : 2, accepted: true, changed: true, appliedOps: [] };
    },
  };
  const ids = ['a1', 'a2'];
  const core = createBrowserAuthorityRealtimeCore({
    session,
    clientId: 'teacher-a',
    createActionId: () => ids.shift(),
    publish: async () => 'ok',
  });

  const first = core.sendOps([{ type: 'delete', id: 'x' }]);
  const second = core.sendOps([{ type: 'delete', id: 'y' }]);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(order, ['start:a1']);
  core.pauseWrites();
  firstResolve();
  await first;
  await Promise.resolve();
  assert.deepEqual(order, ['start:a1', 'finish:a1']);
  core.resumeWrites();
  await second;
  assert.deepEqual(order, ['start:a1', 'finish:a1', 'start:a2', 'finish:a2']);
});

test('transient methods publish live events but never publish durable actions', async () => {
  const published = [];
  const core = createBrowserAuthorityRealtimeCore({
    session: { whenRuntimeReady: async () => ({}), sendOps: async () => ({ accepted: true, revision: 1 }) },
    clientId: 'student-a',
    name: 'Alex',
    permission: 'edit',
    getKnownRevision: () => 5,
    publish: async (event, payload, options) => {
      published.push({ event, payload, options });
      return 'ok';
    },
  });

  await core.sendCursor({ x: 10.123, y: 20.987 });
  await core.sendTransform({ objects: [{ id: 'x', matrix: [1, 0, 0, 1, 2, 3] }] });
  await core.sendScreenShareSignal({ protocol: 'p', type: 'board-peer-signal', sessionId: 's' });
  assert.deepEqual(published.map((entry) => entry.event), ['cursor', 'transform', 'screen-share-signal']);
  assert.equal(published.some((entry) => ['action', 'actions'].includes(entry.event)), false);
});

test('sendSettings stores background through durable authority while background-live remains transient', async () => {
  const published = [];
  const durable = [];
  const core = createBrowserAuthorityRealtimeCore({
    session: {
      whenRuntimeReady: async () => ({}),
      async sendOps(ops, options) {
        durable.push({ ops, options });
        return {
          actionId: options.actionId,
          revision: 2,
          accepted: true,
          changed: true,
          appliedOps: [],
          appliedBackground: options.background,
        };
      },
    },
    clientId: 'teacher-a',
    createActionId: () => 'background-action',
    getKnownRevision: () => 1,
    publish: async (event, payload) => { published.push({ event, payload }); return 'ok'; },
  });

  const result = await core.sendSettings({ background: 'dots' });
  assert.equal(result.revision, 2);
  assert.deepEqual(durable, [{
    ops: [],
    options: { actionId: 'background-action', background: 'dots' },
  }]);
  assert.equal(published[0].event, 'background-live');
});

test('fire-and-forget cursor failure is observed rather than an unhandled page rejection', async () => {
  const { spawnSync } = await import('node:child_process');
  const url = new URL('../src/lib/browserAuthorityRealtimeCore.js', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { createBrowserAuthorityRealtimeCore } from ${JSON.stringify(url)};
    const failure = new Error('Connection closed');
    const observed = [];
    const core = createBrowserAuthorityRealtimeCore({
      clientId: 'student', session: { sendOps: async () => ({}) },
      publish: async () => { throw failure; },
      onTransientError: (error, event) => observed.push([error, event]),
    });
    void core.sendCursor({x:1,y:2});
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(observed, [[failure, 'cursor']]);
  `], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
});

test('observing a transient error does not turn an awaited signaling failure into success', async () => {
  const failure = new Error('Live transport failure');
  const observed = [];
  const core = createBrowserAuthorityRealtimeCore({
    clientId: 'student', session: { sendOps: async () => ({}) },
    publish: async () => { throw failure; },
    onTransientError: (error, event) => observed.push([error, event]),
  });
  await assert.rejects(core.sendScreenShareSignal({protocol:'board',type:'offer',sessionId:'a'}), e=>e===failure);
  assert.deepEqual(observed, [[failure, 'screen-share-signal']]);
});


test('injected live publisher receives high-rate board events while signaling stays on Ably publisher', async () => {
  const ably = [];
  const live = [];
  const core = createBrowserAuthorityRealtimeCore({
    session: { whenRuntimeReady: async () => ({}), sendOps: async () => ({ accepted: true, revision: 1 }) },
    clientId: 'student-live',
    getKnownRevision: () => 9,
    publish: async (event, payload) => { ably.push({ event, payload }); return 'ok'; },
    publishLive: async (event, payload, options) => { live.push({ event, payload, options }); return { route: 'webrtc' }; },
  });

  await core.sendCursor({ x: 1, y: 2 });
  await core.sendDraw({ objectId: 'stroke-a', phase: 'update', points: [[1, 2]], baseRevision: 9 });
  await core.sendTransform({ objects: [{ id: 'shape-a', matrix: [1, 0, 0, 1, 2, 3] }] });
  await core.sendPreview([{ id: 'preview-a' }]);
  await core.sendObjectLive({ object: { boardObjectId: 'object-a' } });
  await core.sendDeletePreview(['object-a']);
  await core.sendSelectionTransaction({ phase: 'style', transactionId: 'tx-a' });
  await core.sendView({ centerX: 1, centerY: 2, zoom: 1 });
  await core.sendScreenShareSignal({ protocol: 'p', type: 'board-peer-signal', sessionId: 'signal-a' });

  assert.deepEqual(live.map((entry) => entry.event), [
    'cursor', 'draw', 'transform', 'preview', 'object-live',
    'delete-preview', 'selection-transaction', 'view',
  ]);
  assert.deepEqual(ably.map((entry) => entry.event), ['screen-share-signal']);
});


test('reliable board-control methods use WebRTC control publisher while signaling remains on Ably', async () => {
  const ably = [];
  const control = [];
  const durable = [];
  const core = createBrowserAuthorityRealtimeCore({
    session: {
      whenRuntimeReady: async () => ({}),
      async sendOps(ops, options) {
        durable.push({ ops, options });
        return { accepted: true, revision: 2, appliedOps: ops, appliedBackground: options.background ?? null };
      },
    },
    clientId: 'teacher-control',
    createActionId: () => 'background-control',
    getKnownRevision: () => 1,
    publish: async (event, payload) => { ably.push({ event, payload }); return 'ok'; },
    publishControl: async (event, payload) => { control.push({ event, payload }); return { route: 'webrtc' }; },
  });

  await core.sendMode('edit');
  await core.sendSettings({ background: 'dots' });
  await core.sendLock(['x'], true);
  await core.sendViewJump({ centerX: 1, centerY: 2, zoom: 1 });
  await core.requestView();
  await core.sendGameLibraryVisibility(true);
  await core.sendSelectionTransaction({ phase: 'start', transactionId: 'tx-control' });
  await core.sendScreenShareSignal({ protocol: 'p', type: 'board-peer-signal', sessionId: 's' });

  assert.deepEqual(control.map((entry) => entry.event), [
    'mode', 'background-live', 'lock', 'view-jump', 'view-request',
    'game-library-visibility', 'selection-transaction',
  ]);
  assert.deepEqual(ably.map((entry) => entry.event), ['screen-share-signal']);
  assert.equal(durable.length, 1, 'background canonical state remains a durable authority action');
});
