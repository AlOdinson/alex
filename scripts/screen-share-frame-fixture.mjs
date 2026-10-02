import { Canvas, Path, getEnv } from 'fabric/node';
import { setEnv } from 'fabric';
import { createBoardScreenShareMedia } from '../src/lib/boardScreenShare.js';
setEnv(getEnv());

// Real Fabric and Canvas pixels; only the browser's frame clocks/video decoder
// are controllable so callback starvation is reproducible, not a timing flake.
export function frameFixture({ callback = true, counters = true, staticPath = true } = {}) {
  const nativeWindow = getEnv().window, nativeDoc = getEnv().document;
  const doc = new EventTarget(), win = new EventTarget();
  doc.hidden = false;
  let video, nextId = 0, now = 0, decoded = 0, copyCount = 0, pathRenders = 0, coords = 0;
  const frames = new Map(), animations = new Map(), intervals = new Map(), timers = new Map();
  const raf = fn => { animations.set(++nextId, fn); return nextId; };
  const caf = id => animations.delete(id);
  const old = Object.fromEntries(['document', 'window', 'performance', 'requestAnimationFrame',
    'cancelAnimationFrame', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout']
    .map(key => [key, globalThis[key]]));
  const nativeRAF = nativeWindow.requestAnimationFrame, nativeCAF = nativeWindow.cancelAnimationFrame;
  Object.assign(win, { requestAnimationFrame: raf, cancelAnimationFrame: caf });
  Object.assign(globalThis, { document: doc, window: win, performance: { now: () => now },
    requestAnimationFrame: raf, cancelAnimationFrame: caf,
    setInterval: (fn, ms) => { intervals.set(++nextId, { fn, ms, due: now + ms }); return nextId; },
    clearInterval: id => intervals.delete(id),
    setTimeout: (fn, ms = 0) => { timers.set(++nextId, { fn, due: now + ms }); return nextId; },
    clearTimeout: id => timers.delete(id),
  });
  nativeWindow.requestAnimationFrame = raf; nativeWindow.cancelAnimationFrame = caf;
  doc.createElement = type => {
    const element = nativeDoc.createElement(type === 'video' ? 'canvas' : type);
    if (type === 'video') {
      video = element; video.width = 1920; video.height = 1080;
      Object.assign(video, { videoWidth: 1920, videoHeight: 1080, readyState: 2,
        paused: false, ended: false, currentTime: 0, play: () => Promise.resolve(), pause: () => {} });
      if (counters) video.getVideoPlaybackQuality = () => ({ totalVideoFrames: decoded, droppedVideoFrames: 0 });
      if (callback) {
        video.requestVideoFrameCallback = fn => { frames.set(++nextId, fn); return nextId; };
        video.cancelVideoFrameCallback = id => frames.delete(id);
      }
    }
    return element;
  };
  const media = createBoardScreenShareMedia({ layout: { left: 20, top: 20, width: 80, height: 45 }, canEdit: true });
  const canvas = new Canvas(null, { width: 160, height: 120, renderOnAddRemove: false });
  if (staticPath) {
    const path = new Path('M 0 0 L 100 100 L 0 100 z', { fill: '#ff0055', objectCaching: false });
    const render = path._render; path._render = function (...args) { pathRenders++; return render.apply(this, args); };
    canvas.add(path);
  }
  canvas.add(media.object);
  const setCoords = media.object.setCoords;
  media.object.setCoords = function (...args) { coords++; return setCoords.apply(this, args); };
  const context = media.frameCanvas.getContext('2d'), draw = context.drawImage;
  context.drawImage = function (...args) { if (args[0] === video) copyCount++; return draw.apply(this, args); };
  const decode = (color = '#2244ff') => {
    decoded++; video.currentTime = decoded / 60;
    const ctx = video.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(0, 0, video.width, video.height);
  };
  const signal = (metadata = { presentedFrames: decoded, mediaTime: video.currentTime }) => {
    const callbacks = [...frames];
    for (const [id, fn] of callbacks) { if (frames.delete(id)) fn(now, metadata); }
  };
  const step = (ms = 1000 / 60) => {
    now += ms;
    for (const [id, timer] of [...intervals]) {
      if (timer.due <= now && intervals.has(id)) { timer.due = now + timer.ms; timer.fn(); }
    }
    for (const [id, timer] of [...timers]) { if (timer.due <= now && timers.delete(id)) timer.fn(); }
    for (const [id, fn] of [...animations]) { if (animations.delete(id)) fn(now); }
  };
  const full = () => { canvas.cancelRequestedRender(); canvas.renderAll(); };
  const close = async () => {
    media.dispose(); canvas.cancelRequestedRender();
    Object.assign(globalThis, old); nativeWindow.requestAnimationFrame = nativeRAF; nativeWindow.cancelAnimationFrame = nativeCAF;
    await canvas.dispose();
  };
  decode(); media.setStream({}); step(); full();
  return { media, canvas, doc, win, video, frames, animations, intervals, timers, decode, signal, step, full, close,
    get copies() { return copyCount; }, get coords() { return coords; }, get paths() { return pathRenders; },
  };
}
