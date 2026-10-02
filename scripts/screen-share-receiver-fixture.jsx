import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { Canvas } from 'fabric';
import { useAdaptiveScreenShare } from '../src/components/ScreenShare.jsx';
import { createBoardScreenShareMedia } from '../src/lib/boardScreenShare.js';

// Test-only generated capture + bridged signaling. Production hooks, encoder,
// decoder and canvas renderer run unchanged, in separate native browser pages.
export function install(role) {
  const d = window.receiverTest = { role, peers: [], fault: '', notifications: 0,
    copies: 0, uniqueFrames: 0, lastStamp: null, presentationTimes: [], progressSamples: [], errors: [] };
  const NativePeer = window.RTCPeerConnection;
  window.RTCPeerConnection = class extends NativePeer {
    constructor() { super({ iceServers: [] }); d.peers.push(this); }
  };
  const devices = navigator.mediaDevices;
  const captureGeneratedScreen = async () => {
    await new Promise(resolve => setTimeout(resolve, 50));
    const source = document.createElement('canvas'); source.width = 1920; source.height = 1080;
    // This visible source is test-only; the receiver still has an empty scene.
    source.style.cssText = 'position:fixed;right:0;bottom:0;width:320px;height:180px;pointer-events:none';
    document.body.append(source);
    const ctx = source.getContext('2d'); let n = 0;
    const paint = () => {
      n = (n + 1) & 4095; d.capturePaints = n;
      ctx.fillStyle = '#315797'; ctx.fillRect(0, 0, 1920, 1080);
      ctx.fillStyle = '#cfea47'; ctx.fillRect((n * 13) % 1800, 160, 80, 850);
      // 12 wide monochrome blocks survive encoder scaling. Read back only a
      // 12-pixel diagnostic strip to count genuinely different received images.
      for (let i = 0; i < 12; i++) {
        ctx.fillStyle = n & (1 << i) ? '#ffffff' : '#000000';
        ctx.fillRect(i * 64, 0, 64, 120);
      }
    };
    paint(); d.captureTimer = setInterval(paint, 1000 / 60);
    d.capture = source.captureStream(60); return d.capture;
  };
  // Retain the MediaDevices wrapper and override the navigator property as well.
  // A method assignment alone did not survive to capture in native WebKit CI:
  // capturePaints stayed undefined and its default gray source was measured.
  Object.defineProperty(devices, 'getDisplayMedia', {configurable:true, value:captureGeneratedScreen});
  Object.defineProperty(navigator, 'mediaDevices', {configurable:true, value:devices});
  d.devices = devices;
  const clientId = `receiver-test-${role}`;
  const users = [{ clientId: 'receiver-test-host', permission: 'owner', name: 'Host' },
    { clientId: 'receiver-test-viewer', permission: 'edit', name: 'Viewer' }];
  const realtimeRef = { current: { sendScreenShareSignal: payload => window.routeSignal({
    ...payload, clientId, name: role, permission: role === 'host' ? 'owner' : 'edit', timestamp: Date.now(),
  }) } };
  const el = document.createElement('canvas'); document.body.append(el);
  const canvas = d.canvas = new Canvas(el, { width: innerWidth, height: innerHeight,
    renderOnAddRemove: true, preserveObjectStacking: true, backgroundColor: 'white' });

  function instrument(media) {
    const video = media.video;
    const noteProgress = (source, metadata = null) => {
      const quality = video.getVideoPlaybackQuality?.();
      d.progressSamples.push({source, time: performance.now(), mediaTime: video.currentTime,
        total: quality?.totalVideoFrames, dropped: quality?.droppedVideoFrames,
        decoded: video.webkitDecodedFrameCount, metadata});
      if (d.progressSamples.length > 100) d.progressSamples.shift();
    };
    const request = video.requestVideoFrameCallback?.bind(video), cancel = video.cancelVideoFrameCallback?.bind(video);
    let nextId = 0, lastDelivery = -Infinity;
    const pending = new Map();
    const wrappedRequest = fn => {
      const id = ++nextId, entry = { native: null, timer: null }; pending.set(id, entry);
      entry.native = request((...args) => {
        entry.native = null;
        const deliver = () => {
          if (!pending.delete(id)) return;
          lastDelivery = performance.now(); d.notifications++; noteProgress('callback', args[1]); fn(...args);
        };
        const delay = d.fault.includes('slow') ? Math.max(0, 500 - (performance.now() - lastDelivery)) : 0;
        if (delay) entry.timer = setTimeout(deliver, delay); else deliver();
      });
      return id;
    };
    const wrappedCancel = id => {
      const entry = pending.get(id); if (!entry) return;
      if (entry.native != null) cancel?.(entry.native);
      if (entry.timer != null) clearTimeout(entry.timer);
      pending.delete(id);
    };
    if (request) { video.requestVideoFrameCallback = wrappedRequest; video.cancelVideoFrameCallback = wrappedCancel; }
    const quality = video.getVideoPlaybackQuality?.bind(video);
    const probe = document.createElement('canvas'); probe.width = 12; probe.height = 1;
    const read = probe.getContext('2d', { willReadFrequently: true }); read.imageSmoothingEnabled = false;
    const context = media.frameCanvas.getContext('2d'), draw = context.drawImage.bind(context);
    context.drawImage = (...args) => {
      const result = draw(...args);
      if (args[0] !== video) return result;
      d.copies++; noteProgress('copy');
      const frame = media.frameCanvas;
      read.drawImage(frame, 0, 0, frame.width * 768 / 1920, frame.height * 120 / 1080, 0, 0, 12, 1);
      const pixels = read.getImageData(0, 0, 12, 1).data; d.barcodePixels = [...pixels];
      let stamp = 0; for (let i = 0; i < 12; i++) if (pixels[i * 4] > 128) stamp |= 1 << i;
      if (stamp !== d.lastStamp) {
        d.uniqueFrames++; d.lastStamp = stamp; d.presentationTimes.push(performance.now());
        if (d.presentationTimes.length > 1000) d.presentationTimes.shift();
      }
      return result;
    };
    d.setFault = fault => {
      d.fault = fault;
      video.getVideoPlaybackQuality = fault.includes('counterless')
        ? () => ({ totalVideoFrames: 0, droppedVideoFrames: 0 }) : quality;
      if (fault.includes('counterless')) Object.defineProperty(video, 'webkitDecodedFrameCount', {configurable:true,value:0});
      else delete video.webkitDecodedFrameCount;
      video.requestVideoFrameCallback = fault === 'no-api' ? undefined : (request ? wrappedRequest : undefined);
      media.setStream(null); media.setStream(d.share.stream);
    };
  }
  function Probe() {
    const share = useAdaptiveScreenShare({ realtimeRef, users, isOwner: role === 'host', canEdit: true,
      clientId, participantName: role, boardId: 'receiver-test-board', boardKey: 'receiver-test-key',
      boardRealtimeKey: '', teacherAccountKey: '', getInitialBoardLayout: () => ({left:40,top:40,width:900,height:506.25}) });
    d.share = share;
    useEffect(() => {
      if (!share.sessionId || share.sourceMode !== 'screen') return;
      if (!d.media) {
        d.media = createBoardScreenShareMedia({ sessionId: share.sessionId, layout: share.boardLayout, canEdit: true });
        instrument(d.media); canvas.add(d.media.object);
      }
      d.media.setStream(share.stream); canvas.requestRenderAll();
    }, [share.sessionId, share.stream]);
    return null;
  }
  const root = document.createElement('div'); document.body.append(root); d.root = createRoot(root); d.root.render(<Probe />);
  d.receive = message => d.share?.handleSignal(message);
  d.sample = async () => {
    const stats = [];
    for (const peer of d.peers) {
      if (peer.connectionState === 'closed') continue;
      stats.push(...[...(await peer.getStats()).values()].filter(s => ['inbound-rtp','outbound-rtp'].includes(s.type)));
    }
    return { time: performance.now(), notifications: d.notifications, copies: d.copies, uniqueFrames: d.uniqueFrames,
      presentationTimes: d.presentationTimes.slice(), objects: canvas.getObjects().length, fault: d.fault,
      phase: d.share.phase, ultra: d.share.ultraEnabled, resolution720: d.share.resolution720Enabled,
      videoReady: d.media?.video.readyState, width: d.media?.video.videoWidth, height: d.media?.video.videoHeight,
      capturePaints: d.capturePaints, barcodePixels: d.barcodePixels, progressSamples: d.progressSamples.slice(), stats, pump: d.media?.getFrameStats?.(), errors: d.errors };
  };
  d.close = async () => { d.share?.stop(); clearInterval(d.captureTimer); d.media?.dispose(); d.root.unmount(); await canvas.dispose(); };
}
