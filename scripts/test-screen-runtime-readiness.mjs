import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';

const source = readFileSync(new URL('../src/components/ScreenShare.jsx', import.meta.url), 'utf8');
const senderStart = source.includes('  const signalingPermissionRef = useRef(canEdit);')
  ? '  const signalingPermissionRef = useRef(canEdit);'
  : '  const sendSignal = useCallback(';
const sender = source.slice(source.indexOf(senderStart), source.indexOf('\n  const applyCurrentProfile'));
const cleanup = source.slice(source.indexOf('  useEffect(() => () => {\n    mountedRef.current = false;'),
  source.indexOf('\n  const isHosting ='));

function fixture() {
  const dom = new JSDOM('<div id="app"></div>');
  const previous = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const state = { closes: 0, stopped: [], lastSend: null, signals: [] };
  const values = {
    activeSessionRef: { current: null }, localStreamRef: { current: null }, mountedRef: { current: true },
    realtimeRef: { current: { sendScreenShareSignal: async payload => { state.signals.push(payload); return 'ok'; } } },
    directSignalChannelRef: { current: { ready: Promise.resolve(), channel: {
      send: async message => { state.signals.push(message.payload); return 'ok'; },
    } } },
    clearHostPeers: () => { state.closes++; },
    stopStream: stream => { if (stream) state.stopped.push(stream); },
    clientId: 'student', participantName: 'Student', isOwner: false, SCREEN_SHARE_PROTOCOL: 'screen-test',
    useCallback: React.useCallback, useRef: React.useRef, useEffect: React.useEffect,
  };
  // Execute the production signaling callback and production cleanup effect with
  // real React hooks. Viewer cleanup's sender dependency mirrors the real hook.
  const hook = new Function('canEdit', ...Object.keys(values), `${sender}\n
    const clearViewerPeer = useCallback(() => {}, [sendSignal]);\n${cleanup}\nreturn sendSignal;`);
  function Probe({ ready }) { state.lastSend = hook(ready, ...Object.values(values)); return null; }
  const root = createRoot(dom.window.document.getElementById('app'));
  return { state, values, render: ready => act(() => root.render(React.createElement(Probe, { ready }))),
    close: async () => { await act(() => root.unmount()); dom.window.close();
      globalThis.window = previous.window; globalThis.document = previous.document;
      globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act; } };
}

test('runtime readiness does not execute screen unmount cleanup or disable its state updates', async () => {
  const f = fixture();
  try {
    await f.render(false);
    const sender = f.state.lastSend;
    await f.render(true);
    assert.equal(f.state.closes, 0, 'readiness must not impersonate component unmount');
    assert.equal(f.values.mountedRef.current, true);
    assert.equal(f.state.lastSend, sender, 'permission changes must not replace the signaling callback');
    await f.render(false);
    assert.equal(f.state.closes, 0);
    assert.equal(f.values.mountedRef.current, true);
  } finally { await f.close(); }
  assert.equal(f.state.closes, 1, 'real unmount must still release resources');
});

test('stable screen signaling still publishes the current permission after readiness changes', async () => {
  const f = fixture();
  try {
    await f.render(false);
    await f.state.lastSend('remote-browser-start', {}, { sessionId: 's1', sourceMode: 'remote-browser' });
    await f.render(true);
    await f.state.lastSend('remote-browser-start', {}, { sessionId: 's1', sourceMode: 'remote-browser' });
    await f.render(false);
    await f.state.lastSend('remote-browser-start', {}, { sessionId: 's1', sourceMode: 'remote-browser' });
    assert.deepEqual(f.state.signals.map(signal => signal.permission), ['view', 'edit', 'view']);
  } finally { await f.close(); }
});
