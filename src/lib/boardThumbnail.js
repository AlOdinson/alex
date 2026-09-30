// Render content into a separate white canvas without touching the live board.
export function captureBoardThumbnail(source, createCanvas = () => document.createElement('canvas'), renderContent) {
  if (!source?.width || !source?.height) return null;
  try {
    const preview = createCanvas();
    const context = preview.getContext('2d');
    if (!context) return null;
    // Preserve fine writing; the image cache lives in IndexedDB, not localStorage.
    for (const quality of [0.92, 0.82, 0.72]) {
      preview.width = Math.min(1600, source.width);
      preview.height = Math.max(1, Math.round(source.height * preview.width / source.width));
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, preview.width, preview.height);
      if (renderContent) renderContent(context, preview.width, preview.height);
      else context.drawImage(source, 0, 0, preview.width, preview.height);
      // Eraser paths may cut through the initial background. Flatten alpha
      // against white after rendering so JPEG never turns erased areas black.
      context.globalCompositeOperation = 'destination-over';
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, preview.width, preview.height);
      context.globalCompositeOperation = 'source-over';
      const data = preview.toDataURL('image/jpeg', quality);
      if (data.startsWith('data:image/jpeg;base64,') && data.length <= 1500000) return data;
    }
    return null;
  } catch { return null; } // Optional previews must never interrupt saving or drawing.
}

export function installBoardThumbnail({ canvas, save, window, document }) {
  let timer = null, dirty = false, lastSaved = 0, lastImage = '';
  const flush = () => {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
    if (!dirty) return;
    dirty = false;
    const image = captureBoardThumbnail(canvas.lowerCanvasEl, undefined,
      typeof canvas.getObjects === 'function' ? (context, width, height) => {
        context.save();
        context.scale(width / canvas.getWidth(), height / canvas.getHeight());
        context.transform(...(canvas.viewportTransform ?? [1, 0, 0, 1, 0, 0]));
        for (const object of canvas.getObjects()) {
          if (object.visible !== false && (!object.isOnScreen || object.isOnScreen())) object.render(context);
        }
        context.restore();
      } : undefined);
    lastSaved = Date.now();
    if (image && image !== lastImage) {
      lastImage = image;
      save(image);
    }
  };
  const schedule = () => {
    dirty = true;
    if (timer === null) timer = window.setTimeout(flush, Math.max(500, 5000 - (Date.now() - lastSaved)));
  };
  const onVisibility = () => { if (document.visibilityState === 'hidden') flush(); };
  canvas.on('after:render', schedule);
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', onVisibility);
  schedule();
  return () => {
    flush();
    canvas.off('after:render', schedule);
    window.removeEventListener('pagehide', flush);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
