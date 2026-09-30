// The lower cache includes Board's before:render background. The upper cache is
// transparent, so only source-over scenes can be safely split around the video.
const MAX_CACHE_PIXELS = 8_388_608; // At most 64 MiB across the two RGBA surfaces.
const SCENE_EVENTS = ['object:added', 'object:removed', 'object:modified',
  'object:moving', 'object:scaling', 'object:rotating', 'object:skewing',
  'text:changed', 'path:created'];

function sourceOver(object) {
  return (!object.globalCompositeOperation || object.globalCompositeOperation === 'source-over')
    && (!object.getObjects || object.getObjects().every(sourceOver));
}

export function createBoardScreenShareCompositor({ object, document: doc = globalThis.document }) {
  let canvas = null;
  let lower = null;
  let upper = null;
  let valid = false;
  let disposed = false;
  let signature = '';
  let detachHooks = () => {};

  const invalidate = () => { valid = false; };
  const release = () => {
    valid = false;
    for (const surface of [lower, upper]) {
      if (surface) { surface.width = 0; surface.height = 0; }
    }
    lower = upper = null;
  };
  const detach = () => {
    detachHooks();
    detachHooks = () => {};
    canvas = null;
    release();
  };
  const state = () => JSON.stringify([
    canvas.lowerCanvasEl.width, canvas.lowerCanvasEl.height,
    canvas.getRetinaScaling(), canvas.viewportTransform,
    object.calcTransformMatrix(), object.width, object.height, object.cropX, object.cropY,
    object.opacity, object.visible, canvas.imageSmoothingEnabled, canvas.patternQuality,
  ]);
  const supported = () => !canvas.getActiveObject?.() && !canvas._currentTransform
    && !canvas.clipPath && !canvas.overlayImage && !canvas.overlayColor
    && object.visible && sourceOver(object);

  const attach = () => {
    if (disposed || canvas === object.canvas) return;
    detach();
    const next = object.canvas;
    if (!next?._renderObjects || !next.lowerCanvasEl || !next.getRetinaScaling) return;
    canvas = next;
    const attachedCanvas = canvas;
    let active = true;
    const originalRenderObjects = canvas._renderObjects;
    const originalRequestRender = canvas.requestRenderAll;
    const originalStackOrderChanged = canvas._onStackOrderChanged;
    const requestRender = function (...args) {
      if (active) invalidate();
      return originalRequestRender.apply(this, args);
    };
    const stackOrderChanged = function (...args) {
      if (active) invalidate();
      return originalStackOrderChanged.apply(this, args);
    };
    const renderObjects = function (ctx, objects) {
      // Export/thumbnail renderCanvas calls must never replace the live cache.
      if (!active || disposed || this !== attachedCanvas || ctx !== attachedCanvas.contextContainer) {
        return originalRenderObjects.call(this, ctx, objects);
      }
      invalidate();
      const index = objects.indexOf(object);
      const width = canvas.lowerCanvasEl.width, height = canvas.lowerCanvasEl.height;
      if (index < 0 || !supported() || width * height > MAX_CACHE_PIXELS
        || objects.some(item => item !== object && item.transientScreenShare)
        || !objects.every(sourceOver)) {
        release();
        return originalRenderObjects.call(this, ctx, objects);
      }
      lower ??= doc.createElement('canvas');
      upper ??= doc.createElement('canvas');
      lower.width = upper.width = width;
      lower.height = upper.height = height;
      const lowerContext = lower.getContext('2d'), upperContext = upper.getContext('2d');
      if (!lowerContext || !upperContext) {
        release();
        return originalRenderObjects.call(this, ctx, objects);
      }
      originalRenderObjects.call(this, ctx, objects.slice(0, index));
      lowerContext.drawImage(canvas.lowerCanvasEl, 0, 0);
      originalRenderObjects.call(this, ctx, objects.slice(index));
      // Preserve normal Fabric rendering; replay only foreground geometry when
      // rebuilding. Video-only presentations never visit that geometry again.
      const transform = ctx.getTransform();
      upperContext.setTransform(transform.a, transform.b, transform.c, transform.d, transform.e, transform.f);
      upperContext.imageSmoothingEnabled = ctx.imageSmoothingEnabled;
      upperContext.patternQuality = ctx.patternQuality;
      originalRenderObjects.call(this, upperContext, objects.slice(index + 1));
      signature = state();
      valid = true;
    };
    canvas.requestRenderAll = requestRender;
    canvas._renderObjects = renderObjects;
    canvas._onStackOrderChanged = stackOrderChanged;
    detachHooks = () => {
      active = false;
      for (const event of SCENE_EVENTS) attachedCanvas.off(event, invalidate);
      if (attachedCanvas._renderObjects === renderObjects) attachedCanvas._renderObjects = originalRenderObjects;
      if (attachedCanvas.requestRenderAll === requestRender) attachedCanvas.requestRenderAll = originalRequestRender;
      if (attachedCanvas._onStackOrderChanged === stackOrderChanged) attachedCanvas._onStackOrderChanged = originalStackOrderChanged;
    };
    for (const event of SCENE_EVENTS) canvas.on(event, invalidate);
  };
  const isVisible = () => {
    if (disposed || doc?.hidden || !object.canvas || object.visible === false || object.opacity === 0) return false;
    // Fabric's isOnScreen uses viewport boundaries, which may lag a direct pan.
    object.canvas.calcViewportBoundaries?.();
    return !object.isOnScreen || object.isOnScreen();
  };
  const present = () => {
    if (!isVisible()) return false;
    attach();
    if (!canvas) { object.canvas?.requestRenderAll?.(); return false; }
    if (!valid || canvas.nextRenderHandle || !supported() || signature !== state()) {
      canvas.requestRenderAll();
      return false;
    }
    const ctx = canvas.contextContainer;
    ctx.save();
    try {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, lower.width, lower.height);
      ctx.drawImage(lower, 0, 0);
      const retina = canvas.getRetinaScaling();
      ctx.scale(retina, retina);
      ctx.transform(...canvas.viewportTransform);
      object.render(ctx);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(upper, 0, 0);
    } finally { ctx.restore(); }
    // Do not clear contextTop: it can contain the active brush preview or the
    // temporary selection controls drawn by Board during an interaction.
    return true;
  };
  object.on?.('added', attach);
  object.on?.('removed', detach);
  attach();
  return {
    isVisible, present, invalidate,
    dispose() {
      if (disposed) return;
      disposed = true;
      object.off?.('added', attach);
      object.off?.('removed', detach);
      detach();
    },
  };
}
