export const BOARD_CONTROL_EVENTS = new Set([
  'mode',
  'background-live',
  'lock',
  'view-jump',
  'view-request',
  'game-library-visibility',
  'selection-transaction',
]);

export function normalizeBoardControl(event, payload = {}) {
  const safeEvent = String(event ?? '').trim();
  if (!BOARD_CONTROL_EVENTS.has(safeEvent)) {
    throw new Error(`Unsupported board control event: ${safeEvent}`);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Board control payload must be an object');
  }
  return { event: safeEvent, payload };
}
