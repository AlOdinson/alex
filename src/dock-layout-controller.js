export const DOCK_LAYOUT_STORAGE_KEY = 'alex-board:dock-layout:v1';
export const DOCK_LAYOUT_CHANGE_EVENT = 'alex-board:dock-layout-change';

const VALID_MODES = new Set(['1', '2', '3']);
const NEXT_MODE = { 1: '2', 2: '3', 3: '1' };
const DIRECTION = { 1: 'above', 2: 'below', 3: 'right' };

export function normalizeDockLayoutMode(value) {
  const mode = String(value ?? '');
  return VALID_MODES.has(mode) ? mode : '1';
}

export function nextDockLayoutMode(mode) {
  return NEXT_MODE[normalizeDockLayoutMode(mode)];
}

export function contextualDirectionForMode(mode) {
  return DIRECTION[normalizeDockLayoutMode(mode)];
}

export function getDockLayoutMode(doc = document) {
  return normalizeDockLayoutMode(doc?.documentElement?.dataset?.dockLayout);
}

function readStoredMode(storage) {
  try { return normalizeDockLayoutMode(storage?.getItem?.(DOCK_LAYOUT_STORAGE_KEY)); }
  catch { return '1'; }
}

function persistMode(storage, mode) {
  try { storage?.setItem?.(DOCK_LAYOUT_STORAGE_KEY, mode); }
  catch { /* session-only fallback */ }
}

function emitLayoutChange(doc, mode) {
  const detail = { mode, direction: contextualDirectionForMode(mode) };
  const event = typeof CustomEvent === 'function'
    ? new CustomEvent(DOCK_LAYOUT_CHANGE_EVENT, { detail })
    : { type: DOCK_LAYOUT_CHANGE_EVENT, detail };
  doc?.dispatchEvent?.(event);
}

export function setDockLayoutMode(mode, { doc = document, storage = globalThis.localStorage } = {}) {
  const normalized = normalizeDockLayoutMode(mode);
  if (doc?.documentElement?.dataset) doc.documentElement.dataset.dockLayout = normalized;
  persistMode(storage, normalized);
  emitLayoutChange(doc, normalized);
  return normalized;
}

export function advanceDockLayoutMode({ doc = document, storage = globalThis.localStorage } = {}) {
  return setDockLayoutMode(nextDockLayoutMode(getDockLayoutMode(doc)), { doc, storage });
}

export function initializeDockLayout({ doc = document, storage = globalThis.localStorage } = {}) {
  const mode = readStoredMode(storage);
  if (doc?.documentElement?.dataset) doc.documentElement.dataset.dockLayout = mode;
  return mode;
}

if (typeof document !== 'undefined') initializeDockLayout();
