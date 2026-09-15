// Preserve the side-by-side desktop layout. A dock touching the viewport edge
// has no room for the history capsule: clamping its left coordinate alone would
// put Undo directly on top of Selection. Use a separate contextual row instead.
export function historyDockPlacement({ dock, mode = '1', viewport, context = [], size = {} }) {
  const margin = 6;
  const gap = 8;
  const width = Math.max(70, Number(size.width) || 0);
  const height = Math.max(36, Number(size.height) || 0);
  if (mode === '3' || dock.left - width - gap >= margin) return null;
  const left = Math.max(margin, Math.min(dock.left, viewport.width - width - margin));
  const blockers = context.filter((rect) => rect.width > 0 && rect.height > 0
    && rect.left < left + width && rect.left + rect.width > left);
  const edge = mode === '2'
    ? Math.max(dock.top + dock.height, ...blockers.map((rect) => rect.top + rect.height))
    : Math.min(dock.top, ...blockers.map((rect) => rect.top));
  const top = mode === '2' ? edge + gap : edge - height - gap;
  return { left, top: Math.max(margin, Math.min(top, viewport.height - height - margin)), width, height };
}
