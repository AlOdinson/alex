const QUALITIES = [0.92, 0.82, 0.72];
const MAX_DATA_LENGTH = 1500000;
const isMedia = object => Boolean(object?.transientScreenShare || object?.screenShareSessionId || object?.objectKind === 'screen-share');

// Draw once; quality retries reuse the same sharp, white snapshot.
function drawThumbnail(source, createCanvas, renderContent) {
  if (!source?.width || !source?.height) return null;
  try {
    const preview = createCanvas();
    preview.width = Math.min(1600, source.width);
    preview.height = Math.max(1, Math.round(source.height * preview.width / source.width));
    const context = preview.getContext('2d');
    if (!context) return null;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, preview.width, preview.height);
    if (renderContent) renderContent(context, preview.width, preview.height);
    else context.drawImage(source, 0, 0, preview.width, preview.height);
    // Eraser paths cut through the first background; flatten alpha again.
    context.globalCompositeOperation = 'destination-over';
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, preview.width, preview.height);
    context.globalCompositeOperation = 'source-over';
    return preview;
  } catch { return null; }
}
const validImage = data => data?.startsWith('data:image/jpeg;base64,') && data.length <= MAX_DATA_LENGTH;
export function captureBoardThumbnail(source, createCanvas = () => document.createElement('canvas'), renderContent) {
  const preview = drawThumbnail(source, createCanvas, renderContent);
  if (!preview) return null;
  try {
    for (const quality of QUALITIES) {
      const data = preview.toDataURL('image/jpeg', quality);
      if (validImage(data)) return data;
    }
  } catch { /* Optional previews never interrupt saving or drawing. */ }
  return null;
}
async function encodeThumbnail(preview, window) {
  try {
    for (const quality of QUALITIES) {
      let data;
      if (typeof preview.toBlob === 'function') {
        const blob = await new Promise(resolve => preview.toBlob(resolve, 'image/jpeg', quality));
        if (!blob) return null;
        if (blob.size * 4 / 3 + 23 > MAX_DATA_LENGTH) continue;
        if (typeof window.FileReader === 'function') {
          data = await new Promise((resolve, reject) => {
            const reader = new window.FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
        } else {
          const bytes = new Uint8Array(await blob.arrayBuffer());
          let binary = '';
          for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
          data = `data:image/jpeg;base64,${btoa(binary)}`;
        }
      } else data = preview.toDataURL('image/jpeg', quality);
      if (validImage(data)) return data;
    }
  } catch { /* Tainted images and failed encodes remain optional. */ }
  return null;
}
const EXTRA_CONTENT_PROPERTIES = ['path', 'points', 'x1', 'y1', 'x2', 'y2', 'rx', 'ry', 'radius', 'fillRule', 'inverted', 'absolutePositioned', 'cropX', 'cropY', 'mediaAssetId', 'pageNumber'];

export function installBoardThumbnail({ canvas, save, window, document }) {
  let timer = null, idle = null, dirty = true, disposed = false, lastSaved = 0, lastImage = '';
  let staged = null, draining = null, rendering = false;
  const pointers = new Set(), observed = new Map(), stackObservers = new Map();
  let touches = 0;
  const viewportSignature = () => [canvas.getWidth?.() ?? canvas.lowerCanvasEl?.width,
    canvas.getHeight?.() ?? canvas.lowerCanvasEl?.height, ...(canvas.viewportTransform ?? [1, 0, 0, 1, 0, 0])].join(',');
  let viewport = viewportSignature();
  const clearScheduled = () => {
    if (timer !== null) window.clearTimeout(timer);
    if (idle !== null) window.cancelIdleCallback(idle);
    timer = idle = null;
  };
  const held = () => pointers.size || touches || canvas._isCurrentlyDrawing || canvas._currentTransform;
  const schedule = () => {
    if (disposed || !dirty || timer !== null || idle !== null || pointers.size || touches) return;
    timer = window.setTimeout(() => {
      timer = null;
      if (held() || disposed) return;
      const run = () => { idle = null; if (!held() && !disposed) flush(); };
      if (window.requestIdleCallback) idle = window.requestIdleCallback(run, { timeout: 1000 });
      else run();
    }, Math.max(500, 5000 - (Date.now() - lastSaved)));
  };
  const markDirty = () => { if (!disposed && !rendering) { dirty = true; clearScheduled(); schedule(); } };
  const changed = event => { if (!isMedia(event?.target)) markDirty(); };
  // Fabric's Collection callback covers all reorder methods without polling
  // object order after each render or replacing Board's moveObjectTo wrapper.
  const observeStackOrder = collection => {
    const original = collection._onStackOrderChanged;
    if (typeof original !== 'function' || stackObservers.has(collection)) return;
    const wrapper = function(object, ...args) {
      const result = original.call(this, object, ...args);
      changed({ target: object });
      return result;
    };
    stackObservers.set(collection, { original, wrapper, own: Object.hasOwn(collection, '_onStackOrderChanged') });
    collection._onStackOrderChanged = wrapper;
  };
  const unobserveStackOrder = collection => {
    const entry = stackObservers.get(collection);
    if (!entry) return;
    if (collection._onStackOrderChanged === entry.wrapper) {
      if (entry.own) collection._onStackOrderChanged = entry.original;
      else delete collection._onStackOrderChanged;
    }
    stackObservers.delete(collection);
  };
  const unobserve = object => {
    for (const child of object?.getObjects?.() ?? []) unobserve(child);
    const entry = observed.get(object);
    if (!entry) return;
    if (object._set === entry.wrapper) {
      if (entry.own) object._set = entry.original;
      else delete object._set;
    }
    object.off?.('object:added', entry.added);
    object.off?.('object:removed', entry.removed);
    unobserveStackOrder(object);
    observed.delete(object);
  };
  const observe = object => {
    if (!object || isMedia(object) || observed.has(object)) return;
    const original = object._set;
    const properties = new Set([...(object.constructor.stateProperties ?? []), ...(object.constructor.cacheProperties ?? []), ...EXTRA_CONTENT_PROPERTIES]);
    const wrapper = function(key, value) {
      const previous = this[key];
      const result = original.call(this, key, value);
      if (properties.has(key) && previous !== this[key]) markDirty();
      return result;
    };
    const added = event => { observe(event.target); changed(event); };
    const removed = event => { unobserve(event.target); changed(event); };
    observed.set(object, { original, wrapper, own: Object.hasOwn(object, '_set'), added, removed });
    if (typeof original === 'function') object._set = wrapper;
    if (object.getObjects) {
      observeStackOrder(object);
      object.on?.('object:added', added);
      object.on?.('object:removed', removed);
      for (const child of object.getObjects()) observe(child);
    }
  };
  const snapshot = () => {
    rendering = true;
    try {
      return drawThumbnail(canvas.lowerCanvasEl, () => document.createElement('canvas'),
        typeof canvas.getObjects === 'function' ? (context, width, height) => {
          context.save();
          context.scale(width / canvas.getWidth(), height / canvas.getHeight());
          context.transform(...(canvas.viewportTransform ?? [1, 0, 0, 1, 0, 0]));
          for (const object of canvas.getObjects()) {
            if (!isMedia(object) && object.visible !== false && (!object.isOnScreen || object.isOnScreen())) object.render(context);
          }
          context.restore();
        } : undefined);
    } finally { rendering = false; }
  };
  const release = preview => { if (preview) { preview.width = 0; preview.height = 0; } };
  const drain = async () => {
    try {
      while (staged) {
        const preview = staged;
        staged = null;
        const image = await encodeThumbnail(preview, window);
        release(preview);
        lastSaved = Date.now();
        if (image && image !== lastImage) {
          try { if (await save(image) !== false) lastImage = image; else dirty = true; }
          catch { dirty = true; }
        } else if (!image) dirty = true;
      }
    } finally { draining = null; }
  };
  function flush() {
    clearScheduled();
    if (dirty) {
      dirty = false;
      const preview = snapshot();
      // At most one encode/save and one newest waiting snapshot. Exit snapshots
      // are drawn now so board disposal cannot invalidate their objects later.
      release(staged);
      staged = preview;
      if (!preview) dirty = true;
    }
    if (!draining && staged) draining = drain();
    return draining ?? Promise.resolve();
  }
  const afterRender = () => {
    const next = viewportSignature();
    if (next !== viewport) { viewport = next; markDirty(); }
  };
  const added = event => { observe(event.target); changed(event); };
  const removed = event => { unobserve(event.target); changed(event); };
  const canvasEvents = { 'after:render': afterRender, 'object:added': added, 'object:removed': removed,
    'media:ready': changed, 'object:modified': changed, 'path:created': changed, 'text:changed': changed };
  const pointerDown = event => { pointers.add(event.pointerId); clearScheduled(); };
  const pointerUp = event => { pointers.delete(event.pointerId); schedule(); };
  const touch = event => { touches = event.touches?.length ?? 0; if (touches) clearScheduled(); else schedule(); };
  const blur = () => { pointers.clear(); touches = 0; schedule(); };
  const onVisibility = () => { if (document.visibilityState === 'hidden') { pointers.clear(); touches = 0; flush(); } };
  const onHomeClick = event => {
    if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const link = event.target?.closest?.('a[href]');
    if (!link || link.target === '_blank' || link.hasAttribute?.('download')) return;
    const current = new URL(window.location.href), destination = new URL(link.href, current);
    const homePath = current.pathname.split('/board/')[0] + '/';
    if (!current.pathname.includes('/board/') || destination.origin !== current.origin || destination.pathname !== homePath) return;
    event.preventDefault();
    let timeout;
    Promise.race([flush(), new Promise(resolve => { timeout = window.setTimeout(resolve, 1500); })])
      .finally(() => { window.clearTimeout(timeout); window.location.assign(destination.href); });
  };
  const inputEvents = { pointerdown: pointerDown, pointerup: pointerUp, pointercancel: pointerUp,
    touchstart: touch, touchend: touch, touchcancel: touch, blur };
  observeStackOrder(canvas);
  for (const object of canvas.getObjects?.() ?? []) observe(object);
  for (const [name, handler] of Object.entries(canvasEvents)) canvas.on(name, handler);
  for (const [name, handler] of Object.entries(inputEvents)) window.addEventListener(name, handler, { capture: true, passive: true });
  window.addEventListener('click', onHomeClick, true);
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', onVisibility);
  schedule();
  return () => {
    if (disposed) return draining ?? Promise.resolve();
    const pending = flush();
    disposed = true;
    for (const [name, handler] of Object.entries(canvasEvents)) canvas.off(name, handler);
    for (const [name, handler] of Object.entries(inputEvents)) window.removeEventListener(name, handler, { capture: true });
    for (const object of [...observed.keys()]) unobserve(object);
    unobserveStackOrder(canvas);
    pointers.clear(); touches = 0;
    window.removeEventListener('click', onHomeClick, { capture: true });
    window.removeEventListener('pagehide', flush);
    document.removeEventListener('visibilitychange', onVisibility);
    return pending;
  };
}
