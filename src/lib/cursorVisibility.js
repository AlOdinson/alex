// Convert DOM client rectangles through the complete Fabric viewport transform.
export function screenRectToSceneRect(rect, canvasRect, viewport) {
  const [a, b, c, d, e, f] = viewport ?? [1, 0, 0, 1, 0, 0];
  const determinant = a * d - b * c;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-10) return null;
  const points = [[rect.left, rect.top], [rect.right, rect.top], [rect.right, rect.bottom], [rect.left, rect.bottom]]
    .map(([x, y]) => {
      const dx = x - canvasRect.left - e;
      const dy = y - canvasRect.top - f;
      return { x: (d * dx - c * dy) / determinant, y: (-b * dx + a * dy) / determinant };
    });
  const left = Math.min(...points.map(p => p.x));
  const top = Math.min(...points.map(p => p.y));
  const right = Math.max(...points.map(p => p.x));
  const bottom = Math.max(...points.map(p => p.y));
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

// A crowded intersection must not make cursor decoration block drawing. If more
// than eight nearby candidates remain, prefer fading to an unbounded pixel scan.
export function boundedCursorIntersection(candidates, preciseIntersection) {
  for (let index = 0; index < Math.min(8, candidates.length); index++) {
    if (preciseIntersection(candidates[index])) return true;
  }
  return candidates.length > 8;
}

export function createCursorVisibilityController({ root, getCanvasRect, getViewport, intersects,
  requestFrame = callback => requestAnimationFrame(callback),
  cancelFrame = id => cancelAnimationFrame(id), now = () => performance.now() }) {
  let frame = null;
  let motionUntil = 0;
  let revision = 0;
  let disposed = false;
  const cache = new WeakMap();
  function update() {
    frame = null;
    if (disposed) return;
    const canvasRect = getCanvasRect();
    const viewport = getViewport();
    // Read every label/arrow first, then write opacity. No interleaved layout writes.
    const measurements = [...root.querySelectorAll('.remote-cursor')].map(element => ({ element,
      rects: [...element.querySelectorAll('.remote-cursor-arrow, .remote-cursor-name')]
        .map(part => part.getBoundingClientRect()).filter(rect => rect.width && rect.height),
    }));
    for (const { element, rects } of measurements) {
      const key = [revision, ...viewport, canvasRect.left, canvasRect.top,
        ...rects.flatMap(rect => [rect.left, rect.top, rect.right, rect.bottom])].join(':');
      let entry = cache.get(element);
      if (entry?.key !== key) {
        const overlap = rects.some(rect => {
          const sceneRect = screenRectToSceneRect(rect, canvasRect, viewport);
          return sceneRect && intersects(sceneRect);
        });
        entry = { key, overlap };
        cache.set(element, entry);
      }
      const next = String(entry.overlap);
      if (element.dataset.overlap !== next) element.dataset.overlap = next;
    }
    // Follow the existing 50ms cursor CSS transition, then stop completely.
    if (measurements.length && now() < motionUntil) frame = requestFrame(update);
  }
  return {
    refresh({ motion = false, invalidate = false } = {}) {
      if (disposed) return;
      if (invalidate) revision++;
      if (motion) motionUntil = now() + 70;
      if (frame == null) frame = requestFrame(update);
    },
    dispose() {
      disposed = true;
      if (frame != null) cancelFrame(frame);
      frame = null;
    },
  };
}
