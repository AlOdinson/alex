// Reuse the visible bitmap: never rerender the board just for a library card.
export function captureBoardThumbnail(source, createCanvas = () => document.createElement('canvas')) {
  if (!source?.width || !source?.height) return null;
  try {
    const preview = createCanvas();
    const context = preview.getContext('2d');
    if (!context) return null;
    // At most 20k characters per card: 50 previews stay below ~2 MB of
    // UTF-16 storage, leaving room for library metadata and other settings.
    for (const [size, quality] of [[360, 0.65], [360, 0.4], [240, 0.4], [180, 0.3]]) {
      preview.width = size;
      preview.height = size / 2;
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, preview.width, preview.height);
      const scale = Math.min(preview.width / source.width, preview.height / source.height);
      const width = source.width * scale, height = source.height * scale;
      context.drawImage(source, (preview.width - width) / 2, (preview.height - height) / 2, width, height);
      const data = preview.toDataURL('image/jpeg', quality);
      if (data.startsWith('data:image/jpeg;base64,') && data.length <= 20000) return data;
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
