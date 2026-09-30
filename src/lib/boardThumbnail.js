// Reuse the visible bitmap: never rerender the board just for a library card.
export function captureBoardThumbnail(source, createCanvas = () => document.createElement('canvas')) {
  if (!source?.width || !source?.height) return null;
  try {
    const preview = createCanvas();
    preview.width = 360;
    preview.height = 180;
    const context = preview.getContext('2d');
    if (!context) return null;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, 360, 180);
    const scale = Math.min(360 / source.width, 180 / source.height);
    const width = source.width * scale, height = source.height * scale;
    context.drawImage(source, (360 - width) / 2, (180 - height) / 2, width, height);
    const data = preview.toDataURL('image/jpeg', 0.65);
    return data.startsWith('data:image/jpeg;base64,') && data.length < 60000 ? data : null;
  } catch { return null; } // Optional previews must never interrupt saving or drawing.
}

export function installBoardThumbnail({ canvas, save, window, document }) {
  let timer = null, dirty = false, lastSaved = 0, lastImage = '';
  const flush = () => {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
    if (!dirty) return;
    dirty = false;
    const image = captureBoardThumbnail(canvas.lowerCanvasEl);
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
