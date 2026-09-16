import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
const screen = readFileSync(new URL('../src/components/ScreenShare.jsx', import.meta.url), 'utf8');
const cloud = readFileSync(new URL('../src/components/useCloudScreenShareFallback.js', import.meta.url), 'utf8');
const board = readFileSync(new URL('../src/components/Board.jsx', import.meta.url), 'utf8');
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function nativeSender(secondary, sourceMode = 'screen') {
  const sent = [];
  const dependencies = {
    activeSessionRef: { current: { sessionId: 'screen-123', sourceMode } },
    directSignalChannelRef: { current: secondary },
    realtimeRef: { current: { sendScreenShareSignal: async (payload) => { sent.push(payload); return 'ok'; } } },
    SCREEN_SHARE_PROTOCOL: 'alex-screen-share-v1',
    clientId: 'teacher', participantName: 'Teacher', isOwner: true, canEdit: true,
  };
  const body = screen.split('  const sendSignal = useCallback((type, details = {}, explicitSession = null) => {')[1].split('\n  }, [')[0];
  const run = new Function('type', 'details', 'explicitSession', ...Object.keys(dependencies), body);
  return { sent, send: (type) => run(type, {}, null, ...Object.values(dependencies)) };
}
for (const phase of ['pending', 'rejected', 'apparently-healthy']) {
  test(`native screen uses the board channel even when secondary signaling is ${phase}`, async () => {
    const ready = phase === 'pending' ? new Promise(() => {})
      : phase === 'rejected' ? Promise.reject(new Error('secondary offline')) : Promise.resolve();
    ready.catch(() => {});
    let secondarySends = 0;
    const f = nativeSender({ ready, channel: { send: async () => { secondarySends++; return 'ok'; } } });
    const sends = ['host-start', 'viewer-ready', 'offer', 'answer', 'ice', 'screen-layout', 'host-stop'].map(f.send);
    await flush();
    assert.deepEqual(f.sent.map((m) => m.type), ['host-start', 'viewer-ready', 'offer', 'answer', 'ice', 'screen-layout', 'host-stop']);
    await Promise.all(sends);
    assert.equal(secondarySends, 0, 'a sender-side receipt cannot prove a remote secondary subscription works');
  });
}
test('Mac remote-browser sessions retain their native agent signaling route', async () => {
  let sent = 0;
  const f = nativeSender({ ready: Promise.resolve(), channel: { send: async () => { sent++; return 'ok'; } } }, 'remote-browser');
  await f.send('viewer-ready'); assert.equal(sent, 1); assert.equal(f.sent.length, 0);
});
for (const type of ['cloud-track', 'cloud-disable', 'cloud-grant-request', 'cloud-publisher-grant', 'cloud-viewer-ready']) {
  test(`${type} reaches peers without waiting for the secondary Cloud subscription`, async () => {
    const sent = [];
    const dependencies = {
      sessionContextRef: { current: { sessionId: 'screen-123' } },
      CLOUD_SIGNAL_TYPES: new Set([type]), CLOUD_SIGNAL_EVENT: 'screen-share-cloud',
      channelRef: { current: { ready: new Promise(() => {}), channel: { send: () => assert.fail('must use board signaling') } } },
      realtimeRef: { current: { sendScreenShareSignal: async (payload) => { sent.push(payload); return 'ok'; } } },
      SCREEN_SHARE_PROTOCOL: 'alex-screen-share-v1', clientId: 'teacher', participantName: 'Teacher', isOwner: true, canEdit: true,
    };
    const body = cloud.split('  const sendCloudSignal = useCallback(async (type, details = {}) => {')[1].split('\n  }, [')[0];
    const run = new Function('type', 'details', ...Object.keys(dependencies), `return (async () => {${body}\n})();`);
    const sending = run(type, {}, ...Object.values(dependencies));
    await flush(); assert.equal(sent.length, 1); assert.equal(sent[0].type, type); await sending;
  });
}
test('board-level screen dispatcher delivers Cloud announcements as well as native signaling', () => {
  const received = [];
  const body = screen.split('export function useAdaptiveScreenShare(options) {')[1].split('\nexport function ScreenShareOverlay')[0];
  const run = new Function('options', 'useAdaptiveScreenShareBase', 'useCloudScreenShareFallback', 'useCallback', body.slice(0, body.lastIndexOf('}')));
  const ref = { current: {} };
  const result = run({ realtimeRef: ref }, () => ({ handleSignal: (value) => received.push(['native', value]) }),
    (options) => {
      assert.equal(options.realtimeRef, ref, 'Cloud must receive the existing board transport');
      return { handleSignal: (value) => received.push(['cloud', value]) };
    }, (fn) => fn);
  const signal = { type: 'cloud-track' }; result.handleSignal(signal);
  assert.deepEqual(received, [['native', signal], ['cloud', signal]]);
});
test('a live screen object removed by snapshot replacement is reattached, not left permanently invisible', () => {
  const objects = [], object = { screenShareSessionId: 'screen-123' };
  const canvas = { getObjects: () => objects, add: (o) => { objects.push(o); o.canvas = canvas; }, requestRenderAll() {} };
  const controller = { object, setInteractive() {}, setStream() {}, setLayout() {}, dispose() {} };
  const dependencies = {
    fabricCanvasRef: { current: canvas }, boardScreenShareRef: { current: controller }, canEdit: true,
    screenShare: { sessionId: 'screen-123', sourceMode: 'screen', boardLayout: {}, stream: {} },
    screenShareRef: { current: { sessionId: 'screen-123', sourceMode: 'screen', boardLayout: {}, stream: {} } },
    canEditRef: { current: true }, screenShareViewportSessionRef: { current: '' },
    createBoardScreenShareMedia: () => assert.fail('must reuse the current media controller'),
  };
  const anchor = "    const active = Boolean(screenShare.sessionId && screenShare.sourceMode === 'screen');";
  const start = board.lastIndexOf('  useEffect(() => {', board.indexOf(anchor));
  const body = board.includes('  const reconcileBoardScreenShare = useCallback(() => {')
    ? board.split('  const reconcileBoardScreenShare = useCallback(() => {')[1].split('\n  }, []);')[0]
    : board.slice(start + '  useEffect(() => {'.length).split('\n  }, [canEdit, screenShare.boardLayout')[0];
  if (board.includes('const reconcileBoardScreenShare =')) {
    delete dependencies.screenShare; delete dependencies.canEdit;
  }
  const run = new Function(...Object.keys(dependencies), body);
  run(...Object.values(dependencies)); run(...Object.values(dependencies));
  assert.deepEqual(objects, [object]);
  // A snapshot can complete after Stop: consult current session, not old media.
  objects.length = 0; delete object.canvas;
  dependencies.screenShareRef.current = { sessionId: '', sourceMode: null };
  run(...Object.values(dependencies)); assert.deepEqual(objects, []);
});

test('both initial and recovery snapshot paths reconcile live screen media after loading', () => {
  for (const source of ['snapshot.canvas', 'effectiveSnapshot.canvas']) {
    const anchor = `await loadCanvasJsonProgressively(canvas, ${source});`;
    assert.ok(board.includes(anchor));
    assert.match(board.split(anchor)[1].slice(0, 1200), /reconcileBoardScreenShare\(\);/);
  }
});
