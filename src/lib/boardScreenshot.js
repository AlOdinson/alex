// Capture the actual presented Fabric framebuffer. This includes the live screen
// share frame, PDF/GIF pixels, drawings, notebooks and the viewport background.
// Export-only rendering excludes transient screen shares and can repaint a costly
// board; screenshots deliberately avoid that separate export pipeline.
const MAX_SCREENSHOT_SIDE = 1800;
const MIN_SCREENSHOT_SIDE = 4;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function normalizeScreenshotRect(start, end, bounds) {
  const values = [start?.x, start?.y, end?.x, end?.y, bounds?.width, bounds?.height].map(Number);
  if (!values.every(Number.isFinite)) return null;
  const [x1, y1, x2, y2, width, height] = values;
  if (width <= 0 || height <= 0) return null;
  const left = clamp(Math.min(x1, x2), 0, width);
  const top = clamp(Math.min(y1, y2), 0, height);
  const right = clamp(Math.max(x1, x2), 0, width);
  const bottom = clamp(Math.max(y1, y2), 0, height);
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

export function screenshotSceneBounds(rect, transform = [1, 0, 0, 1, 0, 0]) {
  const [a, b, c, d, e, f] = transform.map(Number);
  const det = a * d - b * c;
  if (![a, b, c, d, e, f].every(Number.isFinite) || !Number.isFinite(det) || Math.abs(det) < 1e-9) {
    throw new Error('Не удалось определить положение скриншота');
  }
  const toScene = (x, y) => ({
    x: (d * (x - e) - c * (y - f)) / det,
    y: (a * (y - f) - b * (x - e)) / det,
  });
  const first = toScene(rect.left, rect.top);
  const second = toScene(rect.right, rect.bottom);
  const left = Math.min(first.x, second.x);
  const top = Math.min(first.y, second.y);
  const width = Math.abs(second.x - first.x);
  const height = Math.abs(second.y - first.y);
  return { left, top, width, height, centerX: left + width / 2, centerY: top + height / 2 };
}

export function captureBoardScreenshot(canvas, viewportRect, { doc = globalThis.document, maxSide = MAX_SCREENSHOT_SIDE } = {}) {
  const framebuffer = canvas?.lowerCanvasEl;
  const viewportWidth = Number(canvas?.getWidth?.());
  const viewportHeight = Number(canvas?.getHeight?.());
  if (!framebuffer || !viewportWidth || !viewportHeight) throw new Error('Холст для скриншота недоступен');
  const rect = normalizeScreenshotRect(
    { x: viewportRect?.left, y: viewportRect?.top },
    { x: viewportRect?.right, y: viewportRect?.bottom },
    { width: viewportWidth, height: viewportHeight },
  );
  if (!rect || rect.width < MIN_SCREENSHOT_SIDE || rect.height < MIN_SCREENSHOT_SIDE) return null;

  // Fabric's backing canvas uses capped devicePixelRatio. Crop in its physical
  // pixels, not viewport CSS pixels, so text and vector paths stay sharp.
  const scaleX = framebuffer.width / viewportWidth;
  const scaleY = framebuffer.height / viewportHeight;
  const sourceX = rect.left * scaleX;
  const sourceY = rect.top * scaleY;
  const sourceWidth = rect.width * scaleX;
  const sourceHeight = rect.height * scaleY;
  if (!(sourceWidth > 0 && sourceHeight > 0)) throw new Error('Не удалось прочитать область доски');
  const ratio = Math.min(1, maxSide / sourceWidth, maxSide / sourceHeight);
  const bitmap = doc?.createElement?.('canvas');
  if (!bitmap) throw new Error('Браузер не поддерживает создание скриншота');
  bitmap.width = Math.max(1, Math.round(sourceWidth * ratio));
  bitmap.height = Math.max(1, Math.round(sourceHeight * ratio));
  const context = bitmap.getContext?.('2d', { alpha: false });
  if (!context) throw new Error('Браузер не поддерживает создание скриншота');
  context.drawImage(framebuffer, sourceX, sourceY, sourceWidth, sourceHeight,
    0, 0, bitmap.width, bitmap.height);
  return {
    bitmap,
    viewportRect: rect,
    sceneRect: screenshotSceneBounds(rect, canvas.viewportTransform),
  };
}

export function screenshotCanvasToBlob(bitmap) {
  return new Promise((resolve, reject) => {
    try {
      bitmap.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Не удалось создать скриншот'));
      }, 'image/png');
    } catch (error) {
      reject(error);
    }
  });
}
