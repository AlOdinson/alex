import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActiveSelection,
  Canvas,
  Control,
  FabricImage,
  FabricObject,
  Group,
  IText,
  Line,
  Path,
  Rect,
  Text,
  Textbox,
  PencilBrush,
  Point,
  util,
} from 'fabric';
import Toolbar from './Toolbar.jsx';
import ShareDialog from './ShareDialog.jsx';
import GameLibrary from './GameLibrary.jsx';
import {
  applyActionsToSnapshot,
  applyOpsToSnapshot,
  getBoardAccess,
  getBoardChanges,
  getBoardRecovery,
  getBoardRevision,
  isSupabaseConfigured,
  saveBoardSnapshot,
  setGameLibraryVisibility,
  setGuestMode,
} from '../lib/boardRepository.js';
import {
  getCachedSnapshot,
  getConfirmedActionsAfter,
  getCrossBoardClipboard,
  getPendingActions,
  pruneConfirmedActionsThrough,
  setCachedSnapshot,
  setCrossBoardClipboard,
} from '../lib/idb.js';
import { connectBoardRealtime } from '../lib/realtime.js';
import { forceExitGameParticipants } from '../lib/gameRealtime.js';
import { randomToken } from '../lib/ids.js';
import { getOwnedBoard, rememberOwnedBoard } from '../lib/boardLibrary.js';
import { createShape } from '../lib/shapes.js';
import {
  isRealtimeMutationCausallyStale,
  normalizeRealtimeBaseRevision,
  shouldRejectRealtimeObjectFrame,
} from '../lib/convergence.js';
import {
  applySerializedObjectPatch,
  createRecordPatchOps,
} from '../lib/operationProtocol.js';
import {
  copySerializedBoardImages,
  isAcceptedImageFile,
  loadImageElement,
  preloadSerializedImages,
  storeBoardImage,
} from '../lib/imageStorage.js';
import {
  copyCanvasPng,
  downloadCanvasPdf,
  downloadCanvasPng,
  renderFabricCanvas,
  shareCanvasPng,
} from '../lib/exportBoard.js';

const BACKGROUNDS = new Set(['grid', 'dots', 'blank']);
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 4;
const MAX_CANVAS_PIXEL_RATIO = 2;
const DURABLE_OP_CHUNK_TARGET = 150_000;
const HISTORY_LIMIT = 100;
const LIVE_TRANSFORM_INTERVAL = 50;
const LIVE_TRANSFORM_LOCK_TTL = 7000;
const DESKTOP_WHEEL_ZOOM_SPEED = 6.25;
const VIEW_BROADCAST_INTERVAL = 80;
const INSURANCE_SYNC_INTERVAL = 30_000;
const INSURANCE_SYNC_PAGE_SIZE = 500;
const TARGETED_RECONCILE_DELAY = 180;
const TARGETED_RECONCILE_RETRY_DELAY = 240;
const TARGETED_RECONCILE_MAX_WAIT_ATTEMPTS = 32;
const LOCAL_LOCK_REFRESH_INTERVAL = 2_500;
const IMAGE_RETRY_INTERVAL = 5_000;
const SNAPSHOT_COMPACTION_IDLE_MS = 30_000;
const PEN_TRANSFORM_PATCH_PADDING = 18;
const PEN_TRANSFORM_CONTROLS_PADDING = 92;
const PEN_TRANSFORM_SPATIAL_CELL_SIZE = 256;
const PEN_TRANSFORM_SPATIAL_GLOBAL_CELL_LIMIT = 96;
const PENCIL_TOUCH_GRACE_MS = 240;
const TOUCH_GESTURE_ARM_MS = 80;
const TOUCH_GESTURE_MOVE_THRESHOLD = 6;
const PALM_CONTACT_RADIUS = 22;
const PENCIL_HANDOFF_IDLE_MS = 18;
const PENCIL_HANDOFF_MAX_RADIUS = 34;
const PENCIL_HANDOFF_MIN_SEPARATION = 20;
const DRAWING_STYLE_TOOL_IDS = new Set(['pencil', 'line', 'shape']);

function isPhoneSizedTouchViewport() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  if (Number(navigator.maxTouchPoints ?? 0) <= 0) return false;
  const viewport = window.visualViewport;
  const width = Number(viewport?.width ?? window.innerWidth ?? 0);
  const height = Number(viewport?.height ?? window.innerHeight ?? 0);
  return Math.min(width, height) <= 600;
}

function autopilotZoomForCurrentDevice(requestedZoom) {
  const numericZoom = Number(requestedZoom);
  if (!Number.isFinite(numericZoom)) return requestedZoom;
  return isPhoneSizedTouchViewport() ? numericZoom * 0.5 : numericZoom;
}
const DEFAULT_DRAWING_STYLES = {
  pencil: { color: '#111827', opacity: 1, width: 3 },
  line: { color: '#111827', opacity: 1, width: 3 },
  shape: { color: '#111827', opacity: 1, width: 3 },
};
const COMPACT_KEYBOARD_ROWS = {
  en: ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'],
  ru: ['йцукенгшщзхъ', 'фывапролджэ', 'ячсмитьбю'],
};
const COMPACT_KEYBOARD_SYMBOLS = ['.', ',', '-', '+', '=', '(', ')', '?', '!', ':'];

FabricObject.customProperties = [
  'boardObjectId',
  'updatedAt',
  'updatedBy',
  'isEraserPath',
  'objectKind',
  'storagePath',
  'pendingImage',
  'pendingImageSerialized',
  'transientPreview',
  'transientLiveDraw',
  'transientAwaitingCommit',
  'previewReceivedAt',
  'creationSessionId',
  'creationClientId',
  'transientTransformFallback',
  'transientSelectionProxy',
  'selectionTransactionId',
  'selectionSourceIds',
  'textPlaceholder',
];

function getKeyFromUrl() {
  return new URLSearchParams(window.location.search).get('key') ?? '';
}

function listLikeValues(list) {
  if (!list) return [];
  try {
    return Array.from(list);
  } catch {
    const values = [];
    const length = Math.max(0, Number(list.length ?? 0));
    for (let index = 0; index < length; index += 1) {
      const value = list[index] ?? list.item?.(index);
      if (value != null) values.push(value);
    }
    return values;
  }
}

function droppedFilesFromDataTransfer(dataTransfer) {
  if (!dataTransfer) return [];
  const files = listLikeValues(dataTransfer.files).filter(Boolean);

  // Safari may expose Finder files through DataTransferItemList while keeping
  // dataTransfer.files empty until the drop event. Read both collections and
  // de-duplicate them without relying on iterable DOM-list support.
  for (const item of listLikeValues(dataTransfer.items)) {
    if (item?.kind !== 'file') continue;
    try {
      const file = item.getAsFile?.();
      if (file) files.push(file);
    } catch {
      // Ignore one inaccessible item and continue with the remaining files.
    }
  }

  const seen = new Set();
  return files.filter((file) => {
    const signature = [
      file?.name ?? '',
      Number(file?.size ?? -1),
      Number(file?.lastModified ?? -1),
      file?.type ?? '',
    ].join(':');
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });
}

function dataTransferMayContainFiles(dataTransfer) {
  if (!dataTransfer) return false;
  if (listLikeValues(dataTransfer.files).length) return true;
  if (listLikeValues(dataTransfer.items).some((item) => item?.kind === 'file')) return true;

  const types = listLikeValues(dataTransfer.types)
    .map((type) => String(type).toLowerCase());
  if (!types.length) return true; // Safari can hide drag types until drop.
  return types.some((type) => (
    type === 'files'
    || type.includes('file')
    || type.startsWith('image/')
    || type === 'public.image'
  ));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function serializedCharSize(value) {
  try {
    return JSON.stringify(value).length;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function splitDurableOperations(ops, targetChars = DURABLE_OP_CHUNK_TARGET) {
  const source = Array.isArray(ops) ? ops.filter(Boolean) : [];
  if (!source.length) return [];
  const chunks = [];
  let chunk = [];
  let chunkSize = 2;
  for (const op of source) {
    const opSize = serializedCharSize(op) + 1;
    if (chunk.length && chunkSize + opSize > targetChars) {
      chunks.push(chunk);
      chunk = [];
      chunkSize = 2;
    }
    chunk.push(op);
    chunkSize += opSize;
  }
  if (chunk.length) chunks.push(chunk);
  return chunks;
}

function compactTransformMatrix(matrix) {
  if (!Array.isArray(matrix) || matrix.length !== 6) return null;
  const compact = matrix.map((value) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Number(numeric.toFixed(5)) : null;
  });
  return compact.every((value) => value !== null) ? compact : null;
}

function multiplyTransformMatrices2d(left, right) {
  if (!Array.isArray(left) || left.length !== 6 || !Array.isArray(right) || right.length !== 6) return null;
  const [a1, b1, c1, d1, e1, f1] = left.map(Number);
  const [a2, b2, c2, d2, e2, f2] = right.map(Number);
  const result = [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
  return compactTransformMatrix(result);
}

function invertTransformMatrix2d(matrix) {
  if (!Array.isArray(matrix) || matrix.length !== 6) return null;
  const [a, b, c, d, e, f] = matrix.map(Number);
  const determinant = a * d - b * c;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-10) return null;
  return compactTransformMatrix([
    d / determinant,
    -b / determinant,
    -c / determinant,
    a / determinant,
    (c * f - d * e) / determinant,
    (b * e - a * f) / determinant,
  ]);
}

function boardObjectsById(canvas, objectId) {
  if (!canvas || !objectId) return [];
  return canvas.getObjects().filter((object) => object.boardObjectId === objectId);
}

function removeBoardObjectsById(canvas, objectId) {
  const matches = boardObjectsById(canvas, objectId);
  matches.forEach((object) => canvas.remove(object));
  return matches;
}

function removeTransientDrawPreviewsBySession(canvas, clientId, sessionId) {
  if (!canvas || !sessionId) return [];
  const matches = canvas.getObjects().filter((object) => (
    object.transientPreview
    && object.creationSessionId === sessionId
    && (!clientId || !object.creationClientId || object.creationClientId === clientId)
  ));
  matches.forEach((object) => canvas.remove(object));
  return matches;
}

function boardObjectsByCreationSession(canvas, clientId, sessionId) {
  if (!canvas || !sessionId) return [];
  return canvas.getObjects().filter((object) => (
    object.creationSessionId === sessionId
    && (!clientId || !object.creationClientId || object.creationClientId === clientId)
  ));
}

function creationSessionRegistryKey(clientId, sessionId) {
  if (!sessionId) return '';
  return `${String(clientId ?? '')}:${String(sessionId)}`;
}

function removeBoardObjectsByCreationSession(canvas, clientId, sessionId, keep = null) {
  const matches = boardObjectsByCreationSession(canvas, clientId, sessionId);
  matches.forEach((object) => {
    if (object !== keep) canvas.remove(object);
  });
  return matches.filter((object) => object !== keep);
}

function removeTransientPreviewsForAuthoritativeObjects(canvas, objects) {
  if (!canvas || !Array.isArray(objects)) return 0;
  let removed = 0;
  const sessions = objects
    .filter((object) => object && !object.transientPreview && object.creationSessionId)
    .map((object) => ({
      sessionId: object.creationSessionId,
      clientId: object.creationClientId ?? '',
    }));
  if (!sessions.length) return 0;
  for (const object of [...canvas.getObjects()]) {
    if (!object.transientPreview || !object.creationSessionId) continue;
    const matches = sessions.some((session) => (
      session.sessionId === object.creationSessionId
      && (!session.clientId || !object.creationClientId || session.clientId === object.creationClientId)
    ));
    if (!matches) continue;
    canvas.remove(object);
    removed += 1;
  }
  return removed;
}

function deduplicateBoardObjects(canvas) {
  if (!canvas) return 0;

  const chooseKeep = (objects) => [...objects].sort((left, right) => {
    const leftAuthoritative = left.transientPreview || left.transientTransformFallback ? 0 : 1;
    const rightAuthoritative = right.transientPreview || right.transientTransformFallback ? 0 : 1;
    if (leftAuthoritative !== rightAuthoritative) return rightAuthoritative - leftAuthoritative;
    return Number(right.updatedAt ?? right.previewReceivedAt ?? 0)
      - Number(left.updatedAt ?? left.previewReceivedAt ?? 0);
  })[0];

  let removed = 0;
  const removedObjects = new Set();
  const idBuckets = new Map();

  for (const object of canvas.getObjects()) {
    if (!object.boardObjectId) continue;
    const key = String(object.boardObjectId);
    const bucket = idBuckets.get(key) ?? [];
    bucket.push(object);
    idBuckets.set(key, bucket);
  }

  // A stable boardObjectId must identify exactly one visible object.
  for (const objects of idBuckets.values()) {
    const available = objects.filter((object) => !removedObjects.has(object));
    if (available.length < 2) continue;
    const keep = chooseKeep(available);
    available.forEach((object) => {
      if (object === keep) return;
      canvas.remove(object);
      removedObjects.add(object);
      removed += 1;
    });
  }

  const sessionBuckets = new Map();
  for (const object of canvas.getObjects()) {
    if (!object.creationSessionId || removedObjects.has(object)) continue;
    const key = `${object.creationClientId ?? ''}:${object.creationSessionId}`;
    const bucket = sessionBuckets.get(key) ?? [];
    bucket.push(object);
    sessionBuckets.set(key, bucket);
  }

  // creationSessionId is only a replacement hint for a temporary preview and its
  // authoritative object. It is not a generic group id. A selection transaction can
  // intentionally contain many different objects, so those siblings must never be
  // collapsed into one object merely because they belong to the same transaction.
  for (const objects of sessionBuckets.values()) {
    const available = objects.filter((object) => !removedObjects.has(object));
    if (available.length < 2) continue;

    const uniqueIds = new Set(available.map((object) => object.boardObjectId).filter(Boolean).map(String));
    const transactionIds = new Set(
      available.map((object) => object.selectionTransactionId).filter(Boolean).map(String),
    );
    const intentionalSelectionBatch = uniqueIds.size > 1 && transactionIds.size === 1;
    if (intentionalSelectionBatch) continue;

    const hasTransient = available.some((object) => (
      object.transientPreview || object.transientTransformFallback
    ));
    const hasAuthoritative = available.some((object) => (
      !object.transientPreview && !object.transientTransformFallback
    ));
    if (!hasTransient || (!hasAuthoritative && uniqueIds.size > 1)) continue;

    const keep = chooseKeep(available);
    available.forEach((object) => {
      if (object === keep) return;
      canvas.remove(object);
      removedObjects.add(object);
      removed += 1;
    });
  }

  return removed;
}

function removeTransientPreviewsByClient(canvas, clientId, { includeLive = false, keep = new Set() } = {}) {
  if (!canvas || !clientId) return 0;
  let removed = 0;
  for (const object of [...canvas.getObjects()]) {
    if (!object.transientPreview || keep.has(object)) continue;
    if (object.creationClientId && object.creationClientId !== clientId) continue;
    if (!includeLive && object.transientLiveDraw) continue;
    canvas.remove(object);
    removed += 1;
  }
  return removed;
}

function removeSelectionTransactionObjects(canvas, transactionId) {
  if (!canvas || !transactionId) return [];
  const matches = canvas.getObjects().filter((object) => (
    object.selectionTransactionId === transactionId
    && (object.transientSelectionProxy || object.transientPreview)
  ));
  matches.forEach((object) => canvas.remove(object));
  return matches;
}

function transformMatrixDistance(left, right) {
  const a = compactTransformMatrix(left);
  const b = compactTransformMatrix(right);
  if (!a || !b) return Number.POSITIVE_INFINITY;
  const linear = Math.hypot(
    (a[0] - b[0]) * 80,
    (a[1] - b[1]) * 80,
    (a[2] - b[2]) * 80,
    (a[3] - b[3]) * 80,
  );
  const translation = Math.hypot(a[4] - b[4], a[5] - b[5]);
  return linear + translation;
}


const SELECTION_MOVE_CONTROL_KEY = 'selectionMoveHandle';
const SELECTION_MOVE_HANDLE_OFFSET = 52;

function renderSelectionMoveHandle(context, left, top) {
  context.save();
  context.translate(left, top);

  // High-contrast white badge keeps the black hand readable above any board content.
  context.beginPath();
  context.arc(0, 0, 17, 0, Math.PI * 2);
  context.fillStyle = '#ffffff';
  context.fill();
  context.lineWidth = 2;
  context.strokeStyle = '#111111';
  context.stroke();

  context.fillStyle = '#111111';
  context.strokeStyle = '#111111';
  context.lineCap = 'round';
  context.lineJoin = 'round';

  // Palm and wrist.
  context.beginPath();
  context.moveTo(-7, -2);
  context.quadraticCurveTo(-8, -1, -8, 2);
  context.lineTo(-7, 8);
  context.quadraticCurveTo(-6, 11, -2, 12);
  context.lineTo(4, 12);
  context.quadraticCurveTo(8, 11, 9, 7);
  context.lineTo(9, -1);
  context.quadraticCurveTo(9, -4, 6, -4);
  context.lineTo(-4, -4);
  context.quadraticCurveTo(-6, -4, -7, -2);
  context.closePath();
  context.fill();

  // Four raised fingers. Rounded strokes form a compact monochrome hand silhouette.
  context.lineWidth = 3.4;
  [
    [-5.5, -3, -5.5, -10],
    [-1.7, -3, -1.7, -12],
    [2.1, -3, 2.1, -11],
    [5.9, -3, 5.9, -8.5],
  ].forEach(([x1, y1, x2, y2]) => {
    context.beginPath();
    context.moveTo(x1, y1);
    context.lineTo(x2, y2);
    context.stroke();
  });

  // Thumb.
  context.lineWidth = 3.8;
  context.beginPath();
  context.moveTo(-6.5, 1.5);
  context.lineTo(-11, -2.5);
  context.stroke();

  context.restore();
}

function moveSelectionFromHandle(eventData, transform, x, y) {
  const target = transform?.target;
  if (!isActiveSelectionObject(target)) return false;

  const previousLeft = Number(target.left ?? 0);
  const previousTop = Number(target.top ?? 0);
  const offsetX = Number(transform?.offsetX ?? 0);
  const offsetY = Number(transform?.offsetY ?? 0);
  const nextLeft = target.lockMovementX ? previousLeft : Number(x) - offsetX;
  const nextTop = target.lockMovementY ? previousTop : Number(y) - offsetY;
  const movedX = Number.isFinite(nextLeft) && Math.abs(nextLeft - previousLeft) > 0.0001;
  const movedY = Number.isFinite(nextTop) && Math.abs(nextTop - previousTop) > 0.0001;
  if (!movedX && !movedY) return false;

  target.set({
    left: movedX ? nextLeft : previousLeft,
    top: movedY ? nextTop : previousTop,
  });
  // Fabric does not reliably refresh ActiveSelection control coordinates while a
  // custom control actionHandler is running. Keep the whole outer frame, rotation
  // square and hand handle attached to the moving selection on every Pencil frame.
  target.setCoords?.();
  const moveTick = target.canvas?.__alexSelectionMoveTick;
  if (typeof moveTick === 'function') {
    moveTick({ target, e: eventData, transform });
  }
  return true;
}

const selectionMoveControl = new Control({
  x: 0,
  y: 0.5,
  offsetY: SELECTION_MOVE_HANDLE_OFFSET,
  withConnection: true,
  actionName: 'drag',
  cursorStyle: 'move',
  sizeX: 40,
  sizeY: 40,
  touchSizeX: 56,
  touchSizeY: 56,
  actionHandler: moveSelectionFromHandle,
  render: renderSelectionMoveHandle,
});

function installSelectionMoveHandle(selection) {
  if (!isActiveSelectionObject(selection) || typeof selection.getObjects !== 'function') return;
  if (selection.getObjects().filter(Boolean).length < 2) return;
  if (selection.controls?.[SELECTION_MOVE_CONTROL_KEY] === selectionMoveControl) return;
  selection.controls = {
    ...selection.controls,
    [SELECTION_MOVE_CONTROL_KEY]: selectionMoveControl,
  };
}

function createOuterOnlyActiveSelection(objects, canvas) {
  const members = Array.isArray(objects) ? objects.filter(Boolean) : [];
  const selection = new ActiveSelection(members, {
    canvas,
    hasBorders: true,
    hasControls: true,
    subTargetCheck: false,
    objectCaching: false,
  });
  const outerRenderer = FabricObject.prototype._renderControls;
  if (typeof outerRenderer === 'function') {
    selection._renderControls = function renderOuterSelectionOnly(context, styleOverride) {
      return outerRenderer.call(this, context, styleOverride);
    };
  }
  installSelectionMoveHandle(selection);
  selection.setCoords();
  return selection;
}

function hexToRgba(hex, opacity) {
  const normalized = hex.replace('#', '');
  const value = Number.parseInt(normalized.length === 3
    ? normalized.split('').map((character) => character + character).join('')
    : normalized, 16);
  const red = (value >> 16) & 255;
  const green = (value >> 8) & 255;
  const blue = value & 255;
  return `rgba(${red}, ${green}, ${blue}, ${clamp(opacity, 0.05, 1)})`;
}

function rgbaToHex(input) {
  if (typeof input !== 'string') return null;
  const value = input.trim();
  if (!value) return null;
  if (value.startsWith('#')) {
    const hex = value.slice(1);
    if (hex.length === 3) return `#${hex.split('').map((c) => c + c).join('')}`.toLowerCase();
    if (hex.length >= 6) return `#${hex.slice(0, 6)}`.toLowerCase();
    return null;
  }
  const match = value.match(/rgba?\(([^)]+)\)/i);
  if (!match) return null;
  const [red, green, blue] = match[1].split(',').map((part) => Number.parseFloat(part.trim()));
  if ([red, green, blue].some((channel) => Number.isNaN(channel))) return null;
  return `#${[red, green, blue].map((channel) => Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, '0')).join('')}`;
}

function alphaFromColor(input) {
  if (typeof input !== 'string') return null;
  const value = input.trim();
  if (!value) return null;
  const match = value.match(/rgba?\(([^)]+)\)/i);
  if (!match) return value.startsWith('#') ? 1 : null;
  const parts = match[1].split(',').map((part) => part.trim());
  if (parts.length < 4) return 1;
  const alpha = Number.parseFloat(parts[3]);
  return Number.isNaN(alpha) ? 1 : clamp(alpha, 0.05, 1);
}

function isTextObject(object) {
  return object?.type === 'i-text' || object?.type === 'text' || object?.type === 'textbox' || object?.objectKind === 'text';
}

function isImageObject(object) {
  return object?.type === 'image' || object?.objectKind === 'image';
}

// Apply one rendering policy to every current and future vector object. Fabric can
// otherwise reuse a bitmap cache while the viewport is zoomed, which makes paths,
// text and grouped shapes look soft at small zoom levels. Raster images keep their
// native source resolution, but any vector/group wrapper is rendered from geometry.
function applySharpRenderingPolicy(object, visited = new Set()) {
  if (!object || visited.has(object)) return object;
  visited.add(object);

  const children = typeof object.getObjects === 'function' ? object.getObjects() : [];
  children.forEach((child) => applySharpRenderingPolicy(child, visited));
  if (object.clipPath) applySharpRenderingPolicy(object.clipPath, visited);

  // Keep line/stroke thickness visually constant while the object geometry is scaled.
  // This applies to existing objects loaded from the board as well as newly-created
  // vector objects that pass through mark/register.
  if (object.stroke != null && Number(object.strokeWidth ?? 0) > 0) {
    object.strokeUniform = true;
  }

  if (!isImageObject(object)) {
    object.objectCaching = false;
    object.noScaleCache = false;
    object.dirty = true;
  }
  return object;
}

function sampleImagePixelColor(imageObject, scenePoint) {
  if (!isImageObject(imageObject) || !scenePoint) return null;
  try {
    const element = imageObject.getElement?.();
    if (!element) return null;
    const width = Math.max(1, Number(imageObject.width ?? element.naturalWidth ?? element.width ?? 1));
    const height = Math.max(1, Number(imageObject.height ?? element.naturalHeight ?? element.height ?? 1));
    const inverse = util.invertTransform(imageObject.calcTransformMatrix());
    const local = util.transformPoint(scenePoint, inverse);
    const normalizedX = clamp((local.x + width / 2) / width, 0, 0.999999);
    const normalizedY = clamp((local.y + height / 2) / height, 0, 0.999999);
    const cropX = Number(imageObject.cropX ?? 0);
    const cropY = Number(imageObject.cropY ?? 0);
    const sourceX = cropX + normalizedX * width;
    const sourceY = cropY + normalizedY * height;

    const scratch = document.createElement('canvas');
    scratch.width = 1;
    scratch.height = 1;
    const context = scratch.getContext('2d', { willReadFrequently: true });
    if (!context) return null;
    context.clearRect(0, 0, 1, 1);
    context.drawImage(element, sourceX, sourceY, 1, 1, 0, 0, 1, 1);
    const [red, green, blue, alphaByte] = context.getImageData(0, 0, 1, 1).data;
    const combinedAlpha = clamp((alphaByte / 255) * Number(imageObject.opacity ?? 1), 0, 1);
    const visibleRed = Math.round(red * combinedAlpha + 255 * (1 - combinedAlpha));
    const visibleGreen = Math.round(green * combinedAlpha + 255 * (1 - combinedAlpha));
    const visibleBlue = Math.round(blue * combinedAlpha + 255 * (1 - combinedAlpha));
    return `#${[visibleRed, visibleGreen, visibleBlue]
      .map((channel) => channel.toString(16).padStart(2, '0'))
      .join('')}`;
  } catch (error) {
    console.warn('Не удалось взять цвет пикселя изображения', error);
    return null;
  }
}

function forEachStyleTarget(object, callback) {
  if (!object) return;
  if (object.type === 'group' && typeof object.getObjects === 'function') {
    object.getObjects().forEach((child) => callback(child));
    return;
  }
  callback(object);
}

function probeObjectStyle(object) {
  if (!object || object.isEraserPath) {
    return {
      canColor: false,
      canOpacity: false,
      canWidth: false,
      color: null,
      opacity: null,
      width: null,
    };
  }

  let canColor = false;
  let canOpacity = false;
  let canWidth = false;
  let color = null;
  let opacity = null;
  let width = null;

  forEachStyleTarget(object, (target) => {
    if (target.isEraserPath) return;
    const strokeColor = typeof target.stroke === 'string' ? target.stroke : null;
    const fillColor = typeof target.fill === 'string' ? target.fill : null;
    const effectiveColor = isTextObject(target) ? fillColor : (strokeColor || fillColor);

    if (!canColor && effectiveColor) {
      const parsedHex = rgbaToHex(effectiveColor);
      if (parsedHex) {
        color = parsedHex;
        canColor = true;
      }
    }

    if (!canOpacity) {
      if (target.objectKind === 'image' || target.type === 'image') {
        opacity = clamp(Number(target.opacity ?? 1), 0.05, 1);
        canOpacity = true;
      } else if (effectiveColor) {
        opacity = alphaFromColor(effectiveColor) ?? clamp(Number(target.opacity ?? 1), 0.05, 1);
        canOpacity = true;
      }
    }

    if (!canWidth && Number.isFinite(Number(target.strokeWidth)) && (target.stroke || target.type === 'line' || target.objectKind === 'shape' || target.objectKind === 'path')) {
      width = Number(target.strokeWidth);
      canWidth = true;
    }
  });

  return {
    canColor,
    canOpacity,
    canWidth,
    color,
    opacity,
    width,
  };
}

function applySampledStyleToObject(object, sampled, { colorOnly = false } = {}) {
  if (!object || object.isEraserPath || !sampled) return false;
  let changed = false;

  forEachStyleTarget(object, (target) => {
    if (target.isEraserPath) return;
    const image = isImageObject(target);
    const currentStyle = probeObjectStyle(target);
    const sampledOpacity = !colorOnly && sampled.canOpacity && Number.isFinite(sampled.opacity)
      ? clamp(sampled.opacity, 0.05, 1)
      : null;
    const colorOpacity = sampledOpacity
      ?? (currentStyle.canOpacity && Number.isFinite(currentStyle.opacity)
        ? currentStyle.opacity
        : clamp(Number(target.opacity ?? 1), 0.05, 1));

    if (sampled.canColor && sampled.color && !image) {
      if (isTextObject(target)) {
        target.set('fill', hexToRgba(sampled.color, colorOpacity));
        changed = true;
      } else if (typeof target.stroke === 'string' || Number.isFinite(Number(target.strokeWidth))) {
        target.set('stroke', hexToRgba(sampled.color, colorOpacity));
        changed = true;
      } else if (typeof target.fill === 'string') {
        target.set('fill', hexToRgba(sampled.color, colorOpacity));
        changed = true;
      }
    }

    if (sampledOpacity != null) {
      if (image) {
        target.set('opacity', sampledOpacity);
        changed = true;
      } else if (isTextObject(target)) {
        const currentColor = sampled.color ?? rgbaToHex(target.fill) ?? '#111827';
        target.set('fill', hexToRgba(currentColor, sampledOpacity));
        changed = true;
      } else if (typeof target.stroke === 'string' || Number.isFinite(Number(target.strokeWidth))) {
        const currentColor = sampled.color ?? rgbaToHex(target.stroke) ?? rgbaToHex(target.fill) ?? '#111827';
        target.set('stroke', hexToRgba(currentColor, sampledOpacity));
        changed = true;
      } else if (typeof target.fill === 'string') {
        const currentColor = sampled.color ?? rgbaToHex(target.fill) ?? '#111827';
        target.set('fill', hexToRgba(currentColor, sampledOpacity));
        changed = true;
      }
    }

    if (!colorOnly && sampled.canWidth && Number.isFinite(sampled.width)
      && Number.isFinite(Number(target.strokeWidth)) && !image) {
      target.set('strokeWidth', clamp(Math.round(sampled.width), 1, 100));
      changed = true;
    }

    if (changed) {
      target.dirty = true;
      target.setCoords?.();
    }
  });

  if (changed) {
    object.dirty = true;
    object.setCoords();
  }
  return changed;
}

function NameGate({ title, onSubmit }) {
  const [name, setName] = useState('');

  return (
    <main className="gate-page">
      <section className="gate-card">
        <div className="brand-mark">A</div>
        <h1>{title}</h1>
        <p>Введите имя, которое увидит преподаватель.</p>
        <label className="field">
          <span>Ваше имя</span>
          <input
            autoFocus
            value={name}
            maxLength={40}
            placeholder="Например, Michael"
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && name.trim()) onSubmit(name.trim());
            }}
          />
        </label>
        <button
          type="button"
          className="primary-button"
          disabled={!name.trim()}
          onClick={() => onSubmit(name.trim())}
        >
          Войти на доску
        </button>
      </section>
    </main>
  );
}

function AccessMessage({ title, children }) {
  return (
    <main className="gate-page">
      <section className="gate-card">
        <div className="brand-mark">A</div>
        <h1>{title}</h1>
        <p>{children}</p>
        <a className="secondary-link" href={import.meta.env.BASE_URL}>На главную</a>
      </section>
    </main>
  );
}

function captureSerializedObjectTransform(object, fallback = {}) {
  if (!object) return {};

  // Members of an ActiveSelection keep local coordinates relative to the temporary
  // wrapper. Capture their complete scene transform without dismantling the selection.
  if (object.group && isActiveSelectionObject(object.group)
    && typeof object.calcTransformMatrix === 'function'
    && typeof util.qrDecompose === 'function') {
    const decomposed = util.qrDecompose(object.calcTransformMatrix());
    let scaleX = Number(decomposed?.scaleX ?? 1);
    let scaleY = Number(decomposed?.scaleY ?? 1);
    const flipX = scaleX < 0;
    const flipY = scaleY < 0;
    scaleX = Math.abs(scaleX);
    scaleY = Math.abs(scaleY);
    return {
      left: Number(decomposed?.translateX ?? fallback.left ?? 0),
      top: Number(decomposed?.translateY ?? fallback.top ?? 0),
      originX: 'center',
      originY: 'center',
      angle: Number(decomposed?.angle ?? 0),
      scaleX: Number.isFinite(scaleX) ? scaleX : 1,
      scaleY: Number.isFinite(scaleY) ? scaleY : 1,
      skewX: Number(decomposed?.skewX ?? 0),
      skewY: Number(decomposed?.skewY ?? 0),
      flipX,
      flipY,
    };
  }

  return {
    left: Number(object.left ?? fallback.left ?? 0),
    top: Number(object.top ?? fallback.top ?? 0),
    originX: object.originX ?? fallback.originX ?? 'left',
    originY: object.originY ?? fallback.originY ?? 'top',
    angle: Number(object.angle ?? fallback.angle ?? 0),
    scaleX: Number(object.scaleX ?? fallback.scaleX ?? 1),
    scaleY: Number(object.scaleY ?? fallback.scaleY ?? 1),
    skewX: Number(object.skewX ?? fallback.skewX ?? 0),
    skewY: Number(object.skewY ?? fallback.skewY ?? 0),
    flipX: Boolean(object.flipX),
    flipY: Boolean(object.flipY),
  };
}

function patchSerializedObjectTransform(serialized, object) {
  const next = { ...(serialized ?? {}) };
  Object.assign(next, captureSerializedObjectTransform(object, next));
  return next;
}

function serializeObject(object) {
  const serialized = object.toObject([
    'boardObjectId',
    'updatedAt',
    'updatedBy',
    'isEraserPath',
    'objectKind',
    'storagePath',
    'pendingImage',
    'creationSessionId',
    'creationClientId',
    'transientTransformFallback',
    'transientSelectionProxy',
    'selectionTransactionId',
    'selectionSourceIds',
  ]);
  return patchSerializedObjectTransform(serialized, object);
}

function isActiveSelectionObject(target) {
  if (!target) return false;
  if (target instanceof ActiveSelection) return true;
  if (typeof target.isType === 'function' && target.isType('ActiveSelection')) return true;
  return target.type === 'ActiveSelection' || target.type === 'activeSelection';
}

function flattenTarget(target) {
  if (!target) return [];
  if (isActiveSelectionObject(target) && typeof target.getObjects === 'function') {
    return target.getObjects();
  }
  return [target];
}

function transformFramesForObjects(objects, _canvas = null, zIndexMap = null) {
  return (Array.isArray(objects) ? objects : [])
    .map((object) => {
      if (!object?.boardObjectId || typeof object.calcTransformMatrix !== 'function') return null;
      const matrix = compactTransformMatrix(object.calcTransformMatrix());
      if (!matrix) return null;
      const mappedIndex = zIndexMap?.get(object);
      return {
        id: String(object.boardObjectId),
        matrix,
        // A realtime transform can be delayed independently from the durable action
        // that confirms the same gesture. Carry the object's mutation timestamp so a
        // receiving client never lets an older live frame overwrite newer server state.
        updatedAt: Number(object.updatedAt ?? 0),
        updatedBy: object.updatedBy ?? object.creationClientId ?? null,
        creationSessionId: object.creationSessionId ?? null,
        creationClientId: object.creationClientId ?? object.updatedBy ?? null,
        objectKind: object.objectKind ?? object.type ?? null,
        objectType: object.type ?? null,
        // A transform never changes layer order. Avoid canvas.getObjects().indexOf()
        // in the hot Pencil path; zIndex is only carried when a caller already has it.
        zIndex: Number.isFinite(Number(object.creationDraftZIndex))
          ? Number(object.creationDraftZIndex)
          : (Number.isInteger(mappedIndex) ? mappedIndex : -1),
      };
    })
    .filter(Boolean);
}

function selectionUiObjects(canvas) {
  if (!canvas) return [];
  const active = canvas.getActiveObject();
  if (active?.transientSelectionProxy && typeof active.getObjects === 'function') {
    return active.getObjects().filter((object) => !object.isEraserPath);
  }
  return canvas.getActiveObjects().filter((object) => !object.isEraserPath);
}

function safeFilename(value, fallback = 'alex-board') {
  const cleaned = String(value ?? '')
    .trim()
    .replace(/[\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .slice(0, 80);
  return cleaned || fallback;
}

function normalizePastedPlainText(value) {
  return String(value ?? '')
    .replace(/\\\[\s*([\s\S]*?)\s*\\\]/g, '$1')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ');
}

function createImagePlaceholder(point, label = 'Загрузка изображения…') {
  const background = new Rect({
    width: 280,
    height: 180,
    rx: 16,
    ry: 16,
    fill: '#e5e7eb',
    stroke: '#94a3b8',
    strokeWidth: 2,
    strokeDashArray: [10, 7],
    originX: 'center',
    originY: 'center',
  });
  const text = new Text(label, {
    fontFamily: 'Arial',
    fontSize: 20,
    fill: '#475569',
    originX: 'center',
    originY: 'center',
    textAlign: 'center',
  });
  return new Group([background, text], {
    left: point.x,
    top: point.y,
    originX: 'center',
    originY: 'center',
    objectKind: 'image-placeholder',
    pendingImage: true,
  });
}

function createLightweightTransformOp(entries, { reorder = false } = {}) {
  const objects = (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry?.id && entry?.transform)
    .map((entry) => ({
      id: String(entry.id),
      transform: { ...entry.transform },
      updatedAt: Number(entry.updatedAt ?? Date.now()),
      updatedBy: entry.updatedBy ?? null,
      ...(reorder && Number.isInteger(entry.zIndex) ? { zIndex: entry.zIndex } : {}),
    }));
  if (!objects.length) return null;
  return {
    type: 'transform',
    version: 1,
    objects,
    ...(reorder ? { reorder: true } : {}),
  };
}

function transformOperationEntries(op) {
  if (op?.type !== 'transform') return [];
  if (Array.isArray(op.objects)) return op.objects;
  if (op.id) return [{
    id: op.id,
    transform: op.transform,
    updatedAt: op.updatedAt,
    updatedBy: op.updatedBy,
    zIndex: op.zIndex,
  }];
  return [];
}

function affectedOperationIds(ops) {
  const ids = new Set();
  for (const op of Array.isArray(ops) ? ops : []) {
    if (op?.type === 'delete' && op.id) ids.add(String(op.id));
    if (op?.type === 'patch' && op.id) ids.add(String(op.id));
    if (op?.type === 'upsert' && op.object?.boardObjectId) {
      ids.add(String(op.object.boardObjectId));
    }
    transformOperationEntries(op).forEach((entry) => {
      if (entry?.id) ids.add(String(entry.id));
    });
  }
  return ids;
}

function finalVerificationOps(actions, results) {
  const latestById = new Map();
  (Array.isArray(actions) ? actions : []).forEach((action, actionIndex) => {
    const result = Array.isArray(results) ? results[actionIndex] : null;
    const ops = Array.isArray(result?.appliedOps) ? result.appliedOps : [];
    ops.forEach((op) => {
      if (op?.type === 'delete' && op.id) latestById.set(String(op.id), op);
      if (op?.type === 'patch' && op.id) latestById.set(String(op.id), op);
      if (op?.type === 'upsert' && op.object?.boardObjectId) {
        latestById.set(String(op.object.boardObjectId), op);
      }
      transformOperationEntries(op).forEach((entry) => {
        if (!entry?.id) return;
        latestById.set(String(entry.id), {
          type: 'transform',
          version: 1,
          objects: [entry],
          ...(op.reorder ? { reorder: true } : {}),
        });
      });
    });
  });
  return [...latestById.values()];
}

const AUTHORITATIVE_TRANSFORM_EPSILON = 0.002;
const AUTHORITATIVE_CONTENT_IGNORED_KEYS = new Set([
  'left',
  'top',
  'originX',
  'originY',
  'angle',
  'scaleX',
  'scaleY',
  'skewX',
  'skewY',
  'flipX',
  'flipY',
  'boardObjectId',
  'updatedAt',
  'updatedBy',
  'selectable',
  'evented',
  'hasControls',
  'hasBorders',
  'hoverCursor',
  'objectCaching',
  'strokeUniform',
  'pendingImage',
  'pendingImageSerialized',
]);

function authoritativePlacementMatches(object, expected = {}) {
  if (!object) return false;
  const sourceObject = object.pendingImageSerialized ?? object;
  const actual = captureSerializedObjectTransform(sourceObject, expected);
  const numericKeys = ['left', 'top', 'angle', 'scaleX', 'scaleY', 'skewX', 'skewY'];
  for (const key of numericKeys) {
    if (expected[key] == null) continue;
    const actualValue = Number(actual[key]);
    const expectedValue = Number(expected[key]);
    if (!Number.isFinite(actualValue) || !Number.isFinite(expectedValue)
      || Math.abs(actualValue - expectedValue) > AUTHORITATIVE_TRANSFORM_EPSILON) return false;
  }
  for (const key of ['originX', 'originY']) {
    if (expected[key] != null && String(actual[key]) !== String(expected[key])) return false;
  }
  for (const key of ['flipX', 'flipY']) {
    if (expected[key] != null && Boolean(actual[key]) !== Boolean(expected[key])) return false;
  }
  return true;
}

function authoritativeContentSubsetMatches(actual, expected, key = '') {
  if (AUTHORITATIVE_CONTENT_IGNORED_KEYS.has(key) || key.startsWith('transient')) return true;
  if (typeof expected === 'number') {
    return Number.isFinite(Number(actual))
      && Math.abs(Number(actual) - expected) <= AUTHORITATIVE_TRANSFORM_EPSILON;
  }
  if (expected == null || typeof expected !== 'object') return actual === expected;
  if (Array.isArray(expected)) {
    return Array.isArray(actual)
      && actual.length === expected.length
      && expected.every((value, index) => (
        authoritativeContentSubsetMatches(actual[index], value, '')
      ));
  }
  if (!actual || typeof actual !== 'object') return false;
  return Object.entries(expected).every(([childKey, value]) => (
    authoritativeContentSubsetMatches(actual[childKey], value, childKey)
  ));
}

function createPendingImagePlaceholder(serialized) {
  const left = Number(serialized?.left ?? 0);
  const top = Number(serialized?.top ?? 0);
  const placeholder = createImagePlaceholder(new Point(left, top), 'Изображение догружается…');
  const targetWidth = Math.max(40, Math.abs(Number(serialized?.width ?? 280) * Number(serialized?.scaleX ?? 1)));
  const targetHeight = Math.max(30, Math.abs(Number(serialized?.height ?? 180) * Number(serialized?.scaleY ?? 1)));
  placeholder.set({
    left,
    top,
    originX: serialized?.originX ?? 'left',
    originY: serialized?.originY ?? 'top',
    angle: Number(serialized?.angle ?? 0),
    skewX: Number(serialized?.skewX ?? 0),
    skewY: Number(serialized?.skewY ?? 0),
    flipX: Boolean(serialized?.flipX),
    flipY: Boolean(serialized?.flipY),
    opacity: Number(serialized?.opacity ?? 1),
    scaleX: targetWidth / 280,
    scaleY: targetHeight / 180,
  });
  placeholder.boardObjectId = serialized?.boardObjectId;
  placeholder.storagePath = serialized?.storagePath ?? null;
  placeholder.updatedAt = serialized?.updatedAt ?? Date.now();
  placeholder.updatedBy = serialized?.updatedBy ?? null;
  placeholder.pendingImage = true;
  placeholder.pendingImageSerialized = serialized;
  placeholder.creationSessionId = serialized?.creationSessionId ?? null;
  placeholder.creationClientId = serialized?.creationClientId ?? null;
  placeholder.setCoords();
  return placeholder;
}

function serializedImagePayload(serialized) {
  if (!serialized || typeof serialized !== 'object') return null;
  if (serialized.pendingImageSerialized?.src) return serialized.pendingImageSerialized;
  const type = String(serialized.type ?? '').toLowerCase();
  if ((type === 'image' || serialized.objectKind === 'image') && typeof serialized.src === 'string') {
    return serialized;
  }
  return null;
}

async function loadCanvasJsonProgressively(canvas, canvasJson) {
  const source = canvasJson && typeof canvasJson === 'object'
    ? canvasJson
    : { objects: [] };
  const sourceObjects = Array.isArray(source.objects) ? source.objects : [];
  const pendingImages = [];
  const immediateObjects = [];

  sourceObjects.forEach((serialized, zIndex) => {
    const imagePayload = serializedImagePayload(serialized);
    if (imagePayload) pendingImages.push({ serialized: imagePayload, zIndex });
    else immediateObjects.push(serialized);
  });

  await canvas.loadFromJSON({ ...source, objects: immediateObjects });

  // Do not make the whole board wait for a slow image host. Every picture gets a
  // correctly positioned placeholder and then hydrates independently in the background.
  pendingImages.forEach(({ serialized, zIndex }) => {
    const placeholder = createPendingImagePlaceholder(serialized);
    canvas.add(placeholder);
    if (typeof canvas.moveObjectTo === 'function') {
      canvas.moveObjectTo(placeholder, clamp(zIndex, 0, canvas.getObjects().length - 1));
    }
  });

  return pendingImages.length;
}

function touchMetrics(touches, element) {
  const first = touches[0];
  const second = touches[1];
  const rect = element.getBoundingClientRect();
  const firstX = first.clientX - rect.left;
  const firstY = first.clientY - rect.top;
  const secondX = second.clientX - rect.left;
  const secondY = second.clientY - rect.top;
  return {
    distance: Math.hypot(secondX - firstX, secondY - firstY),
    midpoint: new Point((firstX + secondX) / 2, (firstY + secondY) / 2),
  };
}


function normalizedSceneRect(first, second) {
  const left = Math.min(Number(first?.x ?? 0), Number(second?.x ?? 0));
  const top = Math.min(Number(first?.y ?? 0), Number(second?.y ?? 0));
  const right = Math.max(Number(first?.x ?? 0), Number(second?.x ?? 0));
  const bottom = Math.max(Number(first?.y ?? 0), Number(second?.y ?? 0));
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

function livePathData(points) {
  if (!Array.isArray(points) || !points.length) return '';
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${Number(point.x)} ${Number(point.y)}`).join(' ');
}

function pointInsideSceneRect(point, rect) {
  return Boolean(point)
    && Number(point.x) >= rect.left
    && Number(point.x) <= rect.right
    && Number(point.y) >= rect.top
    && Number(point.y) <= rect.bottom;
}

let geometryProbeCanvas = null;

function getGeometryProbeCanvas() {
  if (geometryProbeCanvas || typeof document === 'undefined') return geometryProbeCanvas;
  geometryProbeCanvas = document.createElement('canvas');
  return geometryProbeCanvas;
}

function renderedObjectIntersectsSceneRect(object, sceneRect, { pixelsPerSceneUnit = 1 } = {}) {
  if (!object || object.visible === false || Number(object.opacity ?? 1) <= 0.001) return false;
  const probe = getGeometryProbeCanvas();
  if (!probe) return false;

  const bounds = finiteRect(object.getBoundingRect());
  const left = Math.max(bounds.left, Number(sceneRect.left));
  const top = Math.max(bounds.top, Number(sceneRect.top));
  const right = Math.min(bounds.right, Number(sceneRect.right));
  const bottom = Math.min(bounds.bottom, Number(sceneRect.bottom));
  if (!(right >= left && bottom >= top)) return false;

  // Probe only the actual overlap between the object and marquee. Keeping the probe
  // cropped avoids allocating a bitmap the size of a long Pencil path or the board.
  const scale = clamp(Number(pixelsPerSceneUnit) || 1, 0.5, 2.5);
  const tilePixels = 192;
  const tileSceneSize = tilePixels / scale;
  const context = probe.getContext('2d', { willReadFrequently: true });
  if (!context) return false;

  for (let tileTop = top; tileTop <= bottom; tileTop += tileSceneSize) {
    const tileBottom = Math.min(bottom, tileTop + tileSceneSize);
    for (let tileLeft = left; tileLeft <= right; tileLeft += tileSceneSize) {
      const tileRight = Math.min(right, tileLeft + tileSceneSize);
      const width = Math.max(1, Math.ceil((tileRight - tileLeft) * scale) + 2);
      const height = Math.max(1, Math.ceil((tileBottom - tileTop) * scale) + 2);
      if (probe.width !== width) probe.width = width;
      if (probe.height !== height) probe.height = height;
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, width, height);
      context.setTransform(scale, 0, 0, scale, -tileLeft * scale + 1, -tileTop * scale + 1);
      try {
        object.render(context);
      } catch {
        context.setTransform(1, 0, 0, 1, 0, 0);
        continue;
      }
      context.setTransform(1, 0, 0, 1, 0, 0);
      let data;
      try {
        data = context.getImageData(0, 0, width, height).data;
      } catch {
        continue;
      }
      for (let index = 3; index < data.length; index += 4) {
        if (data[index] > 1) return true;
      }
    }
  }
  return false;
}

function objectFastIntersectsRect(object, selectionRect) {
  if (!object || object.isEraserPath || object.visible === false || Number(object.opacity ?? 1) <= 0.001) return false;
  const bounds = finiteRect(object.getBoundingRect());
  if (bounds.right < selectionRect.left
    || bounds.bottom < selectionRect.top
    || bounds.left > selectionRect.right
    || bounds.top > selectionRect.bottom) return false;

  // If the marquee contains the complete object bounds, its real geometry is certainly
  // inside as well. Partial overlaps must be decided from rendered geometry, never from
  // Fabric's bounding polygon/aCoords (which is what caused overlapping frames to select).
  const fullyCovered = selectionRect.left <= bounds.left
    && selectionRect.top <= bounds.top
    && selectionRect.right >= bounds.right
    && selectionRect.bottom >= bounds.bottom;
  if (fullyCovered) return true;

  return renderedObjectIntersectsSceneRect(object, selectionRect);
}

function finiteRect(rect) {
  const left = Number(rect?.left ?? 0);
  const top = Number(rect?.top ?? 0);
  const width = Math.max(0, Number(rect?.width ?? 0));
  const height = Math.max(0, Number(rect?.height ?? 0));
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
  };
}

function expandedRect(rect, padding = 0) {
  const safe = finiteRect(rect);
  const amount = Math.max(0, Number(padding ?? 0));
  return {
    left: safe.left - amount,
    top: safe.top - amount,
    width: safe.width + amount * 2,
    height: safe.height + amount * 2,
    right: safe.right + amount,
    bottom: safe.bottom + amount,
  };
}

function rectsIntersect(first, second) {
  const a = finiteRect(first);
  const b = finiteRect(second);
  return a.right >= b.left
    && a.bottom >= b.top
    && a.left <= b.right
    && a.top <= b.bottom;
}

function transformRectWithMatrix(rect, matrix) {
  const source = finiteRect(rect);
  const [a, b, c, d, e, f] = Array.isArray(matrix)
    ? matrix.map((value, index) => Number(value ?? (index === 0 || index === 3 ? 1 : 0)))
    : [1, 0, 0, 1, 0, 0];
  const points = [
    [source.left, source.top],
    [source.right, source.top],
    [source.right, source.bottom],
    [source.left, source.bottom],
  ].map(([x, y]) => ({
    x: a * x + c * y + e,
    y: b * x + d * y + f,
  }));
  const left = Math.min(...points.map((point) => point.x));
  const right = Math.max(...points.map((point) => point.x));
  const top = Math.min(...points.map((point) => point.y));
  const bottom = Math.max(...points.map((point) => point.y));
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

function viewportRectFromSceneRect(rect, viewport) {
  return transformRectWithMatrix(rect, viewport);
}

function sceneRectFromViewportRect(rect, viewport) {
  try {
    return transformRectWithMatrix(rect, util.invertTransform(viewport));
  } catch {
    return finiteRect(rect);
  }
}


export default function Board({ boardId }) {
  const urlBoardKey = useMemo(getKeyFromUrl, [boardId]);
  const rememberedOwnerKey = useMemo(
    () => getOwnedBoard(boardId)?.ownerKey ?? '',
    [boardId],
  );
  const [boardKey, setBoardKey] = useState(rememberedOwnerKey || urlBoardKey);
  const [workspaceMode, setWorkspaceMode] = useState('board');
  const participantClientIdRef = useRef(randomToken(10));
  const [access, setAccess] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [guestName, setGuestName] = useState('');

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!rememberedOwnerKey && !urlBoardKey) {
        setError('В ссылке отсутствует ключ доступа.');
        setLoading(false);
        return;
      }
      try {
        let result = null;
        let resolvedKey = '';
        let rememberedKeyError = null;

        // A board created in this browser keeps its owner key in localStorage.
        // Prefer it even when the teacher opens the student/share URL, so the
        // teacher panel opens automatically on the original browser/device.
        if (rememberedOwnerKey) {
          try {
            const rememberedAccess = await getBoardAccess(boardId, rememberedOwnerKey);
            if (rememberedAccess?.permission === 'owner') {
              result = rememberedAccess;
              resolvedKey = rememberedOwnerKey;
            }
          } catch (caught) {
            rememberedKeyError = caught;
          }
        }

        // A stale local owner key must never block a valid student link.
        if (!result && urlBoardKey && urlBoardKey !== rememberedOwnerKey) {
          result = await getBoardAccess(boardId, urlBoardKey);
          if (result) resolvedKey = urlBoardKey;
        }

        if (!result && urlBoardKey && urlBoardKey === rememberedOwnerKey) {
          if (rememberedKeyError) throw rememberedKeyError;
          result = await getBoardAccess(boardId, urlBoardKey);
          if (result) resolvedKey = urlBoardKey;
        }

        if (!result && rememberedKeyError && !urlBoardKey) throw rememberedKeyError;

        if (result?.permission === 'owner') {
          rememberOwnedBoard({
            boardId,
            ownerKey: resolvedKey,
            title: result.title,
            studentName: result.studentName ?? '',
          });
        }
        if (!cancelled) {
          setBoardKey(resolvedKey || rememberedOwnerKey || urlBoardKey);
          setAccess(result);
          setLoading(false);
        }
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : 'Не удалось открыть доску');
          setLoading(false);
        }
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [boardId, rememberedOwnerKey, urlBoardKey]);

  const returnToBoard = useCallback(async (options = {}) => {
    const forceLibraryHidden = options?.gameLibraryVisible === false;
    if (forceLibraryHidden) {
      setAccess((current) => (
        current ? { ...current, gameLibraryVisible: false } : current
      ));
    }
    setWorkspaceMode('board');
    try {
      const refreshedAccess = await getBoardAccess(boardId, boardKey);
      if (refreshedAccess) {
        setAccess(forceLibraryHidden
          ? { ...refreshedAccess, gameLibraryVisible: false }
          : refreshedAccess);
      }
    } catch (caught) {
      console.warn('Не удалось обновить доступ после выхода из игры', caught);
    }
  }, [boardId, boardKey]);

  if (loading) {
    return <AccessMessage title="Открываю доску">Загружаю сохранённое состояние…</AccessMessage>;
  }
  if (error) {
    return <AccessMessage title="Ошибка доступа">{error}</AccessMessage>;
  }
  if (!access) {
    return <AccessMessage title="Доска не найдена">Ссылка неверна или доступ был отозван.</AccessMessage>;
  }
  if (access.permission === 'closed') {
    return <AccessMessage title="Доска закрыта">Преподаватель временно закрыл гостевой доступ.</AccessMessage>;
  }

  const isOwner = access.permission === 'owner';
  const storedName = isOwner
    ? (localStorage.getItem('alex-board:owner-name') ?? '')
    : (sessionStorage.getItem(`alex-board:name:${boardId}`) ?? '');
  const resolvedName = guestName || storedName;

  if (!resolvedName) {
    return (
      <NameGate
        title={isOwner ? 'Как показывать ваше имя на доске?' : access.title}
        onSubmit={(name) => {
          if (isOwner) localStorage.setItem('alex-board:owner-name', name);
          else sessionStorage.setItem(`alex-board:name:${boardId}`, name);
          setGuestName(name);
        }}
      />
    );
  }

  if (workspaceMode === 'games') {
    return (
      <GameLibrary
        boardId={boardId}
        boardKey={boardKey}
        realtimeKey={access.realtimeKey}
        boardTitle={access.title}
        participantName={resolvedName}
        participantClientId={participantClientIdRef.current}
        permission={access.permission}
        onExit={returnToBoard}
      />
    );
  }

  return (
    <BoardWorkspace
      boardId={boardId}
      boardKey={boardKey}
      initialAccess={access}
      participantName={resolvedName}
      participantClientId={participantClientIdRef.current}
      onAccessChange={setAccess}
      onOpenGameLibrary={() => setWorkspaceMode('games')}
    />
  );
}

function BoardWorkspace({
  boardId,
  boardKey,
  initialAccess,
  participantName,
  participantClientId,
  onAccessChange,
  onOpenGameLibrary,
}) {
  const canvasElementRef = useRef(null);
  const canvasHostRef = useRef(null);
  const fabricCanvasRef = useRef(null);
  const realtimeRef = useRef(null);
  const gameLibraryVisibleRef = useRef(Boolean(initialAccess.gameLibraryVisible));
  const gameLibraryVisibilityBusyRef = useRef(false);
  const toggleGameLibraryVisibilityRef = useRef(null);
  const clientIdRef = useRef(participantClientId || randomToken(10));
  const applyingRemoteRef = useRef(false);
  const applyingHistoryRef = useRef(false);
  const lineRef = useRef(null);
  const lineStartRef = useRef(null);
  const selectedShapeRef = useRef(null);
  const shapeDraftRef = useRef(null);
  const cancelCreationDraftRef = useRef(null);
  const erasingRef = useRef(false);
  const objectEraserRecordsRef = useRef(new Map());
  const objectEraserRealtimeDeleteIdsRef = useRef(new Set());
  const objectEraserRealtimeTimerRef = useRef(null);
  const modifiedBeforeRef = useRef([]);
  const clipboardRef = useRef([]);
  const clipboardCenterRef = useRef(null);
  const clipboardSourceBoardIdRef = useRef(null);
  const mobilePasteAwaitingPointRef = useRef(false);
  const toolbarPastePointRef = useRef(null);
  const toolbarPasteAwaitingPointRef = useRef(false);
  const snapshotPersistTimerRef = useRef(null);
  const snapshotPersistInFlightRef = useRef(false);
  const snapshotPersistQueuedRef = useRef(false);
  const snapshotPersistRunnerRef = useRef(null);
  const snapshotCompactionNeededRef = useRef(false);
  const lastBoardInteractionAtRef = useRef(0);
  const initialSnapshotRevision = Number(initialAccess.snapshotRevision ?? 0);
  const lastSnapshotSavedRevisionRef = useRef(initialSnapshotRevision);
  const snapshotCompactBaseRef = useRef(initialAccess.snapshot ?? null);
  const snapshotCompactBaseRevisionRef = useRef(initialSnapshotRevision);
  const snapshotCompactActionsRef = useRef([]);
  const snapshotCompactTargetRevisionRef = useRef(initialSnapshotRevision);
  const revisionRef = useRef(Number(initialAccess.snapshotRevision ?? initialAccess.revision ?? 0));
  const pendingServerWritesRef = useRef(0);
  const pendingLocalObjectMutationCountsRef = useRef(new Map());
  const pendingLocalBackgroundMutationCountRef = useRef(0);
  const rebasingPendingActionsRef = useRef(false);
  const syncRequestedRef = useRef(false);
  const syncForceRef = useRef(false);
  const syncInFlightRef = useRef(false);
  const authoritativeApplyQueueRef = useRef(Promise.resolve());
  const applyRemoteOpsRef = useRef(null);
  const pendingImageRetryInFlightRef = useRef(false);
  const remoteTransformApplyQueueRef = useRef(Promise.resolve());
  const selectionMemberControlsRef = useRef(new Map());
  const selectionUiTouchedRef = useRef(new Set());
  const boardReadyRef = useRef(false);
  const activeToolRef = useRef('pencil');
  const drawingStylesRef = useRef({
    pencil: { ...DEFAULT_DRAWING_STYLES.pencil },
    line: { ...DEFAULT_DRAWING_STYLES.line },
    shape: { ...DEFAULT_DRAWING_STYLES.shape },
  });
  const canEditRef = useRef(initialAccess.permission === 'owner' || initialAccess.permission === 'edit');
  const colorRef = useRef(DEFAULT_DRAWING_STYLES.pencil.color);
  const opacityRef = useRef(DEFAULT_DRAWING_STYLES.pencil.opacity);
  const widthRef = useRef(DEFAULT_DRAWING_STYLES.pencil.width);
  const eyedropperActiveRef = useRef(false);
  const eyedropperModeRef = useRef(null);
  const eyedropperSelectionIdsRef = useRef([]);
  const eyedropperSelectionTransactionIdRef = useRef(null);
  // A Pencil eyedropper contact is owned entirely by the native capture route.
  // Fabric never sees that pointer stream, so the next stroke can start immediately
  // after pointerup without waiting for a timer or for WebKit to release old state.
  const eyedropperPenContactRef = useRef(null);
  // Safari may mirror one Pencil contact into PointerEvent, TouchEvent and
  // compatibility mouse events. This short guard keeps the mirrored tail away from
  // Fabric after the atomic eyedropper session has already completed.
  const eyedropperCompatibilityGuardUntilRef = useRef(0);
  const eraserModeRef = useRef('object');
  const eraserWidthRef = useRef(28);
  const fontFamilyRef = useRef('Arial');
  const fontSizeRef = useRef(34);
  const textBeforeRef = useRef(new Map());
  const newTextDraftIdsRef = useRef(new Set());
  const textChangeTimerRef = useRef(null);
  const textTapCandidateRef = useRef(null);
  const mobileTextEditorRef = useRef(null);
  const objectEraserPointerRef = useRef(null);
  const objectRegistryRef = useRef(new Map());
  const creationSessionRegistryRef = useRef(new Map());
  const selectionTransactionRegistryRef = useRef(new Map());
  const objectEraserRenderFrameRef = useRef(null);
  const localDeletionCompositorRef = useRef(null);
  const backgroundRef = useRef(
    BACKGROUNDS.has(initialAccess.snapshot?.background)
      ? initialAccess.snapshot.background
      : 'grid',
  );
  const spacePressedRef = useRef(false);
  const panningRef = useRef(false);
  const lastPanRef = useRef(null);
  const touchGestureRef = useRef(null);
  const touchGestureGenerationRef = useRef(0);
  const lastTouchGestureEndedAtRef = useRef(0);
  const undoStackRef = useRef([]);
  const redoStackRef = useRef([]);
  const historyCommandBusyRef = useRef(false);
  const remoteLocksRef = useRef(new Map());
  const localLockIdsRef = useRef([]);
  const lastLockBroadcastRef = useRef(0);
  const cursorSendRef = useRef({ lastSentAt: 0, timer: null, pending: null });
  const liveTransformSendRef = useRef({
    sessionId: null,
    sessionOrder: 0,
    sequence: 0,
    lastSentAt: 0,
    lastSignature: '',
    timer: null,
    pendingTarget: null,
    zIndexMap: null,
    baseRevision: 0,
  });
  const remoteTransformSessionsRef = useRef(new Map());
  const remoteTransformClientOrderRef = useRef(new Map());
  // Durable Supabase operations are the final authority for each stable object id.
  // Keeping only the latest operation gives late realtime previews a cheap O(1) fence
  // and lets us repair just the objects touched by an event, never the whole board.
  const authoritativeObjectStatesRef = useRef(new Map());
  const authoritativeBackgroundStateRef = useRef({
    revision: initialSnapshotRevision,
    background: backgroundRef.current,
  });
  const authoritativeSelectionTransactionsRef = useRef(new Map());
  const targetedReconcileStateRef = useRef({ pending: new Map(), timer: null, running: false });
  const targetedReconcileRunnerRef = useRef(null);
  const liveDrawSendRef = useRef({
    sessionId: null,
    sessionOrder: 0,
    sequence: 0,
    lastSentAt: 0,
    lastSentPointIndex: 0,
    timer: null,
    tool: null,
    objectId: null,
    points: [],
    style: null,
    acceptingPoints: false,
  });
  const pendingPencilQueueRef = useRef([]);
  const activePencilRef = useRef(null);
  const remoteDrawSessionsRef = useRef(new Map());
  const remoteDeletedObjectIdsRef = useRef(new Map());
  const remotePreviewTokensRef = useRef(new Map());
  const remotePreviewPendingRef = useRef({ records: new Map(), timer: null, draining: false });
  const remotePreviewApplyQueueRef = useRef(Promise.resolve());
  const remotePreviewChunksRef = useRef(new Map());
  const selectionDragRef = useRef(null);
  const selectionBoxRef = useRef(null);
  const selectionMarqueeElementRef = useRef(null);
  const selectionMoveFrameRef = useRef(null);
  const selectionTargetFindResetRef = useRef(null);
  const selectionPenSessionRef = useRef({
    pointerId: null,
    active: false,
    moveFramePending: false,
    compatibilityGuardUntil: 0,
    generation: 0,
    lastEndedAt: 0,
  });
  const transformGestureRef = useRef({
    activeId: null,
    lastCommittedId: null,
    signature: '',
    committedAt: 0,
    pointerType: null,
  });
  const deferredTransformFlushRef = useRef(null);
  // A Pencil drag uses two small cropped raster layers: one patch that restores the
  // pixels below the selection's old position, and one layer containing only the moving
  // selection. The main board canvas is never cleared or rebuilt during the gesture.
  const penTransformIsolationRef = useRef(null);
  const finishPenTransformIsolationRef = useRef(null);
  const penTransformSpatialApiRef = useRef(null);
  const penTransformTopRefreshFrameRef = useRef(null);
  const penTransformPendingControlsOverlayRef = useRef(null);
  const selectionUiRefreshFrameRef = useRef(null);
  const selectionStyleRefreshTimerRef = useRef(null);
  const serializedObjectCacheRef = useRef(new WeakMap());
  const selectionVisualSignatureRef = useRef('');
  const selectionVisualActiveRef = useRef(null);
  const pendingGroupTransformCommitRef = useRef(null);
  const localSelectionTransactionRef = useRef(null);
  const remoteSelectionTransactionsRef = useRef(new Map());
  const remoteSelectionOperationIdsRef = useRef(new Map());
  const selectionTransactionTransitionRef = useRef(false);
  const transientStatusTimerRef = useRef(null);
  const lastPointerSceneRef = useRef(null);
  const internalClipboardArmedRef = useRef(false);
  const penInputRef = useRef({
    pointerId: null,
    active: false,
    lastSeenAt: 0,
    lastClientX: 0,
    lastClientY: 0,
    suppressUntil: 0,
  });
  const stylusTouchFallbackRef = useRef({
    active: false,
    touchId: null,
    pointerId: null,
    lastClientX: 0,
    lastClientY: 0,
    guardUntil: 0,
  });
  const rejectedPointerIdsRef = useRef(new Set());
  const suppressedTouchIdsRef = useRef(new Set());
  const viewSendRef = useRef({ lastSentAt: 0, timer: null, pending: false });
  const lastTeacherViewRef = useRef(null);
  const autopilotRef = useRef(false);
  const autopilotAnimationRef = useRef({
    frame: null,
    target: null,
    lastFrameAt: 0,
    lastUiAt: 0,
  });

  const [permission, setPermission] = useState(initialAccess.permission);
  const [guestMode, setGuestModeState] = useState(initialAccess.guestMode);
  const [tool, setToolState] = useState(initialAccess.permission === 'view' ? 'select' : 'pencil');
  const [color, setColorState] = useState(DEFAULT_DRAWING_STYLES.pencil.color);
  const [opacity, setOpacityState] = useState(DEFAULT_DRAWING_STYLES.pencil.opacity);
  const [width, setWidthState] = useState(DEFAULT_DRAWING_STYLES.pencil.width);
  const [eyedropperActive, setEyedropperActive] = useState(false);
  const [eraserMode, setEraserModeState] = useState('object');
  const [eraserWidth, setEraserWidthState] = useState(28);
  const [fontFamily, setFontFamilyState] = useState('Arial');
  const [fontSize, setFontSizeState] = useState(34);
  const [mobileTextEditor, setMobileTextEditor] = useState(null);
  const [background, setBackgroundState] = useState(backgroundRef.current);
  const [zoom, setZoom] = useState(1);
  const [saveStatus, setSaveStatus] = useState('Загружено');
  const [syncTone, setSyncTone] = useState('saved');
  const [pendingCount, setPendingCount] = useState(0);
  const [users, setUsers] = useState([]);
  const [gameLibraryVisible, setGameLibraryVisibleState] = useState(Boolean(initialAccess.gameLibraryVisible));
  const [remoteCursors, setRemoteCursors] = useState([]);
  const [remoteLocks, setRemoteLocks] = useState([]);
  const [viewportVersion, setViewportVersion] = useState(0);
  const [shareOpen, setShareOpen] = useState(false);
  const [fatalError, setFatalError] = useState('');
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [selectedCount, setSelectedCount] = useState(0);
  const [autopilot, setAutopilot] = useState(false);
  const [selectionStyle, setSelectionStyle] = useState({
    canColor: false,
    canOpacity: false,
    canWidth: false,
    color: '#111827',
    opacity: 1,
    width: 3,
  });

  const isOwner = permission === 'owner';
  const canEdit = permission === 'owner' || permission === 'edit';
  const compactKeyboardEnabled = useMemo(() => (
    typeof navigator !== 'undefined'
    && Number(navigator.maxTouchPoints ?? 0) > 0
    && (window.matchMedia?.('(pointer: coarse)')?.matches || window.innerWidth <= 1180)
  ), []);

  useEffect(() => {
    const root = document.documentElement;
    const body = document.body;
    const visualViewport = window.visualViewport;
    let orientationTimer = null;
    let settleTimer = null;

    const applyViewportSize = () => {
      const viewportWidth = Math.max(1, Math.round(visualViewport?.width ?? window.innerWidth));
      const viewportHeight = Math.max(1, Math.round(visualViewport?.height ?? window.innerHeight));
      root.style.setProperty('--board-app-width', `${viewportWidth}px`);
      root.style.setProperty('--board-app-height', `${viewportHeight}px`);

      // Mobile Safari can restore an old document scroll/zoom offset when reopening a tab.
      // The board owns its own pan and zoom, so the outer page must always stay at 0,0.
      if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
    };

    const settleViewport = () => {
      window.clearTimeout(settleTimer);
      applyViewportSize();
      settleTimer = window.setTimeout(applyViewportSize, 180);
    };

    const handleOrientationChange = () => {
      window.clearTimeout(orientationTimer);
      applyViewportSize();
      orientationTimer = window.setTimeout(applyViewportSize, 320);
    };

    const preventDocumentGesture = (event) => {
      // Fabric handles pinch zoom inside the board. Prevent Safari from zooming and
      // panning the whole web page around the fixed application viewport.
      event.preventDefault();
    };

    root.classList.add('board-viewport-locked');
    body.classList.add('board-viewport-locked');
    applyViewportSize();
    requestAnimationFrame(applyViewportSize);

    window.addEventListener('resize', settleViewport, { passive: true });
    window.addEventListener('orientationchange', handleOrientationChange, { passive: true });
    window.addEventListener('pageshow', settleViewport, { passive: true });
    visualViewport?.addEventListener('resize', settleViewport, { passive: true });
    visualViewport?.addEventListener('scroll', settleViewport, { passive: true });
    document.addEventListener('gesturestart', preventDocumentGesture, { passive: false });
    document.addEventListener('gesturechange', preventDocumentGesture, { passive: false });
    document.addEventListener('gestureend', preventDocumentGesture, { passive: false });

    return () => {
      window.clearTimeout(orientationTimer);
      window.clearTimeout(settleTimer);
      window.removeEventListener('resize', settleViewport);
      window.removeEventListener('orientationchange', handleOrientationChange);
      window.removeEventListener('pageshow', settleViewport);
      visualViewport?.removeEventListener('resize', settleViewport);
      visualViewport?.removeEventListener('scroll', settleViewport);
      document.removeEventListener('gesturestart', preventDocumentGesture);
      document.removeEventListener('gesturechange', preventDocumentGesture);
      document.removeEventListener('gestureend', preventDocumentGesture);
      root.classList.remove('board-viewport-locked');
      body.classList.remove('board-viewport-locked');
      root.style.removeProperty('--board-app-width');
      root.style.removeProperty('--board-app-height');
    };
  }, []);

  const markObject = useCallback((object, clientId) => {
    applySharpRenderingPolicy(object);
    if (!object.boardObjectId) object.boardObjectId = randomToken(10);
    object.updatedAt = Date.now();
    object.updatedBy = clientId;
    object.setCoords();
    const key = String(object.boardObjectId);
    const bucket = objectRegistryRef.current.get(key) ?? new Set();
    bucket.add(object);
    objectRegistryRef.current.set(key, bucket);
    return object;
  }, []);

  const registerCanvasObject = useCallback((object) => {
    applySharpRenderingPolicy(object);
    const selectionTransactionId = String(object?.selectionTransactionId ?? '');
    if (selectionTransactionId) {
      const transactionBucket = selectionTransactionRegistryRef.current.get(selectionTransactionId)
        ?? new Set();
      transactionBucket.add(object);
      selectionTransactionRegistryRef.current.set(selectionTransactionId, transactionBucket);
    }
    const sessionKey = creationSessionRegistryKey(
      object?.creationClientId ?? object?.updatedBy ?? '',
      object?.creationSessionId,
    );
    if (sessionKey) {
      const sessionBucket = creationSessionRegistryRef.current.get(sessionKey) ?? new Set();
      sessionBucket.add(object);
      creationSessionRegistryRef.current.set(sessionKey, sessionBucket);
    }
    const id = object?.boardObjectId;
    if (!id) return;
    const key = String(id);
    const bucket = objectRegistryRef.current.get(key) ?? new Set();
    bucket.add(object);
    objectRegistryRef.current.set(key, bucket);
  }, []);

  const unregisterCanvasObject = useCallback((object) => {
    const selectionTransactionId = String(object?.selectionTransactionId ?? '');
    if (selectionTransactionId) {
      const transactionBucket = selectionTransactionRegistryRef.current.get(selectionTransactionId);
      transactionBucket?.delete(object);
      if (transactionBucket && !transactionBucket.size) {
        selectionTransactionRegistryRef.current.delete(selectionTransactionId);
      }
    }
    const sessionKey = creationSessionRegistryKey(
      object?.creationClientId ?? object?.updatedBy ?? '',
      object?.creationSessionId,
    );
    if (sessionKey) {
      const sessionBucket = creationSessionRegistryRef.current.get(sessionKey);
      sessionBucket?.delete(object);
      if (sessionBucket && !sessionBucket.size) creationSessionRegistryRef.current.delete(sessionKey);
    }
    const id = object?.boardObjectId;
    if (!id) return;
    const key = String(id);
    const bucket = objectRegistryRef.current.get(key);
    if (!bucket) return;
    bucket.delete(object);
    if (!bucket.size) objectRegistryRef.current.delete(key);
  }, []);

  const rebuildObjectRegistry = useCallback(() => {
    const canvas = fabricCanvasRef.current;
    objectRegistryRef.current = new Map();
    creationSessionRegistryRef.current = new Map();
    selectionTransactionRegistryRef.current = new Map();
    canvas?.getObjects().forEach(registerCanvasObject);
  }, [registerCanvasObject]);

  const registeredObjectsById = useCallback((objectId) => {
    if (!objectId) return [];
    const canvas = fabricCanvasRef.current;
    const key = String(objectId);
    let objects = [...(objectRegistryRef.current.get(key) ?? [])]
      .filter((object) => object?.canvas === canvas);
    if (!objects.length && canvas) {
      objects = canvas.getObjects().filter((object) => String(object.boardObjectId ?? '') === key);
      objects.forEach(registerCanvasObject);
    }
    return objects;
  }, [registerCanvasObject]);

  const registeredObjectsByCreationSession = useCallback((clientId, sessionId) => {
    if (!sessionId) return [];
    const canvas = fabricCanvasRef.current;
    const key = creationSessionRegistryKey(clientId, sessionId);
    let objects = [...(creationSessionRegistryRef.current.get(key) ?? [])]
      .filter((object) => object?.canvas === canvas);
    if (!objects.length && canvas) {
      objects = boardObjectsByCreationSession(canvas, clientId, sessionId);
      objects.forEach(registerCanvasObject);
    }
    return objects;
  }, [registerCanvasObject]);

  const removeRegisteredObjectsByCreationSession = useCallback((
    clientId,
    sessionId,
    keep = null,
    { transientOnly = false } = {},
  ) => {
    const canvas = fabricCanvasRef.current;
    if (!canvas || !sessionId) return [];
    const removed = registeredObjectsByCreationSession(clientId, sessionId)
      .filter((object) => object !== keep && (!transientOnly || object.transientPreview));
    removed.forEach((object) => canvas.remove(object));
    return removed;
  }, [registeredObjectsByCreationSession]);

  const registeredObjectsBySelectionTransaction = useCallback((transactionId) => {
    if (!transactionId) return [];
    const canvas = fabricCanvasRef.current;
    const key = String(transactionId);
    let objects = [...(selectionTransactionRegistryRef.current.get(key) ?? [])]
      .filter((object) => object?.canvas === canvas);
    if (!objects.length && canvas) {
      objects = canvas.getObjects().filter((object) => (
        String(object.selectionTransactionId ?? '') === key
      ));
      objects.forEach(registerCanvasObject);
    }
    return objects;
  }, [registerCanvasObject]);

  const removeRegisteredSelectionTransactionObjects = useCallback((transactionId) => {
    const canvas = fabricCanvasRef.current;
    if (!canvas || !transactionId) return [];
    const removed = registeredObjectsBySelectionTransaction(transactionId);
    removed.forEach((object) => canvas.remove(object));
    return removed;
  }, [registeredObjectsBySelectionTransaction]);

  const verifyAuthoritativeOps = useCallback((ops, incomingBackground = null) => {
    for (const op of Array.isArray(ops) ? ops : []) {
      if (op?.type === 'delete' && op.id) {
        const durable = registeredObjectsById(op.id).filter((object) => (
          !object.transientPreview
          && !object.transientTransformFallback
          && !object.transientSelectionProxy
        ));
        if (durable.length !== 0) return false;
      }

      if (op?.type === 'upsert' && op.object?.boardObjectId) {
        const expected = op.object;
        const durable = registeredObjectsById(expected.boardObjectId).filter((object) => (
          !object.transientPreview
          && !object.transientTransformFallback
          && !object.transientSelectionProxy
        ));
        if (durable.length !== 1) return false;
        const actual = durable[0];
        const serializedActual = actual.pendingImageSerialized ?? serializeObject(actual);
        if (String(serializedActual.boardObjectId ?? actual.boardObjectId ?? '')
          !== String(expected.boardObjectId)) return false;
        if (expected.type && String(serializedActual.type ?? '').toLowerCase()
          !== String(expected.type).toLowerCase()) return false;
        if (expected.updatedAt != null
          && Number(serializedActual.updatedAt ?? actual.updatedAt ?? 0) !== Number(expected.updatedAt)) return false;
        if (!authoritativePlacementMatches(actual, expected)) return false;
        if (!authoritativeContentSubsetMatches(serializedActual, expected)) return false;
        if (Number.isInteger(op.zIndex)) {
          const durableOrder = fabricCanvasRef.current?.getObjects?.().filter((object) => (
            !object.transientPreview
            && !object.transientTransformFallback
            && !object.transientSelectionProxy
          )) ?? [];
          if (durableOrder.indexOf(actual) !== Number(op.zIndex)) return false;
        }
      }

      if (op?.type === 'patch' && op.id) {
        const durable = registeredObjectsById(op.id).filter((object) => (
          !object.transientPreview
          && !object.transientTransformFallback
          && !object.transientSelectionProxy
        ));
        if (durable.length !== 1) return false;
        const actual = durable[0];
        const serializedActual = actual.pendingImageSerialized ?? serializeObject(actual);
        if (!authoritativeContentSubsetMatches(serializedActual, op.patch ?? {})) return false;
        for (const key of Array.isArray(op.unset) ? op.unset : []) {
          if (Object.prototype.hasOwnProperty.call(serializedActual, key)) return false;
        }
        if (op.updatedAt != null
          && Number(serializedActual.updatedAt ?? actual.updatedAt ?? 0) !== Number(op.updatedAt)) return false;
        if (op.reorder && Number.isInteger(op.zIndex)) {
          const durableOrder = fabricCanvasRef.current?.getObjects?.().filter((object) => (
            !object.transientPreview
            && !object.transientTransformFallback
            && !object.transientSelectionProxy
          )) ?? [];
          if (durableOrder.indexOf(actual) !== Number(op.zIndex)) return false;
        }
      }

      if (op?.type === 'transform') {
        for (const patch of transformOperationEntries(op)) {
          if (!patch?.id || !patch?.transform) continue;
          const durable = registeredObjectsById(patch.id).filter((object) => (
            !object.transientPreview
            && !object.transientTransformFallback
            && !object.transientSelectionProxy
          ));
          if (durable.length !== 1) return false;
          const actual = durable[0];
          if (!authoritativePlacementMatches(actual, patch.transform)) return false;
          if (patch.updatedAt != null
            && Number(actual.updatedAt ?? 0) !== Number(patch.updatedAt)) return false;
        }
      }
    }
    if (BACKGROUNDS.has(incomingBackground) && backgroundRef.current !== incomingBackground) return false;
    return true;
  }, [registeredObjectsById]);

  const rememberAuthoritativeOps = useCallback((ops, revision) => {
    const numericRevision = Number(revision ?? revisionRef.current ?? 0);
    const recordedAt = Date.now();
    const remember = (objectId, op, updatedAt = 0) => {
      const id = String(objectId ?? '');
      if (!id) return;
      const previous = authoritativeObjectStatesRef.current.get(id);
      if (previous && Number(previous.revision ?? 0) > numericRevision) return;
      authoritativeObjectStatesRef.current.set(id, {
        revision: numericRevision,
        updatedAt: Number(updatedAt ?? 0),
        recordedAt,
        kind: op?.type ?? 'unknown',
        op,
      });
    };

    for (const op of Array.isArray(ops) ? ops : []) {
      if (op?.type === 'delete' && op.id) {
        remember(op.id, { ...op }, Number(op.updatedAt ?? recordedAt));
        continue;
      }
      if (op?.type === 'upsert' && op.object?.boardObjectId) {
        remember(
          op.object.boardObjectId,
          { ...op, object: op.object },
          Number(op.object.updatedAt ?? 0),
        );
        if (op.object.selectionTransactionId) {
          authoritativeSelectionTransactionsRef.current.set(
            String(op.object.selectionTransactionId),
            { revision: numericRevision, recordedAt },
          );
        }
        continue;
      }
      if (op?.type === 'patch' && op.id) {
        const objectId = String(op.id);
        const previous = authoritativeObjectStatesRef.current.get(objectId);
        const previousUpsert = previous?.op?.type === 'upsert' ? previous.op : null;
        const authoritativeOp = previousUpsert
          ? {
            ...previousUpsert,
            object: applySerializedObjectPatch(previousUpsert.object, op),
            preserveOrder: !op.reorder,
            ...(Number.isInteger(op.zIndex) ? { zIndex: op.zIndex } : {}),
            ...(op.reorder ? { reorder: true } : {}),
          }
          : { ...op, patch: { ...(op.patch ?? {}) } };
        remember(objectId, authoritativeOp, Number(op.updatedAt ?? 0));
        if (op.patch?.selectionTransactionId) {
          authoritativeSelectionTransactionsRef.current.set(
            String(op.patch.selectionTransactionId),
            { revision: numericRevision, recordedAt },
          );
        }
        continue;
      }
      if (op?.type === 'transform') {
        transformOperationEntries(op).forEach((entry) => {
          if (!entry?.id || !entry?.transform) return;
          const objectId = String(entry.id);
          const previous = authoritativeObjectStatesRef.current.get(objectId);
          const previousUpsert = previous?.op?.type === 'upsert' ? previous.op : null;
          const authoritativeOp = previousUpsert
            ? {
              ...previousUpsert,
              type: 'upsert',
              object: {
                ...previousUpsert.object,
                ...entry.transform,
                boardObjectId: objectId,
                updatedAt: Number(entry.updatedAt ?? previousUpsert.object?.updatedAt ?? 0),
                updatedBy: entry.updatedBy ?? previousUpsert.object?.updatedBy ?? null,
              },
              preserveOrder: !op.reorder,
              ...(Number.isInteger(entry.zIndex) ? { zIndex: entry.zIndex } : {}),
              ...(op.reorder ? { reorder: true } : {}),
            }
            : {
              type: 'transform',
              version: 1,
              objects: [{ ...entry, transform: { ...entry.transform } }],
              ...(op.reorder ? { reorder: true } : {}),
            };
          remember(objectId, authoritativeOp, Number(entry.updatedAt ?? 0));
        });
      }
    }
  }, []);

  const seedAuthoritativeSnapshot = useCallback((snapshot, revision) => {
    const objects = Array.isArray(snapshot?.canvas?.objects) ? snapshot.canvas.objects : [];
    const numericRevision = Number(revision ?? 0);
    const recordedAt = Date.now();
    authoritativeObjectStatesRef.current.clear();
    if (BACKGROUNDS.has(snapshot?.background)) {
      authoritativeBackgroundStateRef.current = {
        revision: numericRevision,
        background: snapshot.background,
      };
    }
    objects.forEach((object, zIndex) => {
      const objectId = String(object?.boardObjectId ?? '');
      if (!objectId) return;
      authoritativeObjectStatesRef.current.set(objectId, {
        revision: numericRevision,
        updatedAt: Number(object.updatedAt ?? 0),
        recordedAt,
        kind: 'upsert',
        op: {
          type: 'upsert',
          object,
          zIndex,
          preserveOrder: true,
        },
      });
    });
  }, []);

  const clearTextPlaceholderForEditing = useCallback((target, canvas = fabricCanvasRef.current) => {
    if (!target || !target.textPlaceholder || String(target.text ?? '') !== 'text') return false;
    target.set({ text: '', textPlaceholder: false });
    target.selectionStart = 0;
    target.selectionEnd = 0;
    if (target.hiddenTextarea) {
      target.hiddenTextarea.value = '';
      target.hiddenTextarea.setSelectionRange?.(0, 0);
    }
    target.dirty = true;
    target.initDimensions?.();
    target.setCoords?.();
    canvas?.fire?.('text:changed', { target });
    canvas?.requestRenderAll?.();
    return true;
  }, []);

  const closeMobileTextEditor = useCallback(({ exitEditing = true } = {}) => {
    const current = mobileTextEditorRef.current;
    mobileTextEditorRef.current = null;
    setMobileTextEditor(null);
    if (!current?.objectId) return;
    const target = registeredObjectsById(current.objectId).find((object) => isTextObject(object));
    if (!target) return;
    const textarea = target.hiddenTextarea;
    if (textarea) {
      textarea.readOnly = false;
      textarea.inputMode = 'text';
      textarea.setAttribute?.('inputmode', 'text');
      if ('virtualKeyboardPolicy' in textarea) textarea.virtualKeyboardPolicy = 'auto';
    }
    if (exitEditing && target.isEditing) target.exitEditing?.();
    fabricCanvasRef.current?.requestRenderAll?.();
  }, [registeredObjectsById]);

  const openTextEditor = useCallback((target, { compact = compactKeyboardEnabled } = {}) => {
    const canvas = fabricCanvasRef.current;
    if (!canvas || !target || !isTextObject(target)) return false;
    const current = mobileTextEditorRef.current;
    if (current?.objectId && String(current.objectId) !== String(target.boardObjectId ?? '')) {
      closeMobileTextEditor();
    }
    canvas.setActiveObject(target);
    target.enterEditing?.();
    clearTextPlaceholderForEditing(target, canvas);
    const end = String(target.text ?? '').length;
    target.selectionStart = end;
    target.selectionEnd = end;

    if (compact) {
      const editorState = {
        objectId: String(target.boardObjectId ?? ''),
        layout: mobileTextEditorRef.current?.layout ?? 'en',
        shift: false,
      };
      mobileTextEditorRef.current = editorState;
      setMobileTextEditor(editorState);
      const suppressSystemKeyboard = () => {
        const textarea = target.hiddenTextarea;
        if (!textarea) return;
        textarea.inputMode = 'none';
        textarea.setAttribute?.('inputmode', 'none');
        textarea.readOnly = true;
        textarea.autocomplete = 'off';
        textarea.autocapitalize = 'off';
        textarea.spellcheck = false;
        if ('virtualKeyboardPolicy' in textarea) textarea.virtualKeyboardPolicy = 'manual';
        navigator.virtualKeyboard?.hide?.();
      };
      suppressSystemKeyboard();
      window.requestAnimationFrame(suppressSystemKeyboard);
      window.setTimeout(suppressSystemKeyboard, 80);
    } else {
      target.hiddenTextarea?.focus?.();
    }

    canvas.requestRenderAll();
    return true;
  }, [clearTextPlaceholderForEditing, closeMobileTextEditor, compactKeyboardEnabled]);

  const applyCompactKeyboardAction = useCallback((action) => {
    const editor = mobileTextEditorRef.current;
    const canvas = fabricCanvasRef.current;
    if (!editor?.objectId || !canvas) return;
    const target = registeredObjectsById(editor.objectId).find((object) => isTextObject(object));
    if (!target) {
      closeMobileTextEditor({ exitEditing: false });
      return;
    }

    if (action === 'close' || action === 'enter') {
      target.exitEditing?.();
      return;
    }
    if (action === 'layout') {
      const next = { ...editor, layout: editor.layout === 'ru' ? 'en' : 'ru', shift: false };
      mobileTextEditorRef.current = next;
      setMobileTextEditor(next);
      return;
    }
    if (action === 'shift') {
      const next = { ...editor, shift: !editor.shift };
      mobileTextEditorRef.current = next;
      setMobileTextEditor(next);
      return;
    }

    const source = String(target.text ?? '');
    let start = clamp(Number(target.selectionStart ?? source.length), 0, source.length);
    let end = clamp(Number(target.selectionEnd ?? start), 0, source.length);
    if (end < start) [start, end] = [end, start];
    let nextText = source;
    let nextCaret = start;

    if (action === 'left') {
      nextCaret = Math.max(0, start - 1);
      target.selectionStart = nextCaret;
      target.selectionEnd = nextCaret;
      canvas.requestRenderAll();
      return;
    }
    if (action === 'right') {
      nextCaret = Math.min(source.length, end + 1);
      target.selectionStart = nextCaret;
      target.selectionEnd = nextCaret;
      canvas.requestRenderAll();
      return;
    }
    if (action === 'backspace') {
      if (start !== end) {
        nextText = `${source.slice(0, start)}${source.slice(end)}`;
        nextCaret = start;
      } else if (start > 0) {
        nextText = `${source.slice(0, start - 1)}${source.slice(end)}`;
        nextCaret = start - 1;
      } else {
        return;
      }
    } else {
      let inserted = action === 'space' ? ' ' : String(action ?? '');
      if (!inserted) return;
      if (editor.shift && inserted.length === 1) inserted = inserted.toLocaleUpperCase(editor.layout === 'ru' ? 'ru-RU' : 'en-US');
      nextText = `${source.slice(0, start)}${inserted}${source.slice(end)}`;
      nextCaret = start + inserted.length;
    }

    target.set({ text: nextText, textPlaceholder: false });
    target.selectionStart = nextCaret;
    target.selectionEnd = nextCaret;
    target.dirty = true;
    target.initDimensions?.();
    target.setCoords?.();
    if (target.hiddenTextarea) {
      target.hiddenTextarea.value = nextText;
      target.hiddenTextarea.setSelectionRange?.(nextCaret, nextCaret);
    }
    canvas.fire('text:changed', { target });
    canvas.requestRenderAll();

    if (editor.shift && action !== 'backspace') {
      const next = { ...editor, shift: false };
      mobileTextEditorRef.current = next;
      setMobileTextEditor(next);
    }
  }, [closeMobileTextEditor, registeredObjectsById]);

  const removeRegisteredObjectsById = useCallback((objectId) => {
    const canvas = fabricCanvasRef.current;
    if (!canvas || !objectId) return [];
    const objects = registeredObjectsById(objectId);
    objects.forEach((object) => canvas.remove(object));
    return objects;
  }, [registeredObjectsById]);

  const deduplicateRegisteredObjectIds = useCallback((objectIds) => {
    const canvas = fabricCanvasRef.current;
    if (!canvas) return 0;
    let removed = 0;
    const chooseKeep = (objects) => [...objects].sort((left, right) => {
      const leftAuthoritative = left.transientPreview || left.transientTransformFallback ? 0 : 1;
      const rightAuthoritative = right.transientPreview || right.transientTransformFallback ? 0 : 1;
      if (leftAuthoritative !== rightAuthoritative) return rightAuthoritative - leftAuthoritative;
      return Number(right.updatedAt ?? right.previewReceivedAt ?? 0)
        - Number(left.updatedAt ?? left.previewReceivedAt ?? 0);
    })[0];

    for (const objectId of new Set([...(objectIds ?? [])].filter(Boolean).map(String))) {
      const objects = registeredObjectsById(objectId);
      if (objects.length < 2) continue;
      const keep = chooseKeep(objects);
      objects.forEach((object) => {
        if (object === keep) return;
        canvas.remove(object);
        removed += 1;
      });
    }
    return removed;
  }, [registeredObjectsById]);

  const getObjectRecords = useCallback((objects) => {
    const canvas = fabricCanvasRef.current;
    if (!canvas) return [];
    const candidates = [...new Set((Array.isArray(objects) ? objects : [])
      .flatMap((object) => flattenTarget(object))
      .filter((object) => object && !isActiveSelectionObject(object)))];
    const zIndexMap = new Map(canvas.getObjects().map((object, index) => [object, index]));
    return candidates.map((object) => {
      const serialized = serializeObject(object);
      serializedObjectCacheRef.current.set(object, serialized);
      return {
        object: serialized,
        zIndex: zIndexMap.get(object) ?? -1,
      };
    });
  }, []);

  const captureTransformRecordInputs = useCallback((objects, providedZIndexMap = null) => {
    const canvas = fabricCanvasRef.current;
    if (!canvas) return [];
    const candidates = [...new Set((Array.isArray(objects) ? objects : [])
      .flatMap((object) => flattenTarget(object))
      .filter((object) => object && !isActiveSelectionObject(object)))];
    // Layer order is immutable during a move/scale/rotate. Do not traverse every
    // board object just to persist a transform; an optional map is used only by callers
    // that already own one for a real reorder operation.
    const zIndexMap = providedZIndexMap ?? null;
    const baseTimestamp = Date.now();
    return candidates.map((object, index) => {
      const cached = serializedObjectCacheRef.current.get(object) ?? null;
      // Keep each object's placement version strictly increasing even when two fast
      // Pencil gestures finish inside the same millisecond or the device clock moves
      // backwards. The receiver uses this value to reject delayed realtime frames.
      const updatedAt = Math.max(
        baseTimestamp + index,
        Number(object.updatedAt ?? 0) + 1,
        Number(cached?.updatedAt ?? 0) + 1,
      );
      object.updatedAt = updatedAt;
      object.updatedBy = clientIdRef.current;
      return {
        id: String(object.boardObjectId ?? cached?.boardObjectId ?? ''),
        object,
        cached,
        transform: captureSerializedObjectTransform(object, cached ?? {}),
        updatedAt,
        updatedBy: clientIdRef.current,
        zIndex: zIndexMap?.get(object) ?? -1,
      };
    }).filter((entry) => entry.id);
  }, []);

  const updateHistoryButtons = useCallback(() => {
    setCanUndo(undoStackRef.current.length > 0);
    setCanRedo(redoStackRef.current.length > 0);
  }, []);

  const updateSelectionState = useCallback(() => {
    const canvas = fabricCanvasRef.current;
    setSelectedCount(selectionUiObjects(canvas).length);
  }, []);

  const updateSelectionStyleState = useCallback(() => {
    const canvas = fabricCanvasRef.current;
    const objects = selectionUiObjects(canvas);
    if (!objects.length) {
      setSelectionStyle({
        canColor: false,
        canOpacity: false,
        canWidth: false,
        color: '#111827',
        opacity: 1,
        width: 3,
      });
      return;
    }

    const styles = objects.map(probeObjectStyle);
    const firstColor = styles.find((style) => style.canColor && style.color)?.color ?? '#111827';
    const firstOpacity = styles.find((style) => style.canOpacity && Number.isFinite(style.opacity))?.opacity ?? 1;
    const firstWidth = styles.find((style) => style.canWidth && Number.isFinite(style.width))?.width ?? 3;

    setSelectionStyle({
      canColor: styles.some((style) => style.canColor),
      canOpacity: styles.some((style) => style.canOpacity),
      canWidth: styles.some((style) => style.canWidth),
      color: firstColor,
      opacity: firstOpacity,
      width: firstWidth,
    });
  }, []);

  const recordAction = useCallback((action) => {
    if (!action || applyingRemoteRef.current || applyingHistoryRef.current) return;
    undoStackRef.current.push(action);
    if (undoStackRef.current.length > HISTORY_LIMIT) undoStackRef.current.shift();
    redoStackRef.current = [];
    updateHistoryButtons();
  }, [updateHistoryButtons]);

  // Durable operations remain the source of truth. Full snapshot compaction is only
  // for content mutations and long genuine idle periods. Transform-only actions are
  // tiny and replay quickly, so they never schedule this main-thread work.
  const schedulePersistence = useCallback((delay = SNAPSHOT_COMPACTION_IDLE_MS) => {
    if (!isSupabaseConfigured || !canEditRef.current) return;
    snapshotCompactionNeededRef.current = true;
    window.clearTimeout(snapshotPersistTimerRef.current);
    snapshotPersistTimerRef.current = window.setTimeout(() => {
      snapshotPersistTimerRef.current = null;
      snapshotPersistRunnerRef.current?.();
    }, Math.max(1_000, Number(delay ?? SNAPSHOT_COMPACTION_IDLE_MS)));
  }, []);

  const bufferSnapshotAction = useCallback((ops, background, revision) => {
    const incomingRevision = Number(revision ?? 0);
    if (incomingRevision <= 0) return;
    const targetRevision = Number(snapshotCompactTargetRevisionRef.current ?? 0);
    if (incomingRevision <= targetRevision) return;

    if (incomingRevision !== targetRevision + 1) {
      // A missed revision means the buffered compact state can no longer be trusted.
      // The idle compactor will request one authoritative recovery snapshot instead.
      snapshotCompactBaseRef.current = null;
      snapshotCompactBaseRevisionRef.current = 0;
      snapshotCompactActionsRef.current = [];
      snapshotCompactTargetRevisionRef.current = incomingRevision;
      schedulePersistence();
      return;
    }

    const safeOps = Array.isArray(ops) ? ops : [];
    const safeBackground = BACKGROUNDS.has(background) ? background : null;
    snapshotCompactActionsRef.current.push({
      revision: incomingRevision,
      ops: safeOps,
      background: safeBackground,
    });
    snapshotCompactTargetRevisionRef.current = incomingRevision;

    // Replaying a transform only patches a few numbers. Keep it in the journal/buffer,
    // but do not build the whole board snapshot because somebody moved an object.
    const hasContentMutation = Boolean(safeBackground)
      || safeOps.some((op) => op?.type !== 'transform');
    if (hasContentMutation) schedulePersistence();
  }, [schedulePersistence]);

  const applyGameLibraryVisibility = useCallback((visible) => {
    const nextVisible = Boolean(visible);
    gameLibraryVisibleRef.current = nextVisible;
    setGameLibraryVisibleState(nextVisible);
    onAccessChange?.((currentAccess) => (
      currentAccess
        ? { ...currentAccess, gameLibraryVisible: nextVisible }
        : currentAccess
    ));
  }, [onAccessChange]);

  const handleRemoteGameLibraryVisibility = useCallback((message) => {
    if (message?.permission !== 'owner') return;
    applyGameLibraryVisibility(Boolean(message.visible));
  }, [applyGameLibraryVisibility]);

  const toggleGameLibraryVisibility = useCallback(async () => {
    if (!isOwner || gameLibraryVisibilityBusyRef.current) return;
    const previousVisible = Boolean(gameLibraryVisibleRef.current);
    const nextVisible = !previousVisible;
    gameLibraryVisibilityBusyRef.current = true;
    applyGameLibraryVisibility(nextVisible);
    setSaveStatus(nextVisible ? 'Открываю игротеку для участников…' : 'Скрываю игротеку…');
    setSyncTone('saving');

    try {
      await setGameLibraryVisibility(boardId, boardKey, nextVisible);
      try {
        await realtimeRef.current?.sendGameLibraryVisibility?.(nextVisible);
      } catch (realtimeError) {
        console.warn('Видимость игротеки сохранена, но realtime-событие не отправлено', realtimeError);
      }
      if (!nextVisible) {
        try {
          await forceExitGameParticipants({ boardId, boardKey, reason: 'library-closed-by-owner' });
        } catch (forceExitError) {
          // The hidden flag is already persisted. Users in a game will also be returned
          // on their next access check, even if the separate game Edge Function is unavailable.
          console.warn('Игротека скрыта, но принудительный выход из игровой комнаты не отправлен', forceExitError);
        }
      }
      setSaveStatus(nextVisible ? 'Игротека открыта для всех' : 'Игротека скрыта, игры закрыты');
      setSyncTone('saved');
    } catch (caught) {
      console.error(caught);
      applyGameLibraryVisibility(previousVisible);
      setSaveStatus(caught instanceof Error ? caught.message : 'Не удалось изменить видимость игротеки');
      setSyncTone('error');
    } finally {
      gameLibraryVisibilityBusyRef.current = false;
    }
  }, [applyGameLibraryVisibility, boardId, boardKey, isOwner]);

  toggleGameLibraryVisibilityRef.current = toggleGameLibraryVisibility;

  const openGameLibrary = useCallback(async () => {
    const canvas = fabricCanvasRef.current;
    if (canvas) {
      const activeObject = canvas.getActiveObject();
      if (activeObject instanceof IText && activeObject.isEditing) {
        activeObject.exitEditing();
        canvas.fire('text:changed', { target: activeObject });
      }
      canvas.discardActiveObject();
      canvas.requestRenderAll();
      updateSelectionState();
      updateSelectionStyleState();
    }

    setShareOpen(false);
    setSaveStatus('Открываю игротеку…');
    setSyncTone('saving');

    const flushPromise = realtimeRef.current?.flushPending?.();
    if (flushPromise) {
      await Promise.race([
        Promise.resolve(flushPromise).catch(() => undefined),
        new Promise((resolve) => window.setTimeout(resolve, 3500)),
      ]);
    }

    onOpenGameLibrary?.();
  }, [
    onOpenGameLibrary,
    updateSelectionState,
    updateSelectionStyleState,
  ]);

  const updateBackgroundTransform = useCallback(() => {
    const canvas = fabricCanvasRef.current;
    const host = canvasHostRef.current;
    if (!canvas || !host) return;
    const viewport = canvas.viewportTransform ?? [1, 0, 0, 1, 0, 0];
    const currentZoom = canvas.getZoom();
    const spacing = 32 * currentZoom;
    const visualScale = clamp(currentZoom, MIN_ZOOM, 1.25);
    const lineSize = 0.32 + visualScale * 0.68;
    const dotSize = 0.4 + visualScale * 0.85;
    host.style.setProperty('--board-spacing', `${spacing}px`);
    host.style.setProperty('--board-line-size', `${lineSize}px`);
    host.style.setProperty('--board-dot-size', `${dotSize}px`);
    host.style.setProperty('--board-offset-x', `${viewport[4] % spacing}px`);
    host.style.setProperty('--board-offset-y', `${viewport[5] % spacing}px`);
    setViewportVersion((value) => value + 1);
  }, []);

  const applyObjectInteractivityToObjects = useCallback((objects, { render = true } = {}) => {
    const canvas = fabricCanvasRef.current;
    if (!canvas) return;
    const now = Date.now();
    const activeSelection = canvas.getActiveObject();
    const activeSelectionMembers = isActiveSelectionObject(activeSelection)
      && typeof activeSelection.getObjects === 'function'
      ? new Set(activeSelection.getObjects())
      : new Set();
    let renderNeeded = false;

    for (const object of new Set((objects ?? []).filter(Boolean))) {
      const remoteLock = object.boardObjectId ? remoteLocksRef.current.get(object.boardObjectId) : null;
      const lockedByOther = Boolean(remoteLock && Number(remoteLock.expiresAt ?? 0) > now);
      const isLocalSelectionProxy = Boolean(
        object.transientSelectionProxy
        && object.creationClientId === clientIdRef.current
        && localSelectionTransactionRef.current?.proxy === object
      );
      const permanentNonInteractive = Boolean(
        object.isEraserPath
        || object.transientPreview
        || (object.transientSelectionProxy && !isLocalSelectionProxy)
      );
      const canInteract = isLocalSelectionProxy
        || (canEditRef.current && !permanentNonInteractive && !lockedByOther);
      const isActiveSelectionMember = activeSelectionMembers.has(object);
      const nextControls = canInteract && !isActiveSelectionMember;
      const nextBorders = canInteract && !isActiveSelectionMember;
      const nextCursor = lockedByOther ? 'not-allowed' : 'move';

      if (object.selectable !== canInteract) object.selectable = canInteract;
      if (object.evented !== canInteract) object.evented = canInteract;
      if (object.hasControls !== nextControls) { object.hasControls = nextControls; renderNeeded = true; }
      if (object.hasBorders !== nextBorders) { object.hasBorders = nextBorders; renderNeeded = true; }
      if (object.hoverCursor !== nextCursor) object.hoverCursor = nextCursor;
    }

    if (render && renderNeeded) canvas.requestRenderAll();
  }, []);

  const applyObjectInteractivity = useCallback(() => {
    const canvas = fabricCanvasRef.current;
    if (!canvas) return;

    // Object interactivity is persistent and no longer depends on the selected tool.
    // Drawing/text/eraser modes are isolated globally through canvas.skipTargetFind,
    // so switching tools never has to enumerate every object on the board.
    const now = Date.now();
    for (const [objectId, lock] of remoteLocksRef.current) {
      if (Number(lock.expiresAt ?? 0) <= now) remoteLocksRef.current.delete(objectId);
    }

    const activeSelection = canvas.getActiveObject();
    const activeSelectionMembers = isActiveSelectionObject(activeSelection)
      && typeof activeSelection.getObjects === 'function'
      ? new Set(activeSelection.getObjects())
      : new Set();
    let renderNeeded = false;

    for (const object of canvas.getObjects()) {
      const remoteLock = object.boardObjectId ? remoteLocksRef.current.get(object.boardObjectId) : null;
      const lockedByOther = Boolean(remoteLock && Number(remoteLock.expiresAt ?? 0) > now);
      const isLocalSelectionProxy = Boolean(
        object.transientSelectionProxy
        && object.creationClientId === clientIdRef.current
        && localSelectionTransactionRef.current?.proxy === object
      );
      const permanentNonInteractive = Boolean(
        object.isEraserPath
        || object.transientPreview
        || (object.transientSelectionProxy && !isLocalSelectionProxy)
      );
      const canInteract = isLocalSelectionProxy
        || (canEditRef.current && !permanentNonInteractive && !lockedByOther);
      const isActiveSelectionMember = activeSelectionMembers.has(object);
      const nextControls = canInteract && !isActiveSelectionMember;
      const nextBorders = canInteract && !isActiveSelectionMember;
      const nextCursor = lockedByOther ? 'not-allowed' : 'move';

      if (object.selectable !== canInteract) object.selectable = canInteract;
      if (object.evented !== canInteract) object.evented = canInteract;
      if (object.hasControls !== nextControls) {
        object.hasControls = nextControls;
        renderNeeded = true;
      }
      if (object.hasBorders !== nextBorders) {
        object.hasBorders = nextBorders;
        renderNeeded = true;
      }
      if (object.hoverCursor !== nextCursor) object.hoverCursor = nextCursor;
    }

    if (renderNeeded) canvas.requestRenderAll();
  }, []);

  const restoreSelectionMemberControl = useCallback((object) => {
    const state = selectionMemberControlsRef.current.get(object);
    if (!state) return false;
    if (state.hadOwnRenderControls) object._renderControls = state.renderControls;
    else delete object._renderControls;
    if (state.hadOwnDrawBorders) object.drawBorders = state.drawBorders;
    else delete object.drawBorders;
    if (state.hadOwnDrawControls) object.drawControls = state.drawControls;
    else delete object.drawControls;
    selectionMemberControlsRef.current.delete(object);
    return true;
  }, []);

  const restoreSelectionMemberControls = useCallback((keep = new Set()) => {
    for (const object of [...selectionMemberControlsRef.current.keys()]) {
      if (!keep.has(object)) restoreSelectionMemberControl(object);
    }
  }, [restoreSelectionMemberControl]);

  const updateSelectionVisuals = useCallback(() => {
    const canvas = fabricCanvasRef.current;
    if (!canvas) return;
    const active = canvas.getActiveObject();
    const members = isActiveSelectionObject(active) && typeof active.getObjects === 'function'
      ? active.getObjects()
      : [];
    const signature = members.length > 1
      ? `group:${members.map((object) => String(object.boardObjectId ?? object.__uid ?? '')).join('|')}`
      : `single:${String(active?.boardObjectId ?? active?.__uid ?? '')}`;
    if (selectionVisualActiveRef.current === active
      && selectionVisualSignatureRef.current === signature) return;
    selectionVisualActiveRef.current = active;
    selectionVisualSignatureRef.current = signature;

    // Dismantling a large ActiveSelection is already work for Fabric. Restoring custom
    // control methods on every former member in the same pointer event doubled that
    // cost and caused the second Apple Pencil freeze on an empty tap. Keep inactive
    // members visually dormant and restore only the object that becomes active next.
    if (members.length <= 1) {
      const restored = active ? restoreSelectionMemberControl(active) : false;
      if (active && canEditRef.current) {
        active.hasControls = true;
        active.hasBorders = true;
      }
      if (restored) canvas.renderTop?.();
      return;
    }

    members.forEach((object) => {
      if (!selectionMemberControlsRef.current.has(object)) {
        selectionMemberControlsRef.current.set(object, {
          hadOwnRenderControls: Object.prototype.hasOwnProperty.call(object, '_renderControls'),
          renderControls: object._renderControls,
          hadOwnDrawBorders: Object.prototype.hasOwnProperty.call(object, 'drawBorders'),
          drawBorders: object.drawBorders,
          hadOwnDrawControls: Object.prototype.hasOwnProperty.call(object, 'drawControls'),
          drawControls: object.drawControls,
        });
      }
      object._renderControls = () => undefined;
      object.drawBorders = () => object;
      object.drawControls = () => object;
      object.hasControls = false;
      object.hasBorders = false;
    });
    const outerRenderer = FabricObject.prototype._renderControls;
    if (typeof outerRenderer === 'function') {
      active._renderControls = function renderOnlyOuterSelection(ctx, styleOverride) {
        return outerRenderer.call(this, ctx, styleOverride);
      };
    }
    installSelectionMoveHandle(active);
    active.set({
      hasControls: true,
      hasBorders: true,
      subTargetCheck: false,
      objectCaching: false,
    });
    active.setCoords();
    canvas.renderTop?.();
  }, [restoreSelectionMemberControl]);



  const applyCanvasInputMode = useCallback(() => {
    const canvas = fabricCanvasRef.current;
    if (!canvas) return;
    const partialEraser = activeToolRef.current === 'eraser' && eraserModeRef.current === 'partial';
    const shouldDraw = canEditRef.current
      && !eyedropperActiveRef.current
      && (activeToolRef.current === 'pencil' || partialEraser);
    const selectionToolActive = canEditRef.current
      && activeToolRef.current === 'select'
      && !eyedropperActiveRef.current;
    const keepActiveObject = selectionToolActive
      || (canEditRef.current && activeToolRef.current === 'text' && !eyedropperActiveRef.current)
      || (eyedropperActiveRef.current && eyedropperModeRef.current === 'selection');

    // Every tool switch is O(1). Only the select tool enables Fabric target finding;
    // every drawing/text/eraser tool uses the board's own pointer logic.
    canvas.isDrawingMode = shouldDraw;
    canvas.selection = false;
    const drawingEyedropperActive = eyedropperActiveRef.current && eyedropperModeRef.current === 'drawing';

    // Exact pixel target finding is armed only for the actual select-tool pointerdown
    // in capture phase. Keeping it enabled for Pencil hover/move makes Fabric perform a
    // synchronous pixel probe for every high-frequency event and freezes busy boards.
    canvas.perPixelTargetFind = false;
    canvas.targetFindTolerance = selectionToolActive ? 2 : 8;
    canvas.skipTargetFind = !(selectionToolActive || drawingEyedropperActive);

    if (!keepActiveObject && canvas.getActiveObject()) {
      canvas.discardActiveObject();
      canvas.requestRenderAll();
    }

    const toolCursor = activeToolRef.current === 'shape'
      ? 'crosshair'
      : (activeToolRef.current === 'text' ? 'text' : 'default');
    canvas.defaultCursor = eyedropperActiveRef.current ? 'crosshair' : toolCursor;
    canvas.hoverCursor = eyedropperActiveRef.current
      ? 'crosshair'
      : (activeToolRef.current === 'shape' ? 'crosshair' : (activeToolRef.current === 'text' ? 'text' : 'move'));
    if (!canvas.freeDrawingBrush) canvas.freeDrawingBrush = new PencilBrush(canvas);
    if (partialEraser) {
      canvas.freeDrawingBrush.color = '#000000';
      canvas.freeDrawingBrush.width = eraserWidthRef.current;
    } else {
      canvas.freeDrawingBrush.color = hexToRgba(colorRef.current, opacityRef.current);
      canvas.freeDrawingBrush.width = widthRef.current;
    }
  }, []);

  const configureBrushAndMode = useCallback(() => {
    applyCanvasInputMode();
  }, [applyCanvasInputMode]);

  const activateDrawingStyle = useCallback((toolId) => {
    if (!DRAWING_STYLE_TOOL_IDS.has(toolId)) return;
    const style = drawingStylesRef.current[toolId] ?? DEFAULT_DRAWING_STYLES[toolId];
    const nextColor = style?.color ?? '#111827';
    const nextOpacity = clamp(Number(style?.opacity ?? 1), 0.05, 1);
    const nextWidth = clamp(Math.round(Number(style?.width ?? 3)), 1, 100);
    colorRef.current = nextColor;
    opacityRef.current = nextOpacity;
    widthRef.current = nextWidth;
    setColorState(nextColor);
    setOpacityState(nextOpacity);
    setWidthState(nextWidth);
  }, []);

  const setTool = useCallback((nextTool) => {
    if (!canEditRef.current) return;
    const canvas = fabricCanvasRef.current;
    const switchingTool = nextTool !== activeToolRef.current;
    if (switchingTool) {
      // Tool switching is an unconditional escape hatch from a stale Safari Pencil
      // selection/transform. It must work even when a previous pointerup was interrupted
      // by an exception or WebKit omitted the expected compatibility event.
      const selectionSession = selectionPenSessionRef.current;
      const capturedPointerId = selectionSession.pointerId;
      try {
        if (capturedPointerId != null
          && canvas?.upperCanvasEl?.hasPointerCapture?.(capturedPointerId)) {
          canvas.upperCanvasEl.releasePointerCapture(capturedPointerId);
        }
      } catch {
        // WebKit may already have released the capture.
      }
      selectionSession.generation += 1;
      selectionSession.pointerId = null;
      selectionSession.active = false;
      selectionSession.moveFramePending = false;
      selectionSession.compatibilityGuardUntil = 0;
      selectionDragRef.current = null;
      if (selectionMoveFrameRef.current != null) {
        window.cancelAnimationFrame(selectionMoveFrameRef.current);
        selectionMoveFrameRef.current = null;
      }
      const marquee = selectionMarqueeElementRef.current;
      if (marquee) {
        marquee.style.display = 'none';
        marquee.style.width = '0px';
        marquee.style.height = '0px';
      }
      pendingGroupTransformCommitRef.current = null;
      finishPenTransformIsolationRef.current?.({ composite: true, scheduleReconcile: true });
      transformGestureRef.current.activeId = null;
      transformGestureRef.current.pointerType = null;
      modifiedBeforeRef.current = [];
      if (liveTransformSendRef.current.sessionId) {
        endLiveTransform(liveTransformSendRef.current.pendingTarget ?? canvas?.getActiveObject());
      }
      if (localLockIdsRef.current.length) {
        realtimeRef.current?.sendLock(localLockIdsRef.current, false);
        localLockIdsRef.current = [];
      }
    }
    if (switchingTool && mobileTextEditorRef.current) closeMobileTextEditor();
    if (switchingTool && canvas?.getActiveObject()) {
      canvas.discardActiveObject();
      updateSelectionState();
      updateSelectionStyleState();
      canvas.requestRenderAll();
    }
    if (switchingTool) {
      cancelCreationDraftRef.current?.('tool-change');
    }
    if (eyedropperActiveRef.current && nextTool !== activeToolRef.current) {
      const pendingPenSample = eyedropperPenContactRef.current;
      if (pendingPenSample) window.clearTimeout(pendingPenSample.watchdog);
      eyedropperPenContactRef.current = null;
      eyedropperActiveRef.current = false;
      eyedropperModeRef.current = null;
      eyedropperSelectionIdsRef.current = [];
      eyedropperSelectionTransactionIdRef.current = null;
      setEyedropperActive(false);
    }
    if (nextTool !== 'shape') selectedShapeRef.current = null;
    activeToolRef.current = nextTool;
    activateDrawingStyle(nextTool);
    setToolState(nextTool);
    configureBrushAndMode();
  }, [activateDrawingStyle, closeMobileTextEditor, configureBrushAndMode, updateSelectionState, updateSelectionStyleState]);

  const setColor = useCallback((nextColor) => {
    colorRef.current = nextColor;
    if (DRAWING_STYLE_TOOL_IDS.has(activeToolRef.current)) {
      drawingStylesRef.current[activeToolRef.current] = {
        ...drawingStylesRef.current[activeToolRef.current],
        color: nextColor,
      };
    }
    setColorState(nextColor);
    configureBrushAndMode();
  }, [configureBrushAndMode]);

  const setOpacity = useCallback((nextOpacity) => {
    const normalized = clamp(Number(nextOpacity), 0.05, 1);
    opacityRef.current = normalized;
    if (DRAWING_STYLE_TOOL_IDS.has(activeToolRef.current)) {
      drawingStylesRef.current[activeToolRef.current] = {
        ...drawingStylesRef.current[activeToolRef.current],
        opacity: normalized,
      };
    }
    setOpacityState(normalized);
    configureBrushAndMode();
  }, [configureBrushAndMode]);

  const setWidth = useCallback((nextWidth) => {
    const normalized = clamp(Math.round(Number(nextWidth)), 1, 100);
    widthRef.current = normalized;
    if (DRAWING_STYLE_TOOL_IDS.has(activeToolRef.current)) {
      drawingStylesRef.current[activeToolRef.current] = {
        ...drawingStylesRef.current[activeToolRef.current],
        width: normalized,
      };
    }
    setWidthState(normalized);
    configureBrushAndMode();
  }, [configureBrushAndMode]);

  const toggleEyedropper = useCallback(() => {
    if (!canEditRef.current) return;
    const canvas = fabricCanvasRef.current;
    const drawingMode = ['pencil', 'line', 'shape'].includes(activeToolRef.current);
    const active = canvas?.getActiveObject();
    const transaction = active?.transientSelectionProxy
      ? localSelectionTransactionRef.current
      : null;
    const selectionObjects = activeToolRef.current === 'select'
      ? (transaction?.proxy === active && typeof active.getObjects === 'function'
        ? active.getObjects().filter((object) => !object.isEraserPath)
        : (canvas?.getActiveObjects().filter((object) => !object.isEraserPath) ?? []))
      : [];
    const selectionMode = activeToolRef.current === 'select' && selectionObjects.length > 0;
    if (!drawingMode && !selectionMode) return;

    const pendingPenSample = eyedropperPenContactRef.current;
    if (pendingPenSample) {
      window.clearTimeout(pendingPenSample.watchdog);
      eyedropperPenContactRef.current = null;
    }
    const nextActive = !eyedropperActiveRef.current;
    eyedropperActiveRef.current = nextActive;
    setEyedropperActive(nextActive);
    if (nextActive) {
      eyedropperModeRef.current = selectionMode ? 'selection' : 'drawing';
      eyedropperSelectionIdsRef.current = selectionMode
        ? selectionObjects.map((object) => object.boardObjectId).filter(Boolean)
        : [];
      eyedropperSelectionTransactionIdRef.current = transaction?.transactionId ?? null;
      if (drawingMode) canvas?.discardActiveObject();
      canvas?.requestRenderAll();
      setSaveStatus(selectionMode
        ? 'Пипетка: выберите образец для выделенных объектов'
        : 'Пипетка: выберите объект');
    } else {
      eyedropperModeRef.current = null;
      eyedropperSelectionIdsRef.current = [];
      eyedropperSelectionTransactionIdRef.current = null;
      setSaveStatus('Пипетка выключена');
    }
    configureBrushAndMode();
  }, [configureBrushAndMode]);

  const setEraserMode = useCallback((nextMode) => {
    if (!['partial', 'object'].includes(nextMode)) return;
    eraserModeRef.current = nextMode;
    setEraserModeState(nextMode);
    configureBrushAndMode();
  }, [configureBrushAndMode]);

  const setEraserWidth = useCallback((nextWidth) => {
    eraserWidthRef.current = nextWidth;
    setEraserWidthState(nextWidth);
    configureBrushAndMode();
  }, [configureBrushAndMode]);

  const setFontFamily = useCallback((nextFont) => {
    fontFamilyRef.current = nextFont;
    setFontFamilyState(nextFont);
  }, []);

  const setFontSize = useCallback((nextSize) => {
    fontSizeRef.current = nextSize;
    setFontSizeState(nextSize);
  }, []);

  const sendDurableOps = useCallback((ops, {
    atomic = false,
    skipDeferredFlush = false,
    serializedSize: providedSerializedSize = null,
  } = {}) => {
    const source = Array.isArray(ops) ? ops.filter(Boolean) : [];
    const run = () => {
      const realtime = realtimeRef.current;
      const chunks = atomic ? (source.length ? [source] : []) : splitDurableOperations(source);
      if (!realtime || !chunks.length) return Promise.resolve([]);
      // A transform of many objects stays one logical action. The repository already
      // has a staged large-action path, so splitting here only inflated the visible
      // queue and let one Pencil gesture become many pending actions.
      const tasks = chunks.map((chunk, index) => {
        const serializedSize = chunks.length === 1 && Number.isFinite(Number(providedSerializedSize))
          ? Number(providedSerializedSize)
          : serializedCharSize(chunk);
        const objectIds = affectedOperationIds(chunk);
        objectIds.forEach((objectId) => {
          const key = String(objectId);
          pendingLocalObjectMutationCountsRef.current.set(
            key,
            Number(pendingLocalObjectMutationCountsRef.current.get(key) ?? 0) + 1,
          );
        });
        return Promise.resolve(realtime.sendOps(chunk, {
          serializedSize,
          atomic: atomic && index === 0,
        })).finally(() => {
          objectIds.forEach((objectId) => {
            const key = String(objectId);
            const nextCount = Number(pendingLocalObjectMutationCountsRef.current.get(key) ?? 0) - 1;
            if (nextCount > 0) pendingLocalObjectMutationCountsRef.current.set(key, nextCount);
            else pendingLocalObjectMutationCountsRef.current.delete(key);
          });
        });
      });
      return Promise.all(tasks);
    };

    if (!skipDeferredFlush && deferredTransformFlushRef.current) {
      const objectIds = affectedOperationIds(source);
      if (objectIds.size) {
        return Promise.resolve(deferredTransformFlushRef.current({
          force: true,
          objectIds,
        })).then(run);
      }
    }
    return run();
  }, []);


  const sendRecordUpserts = useCallback((records, {
    restore = false,
    reorder = false,
    atomic = true,
    skipDeferredFlush = false,
  } = {}) => {
    if (!records.length) return Promise.resolve([]);
    const ops = records.map((record) => ({
      type: 'upsert',
      object: record.object,
      zIndex: record.zIndex,
      restore,
      reorder,
    }));
    return sendDurableOps(ops, { atomic, skipDeferredFlush });
  }, [sendDurableOps]);

  const sendRecordPatches = useCallback((beforeRecords, afterRecords, {
    reorder = false,
    atomic = true,
    skipDeferredFlush = false,
  } = {}) => {
    const ops = createRecordPatchOps(beforeRecords, afterRecords, { reorder });
    if (!ops.length) return Promise.resolve([]);
    return sendDurableOps(ops, { atomic, skipDeferredFlush });
  }, [sendDurableOps]);

  const sendLightweightTransforms = useCallback((entries, {
    reorder = false,
    skipDeferredFlush = false,
  } = {}) => {
    const op = createLightweightTransformOp(entries, { reorder });
    if (!op) return Promise.resolve([]);
    return sendDurableOps([op], {
      atomic: true,
      skipDeferredFlush,
      serializedSize: serializedCharSize([op]),
    });
  }, [sendDurableOps]);

  const sendPreviewBatches = useCallback(async (records) => {
    const realtime = realtimeRef.current;
    if (!realtime?.sendPreview || !Array.isArray(records) || !records.length) return [];
    const batches = [];
    let batch = [];
    let batchSize = 2;
    for (const record of records) {
      let recordSize = 0;
      try {
        recordSize = JSON.stringify(record).length + 1;
      } catch {
        continue;
      }
      if (batch.length && batchSize + recordSize > 40_000) {
        batches.push(batch);
        batch = [];
        batchSize = 2;
      }
      batch.push(record);
      batchSize += recordSize;
    }
    if (batch.length) batches.push(batch);
    const batchId = randomToken(16);
    const results = await Promise.allSettled(batches.map((previewBatch, chunkIndex) => (
      realtime.sendPreview(previewBatch, {
        batchId,
        chunkIndex,
        chunkCount: batches.length,
      })
    )));
    return results.map((result) => (result.status === 'fulfilled' ? result.value : 'failed'));
  }, []);

  const sendUpserts = useCallback((objects) => {
    sendRecordUpserts(getObjectRecords(objects));
  }, [getObjectRecords, sendRecordUpserts]);

  const sendDeletes = useCallback((ids, { announce = true, atomic = true } = {}) => {
    const safeIds = [...new Set((Array.isArray(ids) ? ids : []).filter(Boolean).map(String))];
    const realtime = realtimeRef.current;
    if (!safeIds.length || !realtime) return Promise.resolve([]);
    if (announce) realtime.sendDeletePreview?.(safeIds).catch?.(() => undefined);
    return sendDurableOps(
      safeIds.map((id) => ({ type: 'delete', id })),
      { atomic },
    );
  }, [sendDurableOps]);


  const beginLocalSelectionTransaction = useCallback(async (objects) => {
    const canvas = fabricCanvasRef.current;
    const members = Array.isArray(objects)
      ? [...new Set(objects.filter((object) => (
        object
        && !object.isEraserPath
        && !object.transientPreview
        && !object.transientSelectionProxy
        && object.boardObjectId
      )))]
      : [];
    if (!canvas || !canEditRef.current || members.length < 2
      || localSelectionTransactionRef.current
      || selectionTransactionTransitionRef.current
      || applyingRemoteRef.current
      || applyingHistoryRef.current) return null;

    const transactionId = randomToken(14);
    const proxyId = `selection-proxy:${transactionId}`;
    selectionTransactionTransitionRef.current = true;
    try {
      // ActiveSelection stores its members in local group coordinates. Discard it first
      // so the source records and the copied proxy both use absolute board coordinates.
      canvas.discardActiveObject();
      members.forEach((object) => object.setCoords());
      const sourceRecords = getObjectRecords(members);
      const sourceIds = sourceRecords
        .map((record) => record.object?.boardObjectId)
        .filter(Boolean)
        .map(String);
      if (sourceIds.length < 2) return null;

      for (const record of sourceRecords) {
        // eslint-disable-next-line no-await-in-loop
        await preloadSerializedImages(record.object);
      }
      const copiedMembers = await util.enlivenObjects(sourceRecords.map((record) => record.object));
      if (copiedMembers.length !== sourceRecords.length) throw new Error('Не удалось создать временную группу');

      const minimumZ = Math.min(...sourceRecords.map((record) => Number(record.zIndex ?? 0)));
      applyingRemoteRef.current = true;
      members.forEach((object) => canvas.remove(object));

      copiedMembers.forEach((object) => {
        object.selectable = false;
        object.evented = false;
        object.hasControls = false;
        object.hasBorders = false;
      });
      const proxy = new Group(copiedMembers, {
        subTargetCheck: false,
        interactive: false,
        objectCaching: false,
        selectable: true,
        evented: true,
        hasControls: true,
        hasBorders: true,
        lockUniScaling: false,
      });
      proxy.boardObjectId = proxyId;
      proxy.objectKind = 'selectionProxy';
      proxy.transientSelectionProxy = true;
      proxy.selectionTransactionId = transactionId;
      proxy.selectionSourceIds = sourceIds;
      proxy.creationClientId = clientIdRef.current;
      proxy.updatedBy = clientIdRef.current;
      proxy.updatedAt = Date.now();
      proxy.previewReceivedAt = Date.now();
      proxy.setCoords();
      canvas.add(proxy);
      if (typeof canvas.bringObjectToFront === 'function') canvas.bringObjectToFront(proxy);

      const transaction = {
        transactionId,
        proxyId,
        proxy,
        sourceIds,
        sourceRecords,
        minimumZ,
        initialProxyMatrix: compactTransformMatrix(proxy.calcTransformMatrix()),
        contentChanged: false,
        committing: false,
        startedAt: Date.now(),
        baseRevision: Number(revisionRef.current ?? 0),
      };
      localSelectionTransactionRef.current = transaction;
      canvas.setActiveObject(proxy);
      applyingRemoteRef.current = false;
      applyObjectInteractivityToObjects([proxy], { render: false });
      updateSelectionState();
      updateSelectionStyleState();
      canvas.requestRenderAll();

      // The receiving device already has the selected objects. Sending only stable
      // ids lets it build the same temporary group locally instead of transferring a
      // potentially huge serialized group containing every line and image.
      realtimeRef.current?.sendSelectionTransaction?.({
        phase: 'start',
        transactionId,
        proxyId,
        sourceIds,
        sourceZIndexes: sourceRecords.map((record) => Number(record.zIndex ?? 0)),
        minimumZ,
        baseRevision: transaction.baseRevision,
      });
      localLockIdsRef.current = [...sourceIds, proxyId];
      realtimeRef.current?.sendLock?.(sourceIds, true);
      return transaction;
    } catch (error) {
      console.error('Не удалось начать групповое выделение', error);
      applyingRemoteRef.current = true;
      members.forEach((object) => {
        if (!canvas.getObjects().includes(object)) canvas.add(object);
      });
      applyingRemoteRef.current = false;
      if (members.length > 1) canvas.setActiveObject(createOuterOnlyActiveSelection(members, canvas));
      canvas.requestRenderAll();
      return null;
    } finally {
      applyingRemoteRef.current = false;
      selectionTransactionTransitionRef.current = false;
    }
  }, [
    applyObjectInteractivityToObjects,
    getObjectRecords,
    updateSelectionState,
    updateSelectionStyleState,
  ]);

  const commitLocalSelectionTransaction = useCallback(async () => {
    const canvas = fabricCanvasRef.current;
    const transaction = localSelectionTransactionRef.current;
    if (!canvas || !transaction || transaction.committing || selectionTransactionTransitionRef.current) return;
    transaction.committing = true;
    selectionTransactionTransitionRef.current = true;
    try {
      const proxy = transaction.proxy;
      const children = typeof proxy?.getObjects === 'function' ? [...proxy.getObjects()] : [];
      if (!proxy || children.length !== transaction.sourceRecords.length) {
        throw new Error('Временная группа повреждена');
      }

      const currentProxyMatrix = compactTransformMatrix(proxy.calcTransformMatrix());
      const transformChanged = transformMatrixDistance(
        currentProxyMatrix,
        transaction.initialProxyMatrix,
      ) > 0.01;

      // Selecting several objects must not rewrite them in Supabase when nothing was
      // actually moved, rotated, scaled or restyled. Restore the originals locally and
      // release the remote preview with a lightweight Ably cancel message.
      if (!transformChanged && !transaction.contentChanged) {
        realtimeRef.current?.sendSelectionTransaction?.({
          phase: 'cancel',
          reason: 'no-change',
          transactionId: transaction.transactionId,
          proxyId: transaction.proxyId,
          sourceIds: transaction.sourceIds,
          baseRevision: transaction.baseRevision,
        });
        applyingRemoteRef.current = true;
        canvas.remove(proxy);
        const restored = await util.enlivenObjects(
          transaction.sourceRecords.map((record) => record.object),
        );
        restored.forEach((object, index) => {
          object.selectable = activeToolRef.current === 'select';
          object.evented = activeToolRef.current === 'select';
          object.hasControls = true;
          object.hasBorders = true;
          object.setCoords();
          canvas.add(object);
          const zIndex = transaction.sourceRecords[index]?.zIndex;
          if (Number.isInteger(zIndex) && typeof canvas.moveObjectTo === 'function') {
            canvas.moveObjectTo(object, clamp(zIndex, 0, canvas.getObjects().length - 1));
          }
        });
        applyingRemoteRef.current = false;
        realtimeRef.current?.sendLock?.(transaction.sourceIds, false);
        localLockIdsRef.current = [];
        localSelectionTransactionRef.current = null;
        applyObjectInteractivity();
        updateSelectionState();
        updateSelectionStyleState();
        canvas.requestRenderAll();
        return;
      }

      const absoluteMatrices = children.map((object) => compactTransformMatrix(object.calcTransformMatrix()));
      const childSerializations = children.map((object) => serializeObject(object));
      for (const serialized of childSerializations) {
        // eslint-disable-next-line no-await-in-loop
        await preloadSerializedImages(serialized);
      }
      const finalObjects = await util.enlivenObjects(childSerializations);
      if (finalObjects.length !== children.length) throw new Error('Не удалось завершить групповое выделение');

      applyingRemoteRef.current = true;
      canvas.remove(proxy);
      finalObjects.forEach((object, index) => {
        const matrix = absoluteMatrices[index];
        if (matrix) util.applyTransformToObject(object, matrix);
        object.boardObjectId = String(
          transaction.sourceRecords[index]?.object?.boardObjectId ?? object.boardObjectId ?? randomToken(10),
        );
        object.updatedAt = Date.now();
        object.updatedBy = clientIdRef.current;
        object.creationSessionId = `${transaction.transactionId}:${index}`;
        object.creationClientId = clientIdRef.current;
        object.selectionTransactionId = transaction.transactionId;
        object.transientPreview = false;
        object.transientLiveDraw = false;
        object.transientSelectionProxy = false;
        object.selectionSourceIds = undefined;
        object.selectable = activeToolRef.current === 'select';
        object.evented = activeToolRef.current === 'select';
        object.hasControls = true;
        object.hasBorders = true;
        object.setCoords();
        canvas.add(object);
        if (typeof canvas.moveObjectTo === 'function') {
          const targetZ = Number(transaction.sourceRecords[index]?.zIndex ?? transaction.minimumZ + index);
          canvas.moveObjectTo(
            object,
            clamp(targetZ, 0, canvas.getObjects().length - 1),
          );
        }
      });
      applyingRemoteRef.current = false;

      const finalRecords = getObjectRecords(finalObjects);
      const finalIds = finalRecords
        .map((record) => record.object?.boardObjectId)
        .filter(Boolean)
        .map(String);
      realtimeRef.current?.sendSelectionTransaction?.({
        phase: 'commit',
        transactionId: transaction.transactionId,
        proxyId: transaction.proxyId,
        sourceIds: transaction.sourceIds,
        finalIds,
        finalCount: finalRecords.length,
        baseRevision: transaction.baseRevision,
      });
      const commitResult = await sendRecordPatches(
        transaction.sourceRecords,
        finalRecords,
        { atomic: true },
      );
      if (!commitResult && navigator.onLine !== false) {
        console.warn('Групповое изменение сохранено локально и ожидает подтверждения сервера');
      }
      recordAction({
        type: 'modify',
        before: transaction.sourceRecords,
        after: finalRecords,
      });
      realtimeRef.current?.sendLock?.(transaction.sourceIds, false);
      localLockIdsRef.current = [];
      localSelectionTransactionRef.current = null;
      applyObjectInteractivityToObjects(finalObjects, { render: false });
      schedulePersistence();
      updateSelectionState();
      updateSelectionStyleState();
      canvas.requestRenderAll();
    } catch (error) {
      console.error('Не удалось завершить групповое выделение', error);
      realtimeRef.current?.sendSelectionTransaction?.({
        phase: 'cancel',
        transactionId: transaction.transactionId,
        proxyId: transaction.proxyId,
        sourceIds: transaction.sourceIds,
        baseRevision: transaction.baseRevision,
      });
      applyingRemoteRef.current = true;
      if (transaction.proxy) canvas.remove(transaction.proxy);
      const restored = await util.enlivenObjects(transaction.sourceRecords.map((record) => record.object));
      restored.forEach((object, index) => {
        canvas.add(object);
        const zIndex = transaction.sourceRecords[index]?.zIndex;
        if (Number.isInteger(zIndex) && typeof canvas.moveObjectTo === 'function') {
          canvas.moveObjectTo(object, clamp(zIndex, 0, canvas.getObjects().length - 1));
        }
      });
      applyingRemoteRef.current = false;
      applyObjectInteractivityToObjects(restored, { render: false });
      localSelectionTransactionRef.current = null;
      realtimeRef.current?.sendLock?.(transaction.sourceIds, false);
      localLockIdsRef.current = [];
      canvas.requestRenderAll();
    } finally {
      applyingRemoteRef.current = false;
      selectionTransactionTransitionRef.current = false;
    }
  }, [
    applyObjectInteractivity,
    applyObjectInteractivityToObjects,
    getObjectRecords,
    recordAction,
    schedulePersistence,
    sendDurableOps,
    sendRecordPatches,
    updateSelectionState,
    updateSelectionStyleState,
  ]);

  const addObjectsToBoard = useCallback((objects, { select = true } = {}) => {
    const canvas = fabricCanvasRef.current;
    if (!canvas || !canEditRef.current || !objects?.length) return [];
    const clientId = clientIdRef.current;
    const added = objects.map((object) => {
      markObject(object, clientId);
      object.selectable = true;
      object.evented = true;
      object.hasControls = true;
      canvas.add(object);
      return object;
    });
    // Serialize while every object still has absolute board coordinates. Fabric
    // rewrites member coordinates when an ActiveSelection is created.
    const records = getObjectRecords(added);
    if (select) {
      canvas.discardActiveObject();
      if (added.length === 1) canvas.setActiveObject(added[0]);
      else canvas.setActiveObject(createOuterOnlyActiveSelection(added, canvas));
    }
    canvas.requestRenderAll();
    sendPreviewBatches(records).catch(() => undefined);
    const commitPromise = sendRecordUpserts(records);
    recordAction({ type: 'add', records });
    schedulePersistence();
    updateSelectionState();
    updateSelectionStyleState();
    return { added, records, commitPromise };
  }, [
    getObjectRecords,
    markObject,
    recordAction,
    schedulePersistence,
    sendPreviewBatches,
    sendRecordUpserts,
    updateSelectionState,
    updateSelectionStyleState,
  ]);

  const getViewportSceneCenter = useCallback(() => {
    const canvas = fabricCanvasRef.current;
    if (!canvas) return new Point(0, 0);
    const inverse = util.invertTransform(canvas.viewportTransform ?? [1, 0, 0, 1, 0, 0]);
    return util.transformPoint(new Point(canvas.getWidth() / 2, canvas.getHeight() / 2), inverse);
  }, []);


  const centerViewportAt = useCallback((sceneX, sceneY, requestedZoom = null) => {
    const canvas = fabricCanvasRef.current;
    if (!canvas || !Number.isFinite(Number(sceneX)) || !Number.isFinite(Number(sceneY))) return;
    const nextZoom = Number.isFinite(Number(requestedZoom))
      ? clamp(Number(requestedZoom), MIN_ZOOM, MAX_ZOOM)
      : canvas.getZoom();
    canvas.setViewportTransform([
      nextZoom,
      0,
      0,
      nextZoom,
      canvas.getWidth() / 2 - Number(sceneX) * nextZoom,
      canvas.getHeight() / 2 - Number(sceneY) * nextZoom,
    ]);
    setZoom(nextZoom);
    updateBackgroundTransform();
    canvas.requestRenderAll();
  }, [updateBackgroundTransform]);

  const stopAutopilotAnimation = useCallback(() => {
    const state = autopilotAnimationRef.current;
    if (state.frame) window.cancelAnimationFrame(state.frame);
    state.frame = null;
    state.target = null;
    state.lastFrameAt = 0;
  }, []);

  const animateViewportTo = useCallback((sceneX, sceneY, requestedZoom = null) => {
    const canvas = fabricCanvasRef.current;
    if (!canvas || !Number.isFinite(Number(sceneX)) || !Number.isFinite(Number(sceneY))) return;
    const state = autopilotAnimationRef.current;
    state.target = {
      centerX: Number(sceneX),
      centerY: Number(sceneY),
      zoom: Number.isFinite(Number(requestedZoom))
        ? clamp(Number(requestedZoom), MIN_ZOOM, MAX_ZOOM)
        : canvas.getZoom(),
    };
    if (state.frame) return;
    state.lastFrameAt = performance.now();

    const step = (now) => {
      state.frame = null;
      const target = state.target;
      const activeCanvas = fabricCanvasRef.current;
      if (!autopilotRef.current || !target || !activeCanvas) {
        state.target = null;
        return;
      }

      const currentCenter = getViewportSceneCenter();
      const currentZoom = activeCanvas.getZoom();
      const dt = Math.min(50, Math.max(1, now - Number(state.lastFrameAt || now)));
      state.lastFrameAt = now;
      // Time-based smoothing prevents jumps and behaves consistently on 60/120 Hz displays.
      const alpha = 1 - Math.exp(-dt / 105);
      const nextCenterX = currentCenter.x + (target.centerX - currentCenter.x) * alpha;
      const nextCenterY = currentCenter.y + (target.centerY - currentCenter.y) * alpha;
      const nextZoom = currentZoom + (target.zoom - currentZoom) * alpha;
      const centerError = Math.hypot(target.centerX - nextCenterX, target.centerY - nextCenterY);
      const zoomError = Math.abs(target.zoom - nextZoom);
      const settled = centerError <= Math.max(0.12, 0.35 / Math.max(nextZoom, MIN_ZOOM))
        && zoomError <= 0.0008;
      const appliedCenterX = settled ? target.centerX : nextCenterX;
      const appliedCenterY = settled ? target.centerY : nextCenterY;
      const appliedZoom = settled ? target.zoom : nextZoom;

      activeCanvas.setViewportTransform([
        appliedZoom,
        0,
        0,
        appliedZoom,
        activeCanvas.getWidth() / 2 - appliedCenterX * appliedZoom,
        activeCanvas.getHeight() / 2 - appliedCenterY * appliedZoom,
      ]);
      if (settled || now - Number(state.lastUiAt || 0) >= 90) {
        state.lastUiAt = now;
        setZoom(appliedZoom);
      }
      updateBackgroundTransform();
      activeCanvas.requestRenderAll();

      if (settled) {
        state.target = null;
        return;
      }
      state.frame = window.requestAnimationFrame(step);
    };

    state.frame = window.requestAnimationFrame(step);
  }, [getViewportSceneCenter, updateBackgroundTransform]);

  const sendTeacherViewNow = useCallback((kind = 'view') => {
    if (!isOwner) return;
    const canvas = fabricCanvasRef.current;
    const realtime = realtimeRef.current;
    if (!canvas || !realtime) return;
    const center = getViewportSceneCenter();
    const payload = {
      centerX: Number(center.x.toFixed(3)),
      centerY: Number(center.y.toFixed(3)),
      zoom: Number(canvas.getZoom().toFixed(4)),
      teacher: true,
      force: kind === 'jump',
      jumpId: kind === 'jump' ? randomToken(8) : undefined,
    };
    if (kind === 'jump') realtime.sendViewJump?.(payload);
    else realtime.sendView?.(payload, { force: kind === 'response' });
  }, [getViewportSceneCenter, isOwner]);

  const sendTeacherViewThrottled = useCallback(() => {
    if (!isOwner) return;
    const state = viewSendRef.current;
    state.pending = true;
    const elapsed = Date.now() - state.lastSentAt;
    const send = () => {
      state.timer = null;
      if (!state.pending || !isOwner) return;
      state.pending = false;
      state.lastSentAt = Date.now();
      sendTeacherViewNow('view');
    };
    if (elapsed >= VIEW_BROADCAST_INTERVAL) send();
    else if (!state.timer) state.timer = window.setTimeout(send, VIEW_BROADCAST_INTERVAL - elapsed);
  }, [isOwner, sendTeacherViewNow]);

  const handleRemoteView = useCallback((message) => {
    if (isOwner || (message?.permission !== 'owner' && message?.teacher !== true)) return;
    if (!Number.isFinite(Number(message?.centerX)) || !Number.isFinite(Number(message?.centerY))) return;
    lastTeacherViewRef.current = message;
    if (autopilotRef.current) {
      animateViewportTo(
        message.centerX,
        message.centerY,
        autopilotZoomForCurrentDevice(message.zoom),
      );
    }
  }, [animateViewportTo, isOwner]);

  const handleRemoteViewJump = useCallback((message) => {
    if (isOwner) return;
    if (!Number.isFinite(Number(message?.centerX)) || !Number.isFinite(Number(message?.centerY))) return;
    if (message?.permission !== 'owner' && message?.teacher !== true && message?.force !== true) return;
    lastTeacherViewRef.current = message;
    stopAutopilotAnimation();
    centerViewportAt(message.centerX, message.centerY, message.zoom);
  }, [centerViewportAt, isOwner, stopAutopilotAnimation]);

  const handleRemoteViewRequest = useCallback(() => {
    if (isOwner) sendTeacherViewNow('response');
  }, [isOwner, sendTeacherViewNow]);

  const toggleAutopilot = useCallback(() => {
    if (isOwner) return;
    const next = !autopilotRef.current;
    autopilotRef.current = next;
    setAutopilot(next);
    if (!next) {
      stopAutopilotAnimation();
      return;
    }
    if (lastTeacherViewRef.current) {
      animateViewportTo(
        lastTeacherViewRef.current.centerX,
        lastTeacherViewRef.current.centerY,
        autopilotZoomForCurrentDevice(lastTeacherViewRef.current.zoom),
      );
    }
    realtimeRef.current?.requestView?.();
  }, [animateViewportTo, isOwner, stopAutopilotAnimation]);

  const bringStudentsToTeacher = useCallback(() => {
    if (isOwner) sendTeacherViewNow('jump');
  }, [isOwner, sendTeacherViewNow]);

  const chooseShapeTool = useCallback((shapeId) => {
    if (!shapeId || !canEditRef.current) return;
    cancelCreationDraftRef.current?.('shape-change');
    selectedShapeRef.current = shapeId;
    activeToolRef.current = 'shape';
    activateDrawingStyle('shape');
    setToolState('shape');
    setSaveStatus('Фигура выбрана — протяните её мышкой или пальцем');
    configureBrushAndMode();
  }, [activateDrawingStyle, configureBrushAndMode]);


  const selectInsertedObjects = useCallback((objects) => {
    const canvas = fabricCanvasRef.current;
    const inserted = (objects ?? []).filter((object) => object?.canvas === canvas);
    if (!canvas || !inserted.length) return;
    selectedShapeRef.current = null;
    activeToolRef.current = 'select';
    setToolState('select');
    configureBrushAndMode();
    canvas.discardActiveObject();
    if (inserted.length === 1) canvas.setActiveObject(inserted[0]);
    else canvas.setActiveObject(createOuterOnlyActiveSelection(inserted, canvas));
    updateSelectionState();
    updateSelectionStyleState();
    canvas.requestRenderAll();
  }, [configureBrushAndMode, updateSelectionState, updateSelectionStyleState]);

  const addImageFiles = useCallback(async (files, scenePoint = null) => {
    const canvas = fabricCanvasRef.current;
    if (!canvas || !canEditRef.current) return;
    const imageFiles = [...files].filter(isAcceptedImageFile);
    if (!imageFiles.length) {
      setSaveStatus('Поддерживаются JPG, PNG, WebP, GIF, HEIC и HEIF');
      setSyncTone('error');
      return;
    }

    const basePoint = scenePoint ?? getViewportSceneCenter();
    const completed = [];
    const failedMessages = [];

    for (let index = 0; index < imageFiles.length; index += 1) {
      const file = imageFiles[index];
      const point = new Point(basePoint.x + index * 24, basePoint.y + index * 24);
      const placeholder = createImagePlaceholder(point);
      markObject(placeholder, clientIdRef.current);
      placeholder.set({ selectable: false, evented: false, hasControls: false });
      canvas.add(placeholder);
      canvas.requestRenderAll();
      const placeholderRecord = getObjectRecords([placeholder]);
      realtimeRef.current?.sendPreview?.(placeholderRecord);
      // The upload placeholder is transient. Persisting it created two authoritative
      // revisions for one image and allowed the final image upsert to overwrite a newer
      // server transform. Only the completed Storage object enters the v8 journal.

      setSaveStatus(`Загружаю изображение ${index + 1} из ${imageFiles.length}…`);
      setSyncTone('saving');
      try {
        // eslint-disable-next-line no-await-in-loop
        const stored = await storeBoardImage(boardId, file);
        // eslint-disable-next-line no-await-in-loop
        const element = await loadImageElement(stored.url, { retries: 10 });
        const object = new FabricImage(element, {
          left: point.x,
          top: point.y,
          originX: 'center',
          originY: 'center',
          objectKind: 'image',
          storagePath: stored.storagePath,
          boardObjectId: placeholder.boardObjectId,
          crossOrigin: /^https?:/i.test(stored.url) ? 'anonymous' : undefined,
        });
        const zoomValue = Math.max(canvas.getZoom(), MIN_ZOOM);
        const maximumWidth = Math.min(560, (canvas.getWidth() / zoomValue) * 0.72);
        const maximumHeight = Math.min(440, (canvas.getHeight() / zoomValue) * 0.72);
        const imageWidth = Number(object.width || element.naturalWidth || 1);
        const imageHeight = Number(object.height || element.naturalHeight || 1);
        const scale = Math.min(1, maximumWidth / imageWidth, maximumHeight / imageHeight);
        object.set({ scaleX: scale, scaleY: scale });
        markObject(object, clientIdRef.current);
        const placeholderIndex = canvas.getObjects().indexOf(placeholder);
        applyingRemoteRef.current = true;
        canvas.remove(placeholder);
        canvas.add(object);
        if (placeholderIndex >= 0) canvas.moveObjectTo(object, placeholderIndex);
        applyingRemoteRef.current = false;
        object.setCoords();
        canvas.requestRenderAll();
        const records = getObjectRecords([object]);
        realtimeRef.current?.sendPreview?.(records);
        // eslint-disable-next-line no-await-in-loop
        const committedResult = await sendRecordUpserts(records);
        recordAction({ type: 'add', records });
        completed.push(object);
        schedulePersistence();

        if (committedResult) {
          revisionRef.current = Math.max(Number(revisionRef.current ?? 0), Number(committedResult.revision ?? 0));
          // eslint-disable-next-line no-await-in-loop
          await realtimeRef.current?.requestSync?.(committedResult.revision);
        }
      } catch (caught) {
        console.error(caught);
        applyingRemoteRef.current = true;
        if (canvas.getObjects().includes(placeholder)) canvas.remove(placeholder);
        applyingRemoteRef.current = false;
        realtimeRef.current?.sendDeletePreview?.(
          [placeholder.boardObjectId],
          { expectDurable: false },
        ).catch?.(() => undefined);
        failedMessages.push(caught instanceof Error ? caught.message : `Не удалось добавить ${file.name}`);
      }
    }

    if (completed.length) selectInsertedObjects(completed);

    if (failedMessages.length) {
      setSaveStatus(completed.length
        ? `Добавлено: ${completed.length}. Ошибка: ${failedMessages[0]}`
        : failedMessages[0]);
      setSyncTone('error');
    } else {
      setSaveStatus('Сохранено');
      setSyncTone('saved');
    }
  }, [
    applyObjectInteractivity,
    boardId,
    configureBrushAndMode,
    getObjectRecords,
    getViewportSceneCenter,
    markObject,
    recordAction,
    schedulePersistence,
    sendDeletes,
    sendRecordUpserts,
    selectInsertedObjects,
    updateSelectionState,
    updateSelectionStyleState,
  ]);

  const mutateSelection = useCallback((mutator, realtimeOperation = null) => {
    const canvas = fabricCanvasRef.current;
    if (!canvas || !canEditRef.current) return;

    const publishOperation = (objects, transaction = null) => {
      if (!realtimeOperation || !realtimeRef.current?.sendSelectionTransaction) return;
      const objectIds = (transaction?.sourceIds?.length
        ? transaction.sourceIds
        : objects.map((object) => object?.boardObjectId).filter(Boolean))
        .map(String);
      if (!objectIds.length) return;
      realtimeRef.current.sendSelectionTransaction({
        phase: 'operation',
        operationId: randomToken(14),
        transactionId: transaction?.transactionId ?? '',
        proxyId: transaction?.proxyId ?? '',
        sourceIds: objectIds,
        objectIds,
        baseRevision: transaction?.baseRevision ?? Number(revisionRef.current ?? 0),
        ...realtimeOperation,
      });
    };

    const active = canvas.getActiveObject();
    if (active?.transientSelectionProxy && typeof active.getObjects === 'function') {
      const objects = active.getObjects().filter((object) => !object.isEraserPath);
      if (!objects.length) return;
      mutator(objects, canvas);
      const transaction = localSelectionTransactionRef.current;
      if (transaction?.proxy === active) transaction.contentChanged = true;
      objects.forEach((object) => {
        object.dirty = true;
        object.setCoords?.();
      });
      active.dirty = true;
      active.setCoords();
      publishOperation(objects, transaction);
      canvas.requestRenderAll();
      updateSelectionState();
      updateSelectionStyleState();
      return;
    }
    const objects = canvas.getActiveObjects().filter((object) => !object.isEraserPath);
    if (!objects.length) return;
    const restoreActiveSelection = isActiveSelectionObject(active) && objects.length > 1;
    if (restoreActiveSelection) {
      canvas.discardActiveObject();
      objects.forEach((object) => object.setCoords());
    }
    const before = getObjectRecords(objects);
    mutator(objects, canvas);
    objects.forEach((object) => markObject(object, clientIdRef.current));
    const after = getObjectRecords(objects);
    // Discrete toolbar transforms are shown through Ably immediately. The same final
    // state is still persisted through Supabase, but the observer no longer waits for
    // the server commit or for the selection to be cleared.
    publishOperation(objects);
    const reorder = realtimeOperation?.operation === 'layer';
    sendRecordPatches(before, after, { reorder });
    recordAction({ type: 'modify', before, after, reorder });
    schedulePersistence();
    if (restoreActiveSelection && activeToolRef.current === 'select') {
      canvas.setActiveObject(createOuterOnlyActiveSelection(objects, canvas));
    }
    canvas.requestRenderAll();
    updateSelectionState();
    updateSelectionStyleState();
  }, [getObjectRecords, markObject, recordAction, schedulePersistence, sendRecordPatches, updateSelectionState, updateSelectionStyleState]);

  const applySelectionColor = useCallback((nextColor) => {
    mutateSelection((objects) => {
      objects.forEach((object) => {
        forEachStyleTarget(object, (target) => {
          if (target.isEraserPath) return;
          if (target.objectKind === 'image' || target.type === 'image') return;
          const currentStyle = probeObjectStyle(target);
          const nextOpacity = currentStyle.canOpacity && Number.isFinite(currentStyle.opacity)
            ? currentStyle.opacity
            : 1;
          if (isTextObject(target)) {
            target.set('fill', hexToRgba(nextColor, nextOpacity));
          } else if (typeof target.stroke === 'string' || Number.isFinite(Number(target.strokeWidth))) {
            target.set('stroke', hexToRgba(nextColor, nextOpacity));
          } else if (typeof target.fill === 'string') {
            target.set('fill', hexToRgba(nextColor, nextOpacity));
          }
          target.dirty = true;
          target.setCoords?.();
        });
        object.dirty = true;
        object.setCoords();
      });
    });
    updateSelectionStyleState();
  }, [mutateSelection, updateSelectionStyleState]);

  const applySelectionOpacity = useCallback((nextOpacity) => {
    mutateSelection((objects) => {
      objects.forEach((object) => {
        forEachStyleTarget(object, (target) => {
          if (target.isEraserPath) return;
          if (target.objectKind === 'image' || target.type === 'image') {
            target.set('opacity', clamp(nextOpacity, 0.05, 1));
          } else if (isTextObject(target)) {
            const color = rgbaToHex(target.fill) ?? '#111827';
            target.set('fill', hexToRgba(color, nextOpacity));
          } else if (typeof target.stroke === 'string' || Number.isFinite(Number(target.strokeWidth))) {
            const color = rgbaToHex(target.stroke) ?? rgbaToHex(target.fill) ?? '#111827';
            target.set('stroke', hexToRgba(color, nextOpacity));
          } else if (typeof target.fill === 'string') {
            const color = rgbaToHex(target.fill) ?? '#111827';
            target.set('fill', hexToRgba(color, nextOpacity));
          }
          target.dirty = true;
          target.setCoords?.();
        });
        object.dirty = true;
        object.setCoords();
      });
    });
    updateSelectionStyleState();
  }, [mutateSelection, updateSelectionStyleState]);

  const applySelectionWidth = useCallback((nextWidth) => {
    mutateSelection((objects) => {
      objects.forEach((object) => {
        forEachStyleTarget(object, (target) => {
          if (target.isEraserPath) return;
          if (Number.isFinite(Number(target.strokeWidth))) {
            target.set('strokeWidth', nextWidth);
            target.dirty = true;
            target.setCoords?.();
          }
        });
        object.dirty = true;
        object.setCoords();
      });
    });
    updateSelectionStyleState();
  }, [mutateSelection, updateSelectionStyleState]);

  const applyEyedropperToSelectionIds = useCallback((ids, sampled, { colorOnly = false } = {}) => {
    const canvas = fabricCanvasRef.current;
    if (!canvas || !canEditRef.current || !ids?.length || !sampled) return [];
    const idSet = new Set(ids.map(String));
    const objects = [...new Set([...idSet].flatMap((id) => registeredObjectsById(id)))]
      .filter((object) => !object.isEraserPath && !object.transientPreview && !object.transientSelectionProxy);
    if (!objects.length) return [];
    const active = canvas.getActiveObject();
    const restoreActiveSelection = isActiveSelectionObject(active) && objects.length > 1;
    if (restoreActiveSelection) {
      canvas.discardActiveObject();
      objects.forEach((object) => object.setCoords());
    }

    const beforeRecords = getObjectRecords(objects);
    const beforeById = new Map(beforeRecords.map((record) => [record.object?.boardObjectId, record]));
    const changedObjects = objects.filter((object) => applySampledStyleToObject(object, sampled, { colorOnly }));
    if (!changedObjects.length) {
      if (restoreActiveSelection && activeToolRef.current === 'select') {
        canvas.setActiveObject(createOuterOnlyActiveSelection(objects, canvas));
        canvas.requestRenderAll();
      }
      return [];
    }

    const before = changedObjects
      .map((object) => beforeById.get(object.boardObjectId))
      .filter(Boolean);
    changedObjects.forEach((object) => markObject(object, clientIdRef.current));
    const after = getObjectRecords(changedObjects);
    sendRecordPatches(before, after);
    recordAction({ type: 'modify', before, after });
    schedulePersistence();
    if (restoreActiveSelection && activeToolRef.current === 'select') {
      canvas.setActiveObject(createOuterOnlyActiveSelection(objects, canvas));
    }
    canvas.requestRenderAll();
    return objects;
  }, [getObjectRecords, markObject, recordAction, registeredObjectsById, schedulePersistence, sendRecordPatches]);

  const applyEyedropperToSelectionTransaction = useCallback((transactionId, sampled, { colorOnly = false } = {}) => {
    const canvas = fabricCanvasRef.current;
    const transaction = localSelectionTransactionRef.current;
    if (!canvas || !canEditRef.current || !transactionId || !sampled
      || transaction?.transactionId !== transactionId
      || !transaction.proxy
      || typeof transaction.proxy.getObjects !== 'function') return [];

    const proxy = transaction.proxy;
    const objects = proxy.getObjects().filter((object) => !object.isEraserPath);
    const changedObjects = objects.filter((object) => applySampledStyleToObject(object, sampled, { colorOnly }));
    if (!changedObjects.length) return [];

    changedObjects.forEach((object) => {
      object.dirty = true;
      object.setCoords?.();
    });
    proxy.dirty = true;
    proxy.setCoords();
    transaction.contentChanged = true;
    canvas.setActiveObject(proxy);
    canvas.requestRenderAll();
    updateSelectionState();
    updateSelectionStyleState();

    realtimeRef.current?.sendSelectionTransaction?.({
      phase: 'style',
      transactionId,
      proxyId: transaction.proxyId,
      sourceIds: transaction.sourceIds,
      baseRevision: transaction.baseRevision,
      sampled: {
        canColor: Boolean(sampled.canColor),
        color: sampled.color ?? null,
        canOpacity: Boolean(sampled.canOpacity),
        opacity: Number.isFinite(Number(sampled.opacity)) ? Number(sampled.opacity) : null,
        canWidth: Boolean(sampled.canWidth),
        width: Number.isFinite(Number(sampled.width)) ? Number(sampled.width) : null,
      },
      colorOnly: Boolean(colorOnly),
    });
    return objects;
  }, [updateSelectionState, updateSelectionStyleState]);

  const moveSelectionForward = useCallback(() => {
    if (fabricCanvasRef.current?.getActiveObject()?.transientSelectionProxy) {
      setSaveStatus('Сначала снимите групповое выделение');
      return;
    }
    mutateSelection((objects, canvas) => {
      [...objects]
        .sort((a, b) => canvas.getObjects().indexOf(b) - canvas.getObjects().indexOf(a))
        .forEach((object) => {
          const index = canvas.getObjects().indexOf(object);
          canvas.moveObjectTo(object, Math.min(canvas.getObjects().length - 1, index + 1));
        });
    }, { operation: 'layer', direction: 'forward' });
  }, [mutateSelection]);

  const moveSelectionBackward = useCallback(() => {
    if (fabricCanvasRef.current?.getActiveObject()?.transientSelectionProxy) {
      setSaveStatus('Сначала снимите групповое выделение');
      return;
    }
    mutateSelection((objects, canvas) => {
      [...objects]
        .sort((a, b) => canvas.getObjects().indexOf(a) - canvas.getObjects().indexOf(b))
        .forEach((object) => {
          const index = canvas.getObjects().indexOf(object);
          canvas.moveObjectTo(object, Math.max(0, index - 1));
        });
    }, { operation: 'layer', direction: 'backward' });
  }, [mutateSelection]);

  const rotateSelection = useCallback((degrees) => {
    mutateSelection((objects) => objects.forEach((object) => {
      object.rotate(Number(object.angle ?? 0) + degrees);
      object.setCoords();
    }), { operation: 'rotate', degrees });
  }, [mutateSelection]);

  const flipSelection = useCallback((axis) => {
    mutateSelection((objects) => objects.forEach((object) => {
      if (axis === 'horizontal') object.set('flipX', !object.flipX);
      else object.set('flipY', !object.flipY);
      object.setCoords();
    }), { operation: 'flip', axis });
  }, [mutateSelection]);

  const applyRecordsLocally = useCallback(async (records) => {
    const canvas = fabricCanvasRef.current;
    const validRecords = (Array.isArray(records) ? records : [])
      .filter((record) => record?.object?.boardObjectId);
    if (!canvas || !validRecords.length) return;

    canvas.discardActiveObject();
    const previousRenderOnAddRemove = canvas.renderOnAddRemove;
    canvas.renderOnAddRemove = false;
    try {
      validRecords.forEach((record) => removeRegisteredObjectsById(record.object.boardObjectId));
      await Promise.all(validRecords.map((record) => preloadSerializedImages(record.object)));
      const revivedObjects = await util.enlivenObjects(validRecords.map((record) => record.object));
      revivedObjects.forEach((revived, index) => {
        if (!revived) return;
        const record = validRecords[index];
        revived.selectable = false;
        revived.evented = false;
        revived.hasControls = false;
        canvas.add(revived);
        serializedObjectCacheRef.current.set(revived, record.object);
        applyObjectInteractivityToObjects([revived], { render: false });
        if (Number.isInteger(record.zIndex) && typeof canvas.moveObjectTo === 'function') {
          canvas.moveObjectTo(revived, clamp(record.zIndex, 0, canvas.getObjects().length - 1));
        }
      });
    } finally {
      canvas.renderOnAddRemove = previousRenderOnAddRemove;
    }
    canvas.requestRenderAll();
    updateSelectionState();
    updateSelectionStyleState();
  }, [applyObjectInteractivityToObjects, removeRegisteredObjectsById, updateSelectionState, updateSelectionStyleState]);

  const removeIdsLocally = useCallback((ids) => {
    const canvas = fabricCanvasRef.current;
    if (!canvas) return;
    const objects = [...new Set((Array.isArray(ids) ? ids : [])
      .flatMap((id) => registeredObjectsById(id)))];
    const composedDelete = localDeletionCompositorRef.current?.removeObjects?.(objects);
    if (!composedDelete) {
      canvas.discardActiveObject();
      const previousRenderOnAddRemove = canvas.renderOnAddRemove;
      canvas.renderOnAddRemove = false;
      try {
        for (const id of ids) removeRegisteredObjectsById(id);
      } finally {
        canvas.renderOnAddRemove = previousRenderOnAddRemove;
      }
      canvas.requestRenderAll();
    }
    updateSelectionState();
    updateSelectionStyleState();
  }, [registeredObjectsById, removeRegisteredObjectsById, updateSelectionState, updateSelectionStyleState]);

  const applyBackground = useCallback((nextBackground, { broadcast = false, persist = false } = {}) => {
    if (!BACKGROUNDS.has(nextBackground)) return;
    backgroundRef.current = nextBackground;
    setBackgroundState(nextBackground);
    updateBackgroundTransform();
    fabricCanvasRef.current?.requestRenderAll?.();
    if (broadcast) {
      const commit = realtimeRef.current?.sendSettings({ background: nextBackground });
      if (commit?.then) {
        pendingLocalBackgroundMutationCountRef.current += 1;
        Promise.resolve(commit)
          .catch(() => undefined)
          .finally(() => {
            pendingLocalBackgroundMutationCountRef.current = Math.max(
              0,
              pendingLocalBackgroundMutationCountRef.current - 1,
            );
          });
      }
    }
    if (persist) schedulePersistence();
  }, [schedulePersistence, updateBackgroundTransform]);

  const changeBackground = useCallback((nextBackground) => {
    if (!isOwner || !BACKGROUNDS.has(nextBackground) || nextBackground === backgroundRef.current) return;
    const before = backgroundRef.current;
    applyBackground(nextBackground, { broadcast: true, persist: true });
    recordAction({ type: 'background', before, after: nextBackground });
  }, [applyBackground, isOwner, recordAction]);

  const getLocalMutationIds = useCallback(({ includePending = true } = {}) => {
    const ids = new Set([
      ...(localLockIdsRef.current ?? []).filter(Boolean).map(String),
      ...(includePending && !rebasingPendingActionsRef.current
        ? pendingLocalObjectMutationCountsRef.current.keys()
        : []),
    ]);
    const activePencilId = activePencilRef.current?.objectId;
    const liveDrawId = liveDrawSendRef.current?.objectId;
    if (activePencilId) ids.add(String(activePencilId));
    if (liveDrawId && liveDrawSendRef.current?.acceptingPoints) ids.add(String(liveDrawId));
    textBeforeRef.current.forEach((_records, objectId) => ids.add(String(objectId)));

    const liveTarget = liveTransformSendRef.current?.pendingTarget;
    if (liveTransformSendRef.current?.sessionId && liveTarget) {
      flattenTarget(liveTarget).forEach((object) => {
        if (object?.boardObjectId) ids.add(String(object.boardObjectId));
      });
    }

    const selectionTransaction = localSelectionTransactionRef.current;
    (selectionTransaction?.sourceIds ?? []).forEach((objectId) => ids.add(String(objectId)));
    if (selectionTransaction?.proxyId) ids.add(String(selectionTransaction.proxyId));
    return ids;
  }, []);

  const persistFullSnapshot = useCallback(async () => {
    if (!canEditRef.current || !boardReadyRef.current) return;
    if (!snapshotCompactionNeededRef.current) return;

    // Never start whole-board JSON work near live input. Transform operations already
    // replay in a few microseconds, so waiting for a real idle period is always cheaper
    // than stealing a frame from Apple Pencil.
    const interactionAge = Date.now() - Number(lastBoardInteractionAtRef.current ?? 0);
    if (interactionAge < SNAPSHOT_COMPACTION_IDLE_MS) {
      schedulePersistence(SNAPSHOT_COMPACTION_IDLE_MS - interactionAge);
      return;
    }

    if (snapshotPersistInFlightRef.current) {
      snapshotPersistQueuedRef.current = true;
      return;
    }
    if (pendingServerWritesRef.current > 0 || getLocalMutationIds().size > 0) {
      schedulePersistence(1_200);
      return;
    }

    const requestedRevision = Number(revisionRef.current ?? 0);
    if (requestedRevision <= Number(lastSnapshotSavedRevisionRef.current ?? 0)) return;

    snapshotPersistInFlightRef.current = true;
    snapshotPersistQueuedRef.current = false;
    try {
      let snapshot = null;
      let snapshotRevision = requestedRevision;
      const baseSnapshot = snapshotCompactBaseRef.current;
      const baseRevision = Number(snapshotCompactBaseRevisionRef.current ?? 0);
      const bufferedActions = snapshotCompactActionsRef.current
        .filter((action) => Number(action?.revision ?? 0) <= requestedRevision)
        .sort((left, right) => Number(left.revision ?? 0) - Number(right.revision ?? 0));

      let expectedRevision = baseRevision;
      let bufferedSequenceComplete = Boolean(baseSnapshot) && baseRevision <= requestedRevision;
      const compactActions = [];
      if (bufferedSequenceComplete) {
        for (const action of bufferedActions) {
          const actionRevision = Number(action.revision ?? 0);
          if (actionRevision <= baseRevision) continue;
          if (actionRevision !== expectedRevision + 1) {
            bufferedSequenceComplete = false;
            break;
          }
          compactActions.push(action);
          expectedRevision = actionRevision;
        }
        if (expectedRevision !== requestedRevision) bufferedSequenceComplete = false;
      }

      if (bufferedSequenceComplete) {
        // Clone once and apply the buffered actions in exact revision order. This avoids
        // traversing the live Fabric canvas after a pause, so Pencil input stays responsive.
        snapshot = applyActionsToSnapshot(baseSnapshot, compactActions);
      } else if (isSupabaseConfigured) {
        const recovery = await getBoardRecovery(boardId, boardKey);
        if (!recovery?.snapshot) throw new Error('Сервер не вернул снимок для сжатия');
        snapshot = applyOpsToSnapshot(recovery.snapshot, []);
        snapshotRevision = Number(recovery.revision ?? requestedRevision);
        if (snapshotRevision < requestedRevision) {
          schedulePersistence(1_500);
          return;
        }
      } else {
        return;
      }

      const savedRevision = await saveBoardSnapshot(
        boardId,
        boardKey,
        snapshot,
        snapshotRevision,
      );
      if (Number(savedRevision ?? snapshotRevision) < snapshotRevision) {
        throw new Error('Сервер сохранил снимок более старой ревизии');
      }
      // The JSON was built for snapshotRevision, so never claim that it represents a
      // later drawing revision even if an older backend returns a larger service value.
      lastSnapshotSavedRevisionRef.current = snapshotRevision;
      snapshotCompactBaseRef.current = snapshot;
      snapshotCompactBaseRevisionRef.current = snapshotRevision;
      snapshotCompactActionsRef.current = snapshotCompactActionsRef.current.filter(
        (action) => Number(action?.revision ?? 0) > snapshotRevision,
      );
      snapshotCompactTargetRevisionRef.current = snapshotCompactActionsRef.current.length
        ? Number(snapshotCompactActionsRef.current.at(-1)?.revision ?? snapshotRevision)
        : snapshotRevision;

      await setCachedSnapshot(boardId, {
        snapshot,
        revision: snapshotRevision,
        savedAt: Date.now(),
      });
      await pruneConfirmedActionsThrough(boardId, snapshotRevision);

      if (Number(revisionRef.current ?? 0) > snapshotRevision) {
        schedulePersistence();
      } else {
        snapshotCompactionNeededRef.current = false;
      }
    } catch (caught) {
      console.warn('Не удалось сжать доску в быстрый снимок', caught);
      schedulePersistence();
    } finally {
      snapshotPersistInFlightRef.current = false;
      if (snapshotPersistQueuedRef.current) {
        snapshotPersistQueuedRef.current = false;
        schedulePersistence();
      }
    }
  }, [boardId, boardKey, getLocalMutationIds, schedulePersistence]);

  snapshotPersistRunnerRef.current = persistFullSnapshot;

  const retryPendingServerImages = useCallback(async () => {
    if (pendingImageRetryInFlightRef.current) return;
    const canvas = fabricCanvasRef.current;
    if (!canvas) return;
    const pending = canvas.getObjects().filter((object) => (
      object?.pendingImage
      && object?.pendingImageSerialized
      && object?.boardObjectId
    ));
    if (!pending.length) return;

    pendingImageRetryInFlightRef.current = true;
    const queue = [...pending];
    try {
      const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
        while (queue.length) {
          const placeholder = queue.shift();
          const serialized = placeholder?.pendingImageSerialized;
          const objectId = String(placeholder?.boardObjectId ?? '');
          if (!serialized || !objectId || getLocalMutationIds().has(objectId)) continue;
          try {
            // Different pictures load independently, so one slow CDN response cannot
            // hold every other image on the board behind it.
            // eslint-disable-next-line no-await-in-loop
            await preloadSerializedImages(serialized);
            // eslint-disable-next-line no-await-in-loop
            const [revived] = await util.enlivenObjects([serialized]);
            if (!revived) continue;
            const current = boardObjectsById(canvas, objectId).find((object) => object.pendingImage);
            if (!current) continue;
            const zIndex = canvas.getObjects().indexOf(current);
            applyingRemoteRef.current = true;
            canvas.remove(current);
            revived.pendingImage = false;
            revived.pendingImageSerialized = undefined;
            revived.transientPreview = false;
            canvas.add(revived);
            serializedObjectCacheRef.current.set(revived, serialized);
            if (zIndex >= 0 && typeof canvas.moveObjectTo === 'function') {
              canvas.moveObjectTo(revived, clamp(zIndex, 0, canvas.getObjects().length - 1));
            }
            revived.setCoords?.();
          } catch {
            // Storage/CDN can still be warming up. The next retry keeps the same objectId.
          } finally {
            applyingRemoteRef.current = false;
          }
        }
      });
      await Promise.all(workers);
      applyObjectInteractivity();
      canvas.requestRenderAll();
    } finally {
      pendingImageRetryInFlightRef.current = false;
    }
  }, [applyObjectInteractivity, getLocalMutationIds]);

  const applyAuthoritativeSnapshot = useCallback((snapshot, revision) => {
    const task = authoritativeApplyQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        const canvas = fabricCanvasRef.current;
        if (!canvas || !snapshot?.canvas) return;
        if (Number(revision ?? 0) < Number(revisionRef.current ?? 0)) return;

        const selectedIds = canvas
          .getActiveObjects()
          .map((object) => object.boardObjectId)
          .filter(Boolean);
        const viewport = [...(canvas.viewportTransform ?? [1, 0, 0, 1, 0, 0])];
        const now = Date.now();
        const protectedDeletedIds = new Set(
          [...remoteDeletedObjectIdsRef.current.entries()]
            .filter(([, tombstone]) => (
              !tombstone?.confirmed
              && now - Number(tombstone?.timestamp ?? 0) < 30000
            ))
            .map(([id]) => String(id)),
        );
        const sanitizedSnapshot = applyOpsToSnapshot(snapshot, []);
        const effectiveSnapshot = protectedDeletedIds.size
          ? {
            ...sanitizedSnapshot,
            canvas: {
              ...sanitizedSnapshot.canvas,
              objects: (sanitizedSnapshot.canvas.objects ?? []).filter((object) => (
                !protectedDeletedIds.has(String(object?.boardObjectId ?? ''))
              )),
            },
          }
          : sanitizedSnapshot;

        applyingRemoteRef.current = true;
        try {
          await loadCanvasJsonProgressively(canvas, effectiveSnapshot.canvas);
          rebuildObjectRegistry();
          deduplicateBoardObjects(canvas);
          rebuildObjectRegistry();
          penTransformSpatialApiRef.current?.rebuild?.();
          if (BACKGROUNDS.has(effectiveSnapshot.background)) applyBackground(effectiveSnapshot.background);
          canvas.setViewportTransform(viewport);
          applyObjectInteractivity();

          if (activeToolRef.current === 'select' && selectedIds.length) {
            const selectedObjects = selectedIds
              .map((id) => canvas.getObjects().find((object) => object.boardObjectId === id))
              .filter(Boolean);
            if (selectedObjects.length === 1) {
              canvas.setActiveObject(selectedObjects[0]);
            } else if (selectedObjects.length > 1) {
              canvas.setActiveObject(createOuterOnlyActiveSelection(selectedObjects, canvas));
            }
          }

          revisionRef.current = Number(revision ?? revisionRef.current);
          snapshotCompactBaseRef.current = sanitizedSnapshot;
          snapshotCompactBaseRevisionRef.current = revisionRef.current;
          snapshotCompactActionsRef.current = [];
          snapshotCompactTargetRevisionRef.current = revisionRef.current;
          updateBackgroundTransform();
          updateSelectionState();
          updateSelectionStyleState();
          canvas.requestRenderAll();
          await setCachedSnapshot(boardId, {
            snapshot: effectiveSnapshot,
            revision: revisionRef.current,
            savedAt: Date.now(),
          });
          await pruneConfirmedActionsThrough(boardId, revisionRef.current);
          retryPendingServerImages();
          schedulePersistence(1_000);
        } finally {
          applyingRemoteRef.current = false;
        }
      });

    authoritativeApplyQueueRef.current = task;
    return task;
  }, [
    applyBackground,
    applyObjectInteractivity,
    rebuildObjectRegistry,
    boardId,
    retryPendingServerImages,
    schedulePersistence,
    updateBackgroundTransform,
    updateSelectionState,
    updateSelectionStyleState,
  ]);

  const syncFromServer = useCallback(async (force = false) => {
    if (!isSupabaseConfigured || !boardReadyRef.current) return;
    if (force) syncForceRef.current = true;
    if (syncInFlightRef.current) {
      syncRequestedRef.current = true;
      return;
    }
    // Local actions remain visible until Supabase confirms them. Waiting for the short
    // durable-write queue to drain prevents an insurance pass from overwriting an
    // unconfirmed local result. The queued sync starts immediately after pending = 0.
    if (pendingServerWritesRef.current > 0) {
      syncRequestedRef.current = true;
      return;
    }

    syncInFlightRef.current = true;
    syncForceRef.current = false;
    const startingRevision = Number(revisionRef.current ?? 0);
    setSyncTone('recovering');

    const rejectJournalGap = async (reason) => {
      // v8 never repairs an active board by replacing every object. Keep the current
      // canvas intact and retry the authoritative log; a missing revision is a server
      // protocol error, not permission to run an expensive whole-board comparison.
      console.warn('Authoritative v8 journal gap:', reason);
      setSaveStatus('Ожидаю пропущенную серверную ревизию…');
      setSyncTone('recovering');
      window.setTimeout(() => syncFromServer(true), 600);
      return true;
    };

    try {
      // This heartbeat reads only the authoritative revision. Object verification is
      // driven by committed actions below; there is deliberately no periodic full-board
      // count/hash scan, even while idle.
      let serverState = await getBoardRevision(boardId, boardKey);
      if (!serverState) return;
      let serverRevision = Number(serverState.revision ?? 0);
      let currentRevision = Number(revisionRef.current ?? 0);

      if (serverRevision < currentRevision) {
        // A stale replica/read must never replace a newer confirmed local canvas with
        // an older snapshot. A later event or heartbeat will retry the O(1) revision read.
        console.warn('Server revision is temporarily behind the confirmed local revision');
        window.setTimeout(() => syncFromServer(false), 1_000);
        return;
      }

      let pageCount = 0;
      while (serverRevision > currentRevision) {
        pageCount += 1;
        if (pageCount > 100) throw new Error('Слишком много страниц журнала синхронизации');

        // eslint-disable-next-line no-await-in-loop
        const changes = await getBoardChanges(
          boardId,
          boardKey,
          currentRevision,
          INSURANCE_SYNC_PAGE_SIZE,
        );
        if (changes === null) {
          await rejectJournalGap('operation journal RPC is unavailable');
          return;
        }
        if (!changes.length) {
          await rejectJournalGap('journal has a revision gap');
          return;
        }

        let progressed = false;
        for (const action of changes) {
          const actionRevision = Number(action?.revision ?? 0);
          if (actionRevision <= currentRevision) continue;
          if (actionRevision !== currentRevision + 1) {
            await rejectJournalGap(`expected revision ${currentRevision + 1}, received ${actionRevision}`);
            return;
          }

          const applyOperation = applyRemoteOpsRef.current;
          if (!applyOperation) return;
          // Both Ably actions and insurance actions use the same authoritative queue.
          // eslint-disable-next-line no-await-in-loop
          const applied = await applyOperation(
            action.ops,
            actionRevision,
            false,
            action.background,
            action.actionId,
            action.clientId,
          );
          if (!applied) {
            // applyRemoteOps schedules the delayed retry. Do not enqueue a second one here.
            return;
          }
          currentRevision = Number(revisionRef.current ?? currentRevision);
          progressed = true;
        }

        if (!progressed) {
          await rejectJournalGap('journal page made no progress');
          return;
        }

        // A concurrent participant can append revisions while this page is applying.
        // Refresh the target after every short/final page instead of guessing its end.
        if (changes.length < INSURANCE_SYNC_PAGE_SIZE || currentRevision >= serverRevision) {
          // eslint-disable-next-line no-await-in-loop
          serverState = await getBoardRevision(boardId, boardKey);
          serverRevision = Number(serverState?.revision ?? currentRevision);
        }
      }

      if (Number(revisionRef.current ?? 0) > startingRevision) {
        setSaveStatus('Пропущенные изменения восстановлены');
        setSyncTone('recovered');
        window.clearTimeout(transientStatusTimerRef.current);
        transientStatusTimerRef.current = window.setTimeout(() => {
          setSaveStatus('Сохранено');
          setSyncTone('saved');
        }, 2200);
      } else {
        setSyncTone('saved');
      }
    } catch (caught) {
      console.error(caught);
      setSaveStatus(navigator.onLine === false ? 'Нет соединения' : 'Ошибка страховочной синхронизации');
      setSyncTone(navigator.onLine === false ? 'offline' : 'error');
    } finally {
      syncInFlightRef.current = false;
      if (syncRequestedRef.current && pendingServerWritesRef.current === 0) {
        const nextForce = syncForceRef.current;
        syncRequestedRef.current = false;
        syncForceRef.current = false;
        window.setTimeout(() => syncFromServer(nextForce), 0);
      }
    }
  }, [
    applyAuthoritativeSnapshot,
    boardId,
    boardKey,
    getLocalMutationIds,
    seedAuthoritativeSnapshot,
  ]);

  const replayPendingActionsLocally = useCallback(async (actions) => {
    const canvas = fabricCanvasRef.current;
    const pendingActions = Array.isArray(actions) ? actions : [];
    const ops = pendingActions.flatMap((action) => (
      Array.isArray(action?.ops) ? action.ops : []
    ));
    const pendingBackground = [...pendingActions]
      .reverse()
      .find((action) => BACKGROUNDS.has(action?.background))?.background ?? null;
    if (!canvas || (!ops.length && !pendingBackground)) return;

    const selectedIds = canvas.getActiveObjects()
      .map((object) => object.boardObjectId)
      .filter(Boolean)
      .map(String);
    const affectedIds = affectedOperationIds(ops);
    const touchesSelection = selectedIds.some((id) => affectedIds.has(id));
    const prepared = ops.map((op) => ({ op, revived: null, serialized: null }));
    const reviveEntries = prepared
      .map((entry, index) => {
        const { op } = entry;
        if (op?.type === 'upsert' && op.object?.boardObjectId) {
          return { ...entry, index, serialized: op.object };
        }
        if (op?.type !== 'patch' || !op.id) return null;
        const current = registeredObjectsById(op.id).find((object) => (
          !object.transientPreview
          && !object.transientTransformFallback
          && !object.transientSelectionProxy
        ));
        const source = current?.pendingImageSerialized
          ?? serializedObjectCacheRef.current.get(current)
          ?? (current ? serializeObject(current) : null);
        const serialized = applySerializedObjectPatch(source, op);
        return serialized ? { ...entry, index, serialized } : null;
      })
      .filter(Boolean);

    if (reviveEntries.length) {
      reviveEntries.forEach((entry) => {
        prepared[entry.index].serialized = entry.serialized;
      });
      const serialized = reviveEntries.map((entry) => entry.serialized);
      try {
        await preloadSerializedImages(serialized);
        const revived = await util.enlivenObjects(serialized);
        reviveEntries.forEach((entry, index) => {
          prepared[entry.index].revived = revived[index] ?? null;
        });
      } catch {
        for (const entry of reviveEntries) {
          try {
            // eslint-disable-next-line no-await-in-loop
            await preloadSerializedImages(entry.serialized);
            // eslint-disable-next-line no-await-in-loop
            const [revived] = await util.enlivenObjects([entry.serialized]);
            prepared[entry.index].revived = revived ?? null;
          } catch {
            const serializedType = String(entry.serialized?.type ?? '').toLowerCase();
            if (serializedType !== 'image' && entry.serialized?.objectKind !== 'image') throw new Error('Не удалось восстановить локальный объект');
            prepared[entry.index].revived = createPendingImagePlaceholder(entry.serialized);
          }
        }
      }
    }

    applyingRemoteRef.current = true;
    const previousRenderOnAddRemove = canvas.renderOnAddRemove;
    canvas.renderOnAddRemove = false;
    try {
      if (touchesSelection) canvas.discardActiveObject();
      const touched = [];
      const atomicReorderIds = new Set(prepared
        .filter(({ op }) => (
          (op?.type === 'upsert' && Boolean(op.reorder || op.restore) && op.object?.boardObjectId)
          || (op?.type === 'patch' && op.reorder && op.id)
        ))
        .map(({ op }) => String(op.object?.boardObjectId ?? op.id)));
      atomicReorderIds.forEach((objectId) => removeRegisteredObjectsById(objectId));
      for (const { op, revived, serialized } of prepared) {
        if (op?.type === 'delete' && op.id) {
          removeRegisteredObjectsById(op.id);
          continue;
        }
        if (op?.type === 'transform') {
          for (const patch of transformOperationEntries(op)) {
            const object = registeredObjectsById(patch?.id).find((candidate) => (
              !candidate.transientPreview
              && !candidate.transientTransformFallback
              && !candidate.transientSelectionProxy
            ));
            if (!object || !patch?.transform) continue;
            object.set(patch.transform);
            object.updatedAt = Number(patch.updatedAt ?? object.updatedAt ?? Date.now());
            object.updatedBy = patch.updatedBy ?? object.updatedBy ?? clientIdRef.current;
            object.dirty = true;
            object.setCoords();
            touched.push(object);
          }
          continue;
        }
        const replacementId = op?.type === 'patch' ? op.id : op?.object?.boardObjectId;
        if (!['upsert', 'patch'].includes(op?.type) || !replacementId || !revived) continue;
        const previous = registeredObjectsById(replacementId)[0] ?? null;
        const previousIndex = previous ? canvas.getObjects().indexOf(previous) : -1;
        removeRegisteredObjectsById(replacementId);
        revived.transientPreview = false;
        revived.transientLiveDraw = false;
        revived.transientAwaitingCommit = false;
        canvas.add(revived);
        serializedObjectCacheRef.current.set(revived, serialized ?? op.object ?? serializeObject(revived));
        touched.push(revived);
        const requestedIndex = op.type === 'upsert'
          ? (op.preserveOrder && previousIndex >= 0 ? previousIndex : op.zIndex)
          : (op.reorder && Number.isInteger(op.zIndex) ? op.zIndex : previousIndex);
        if (Number.isInteger(requestedIndex) && requestedIndex >= 0
          && typeof canvas.moveObjectTo === 'function') {
          canvas.moveObjectTo(revived, clamp(requestedIndex, 0, canvas.getObjects().length - 1));
        }
      }
      deduplicateRegisteredObjectIds(affectedIds);
      if (BACKGROUNDS.has(pendingBackground)) applyBackground(pendingBackground);
      if (touched.length) penTransformSpatialApiRef.current?.updateObjects?.(touched);
      applyObjectInteractivityToObjects(touched, { render: false });
      if (touchesSelection && activeToolRef.current === 'select' && selectedIds.length) {
        const selectedObjects = selectedIds
          .map((id) => registeredObjectsById(id).find((object) => (
            !object.transientPreview
            && !object.transientTransformFallback
            && !object.transientSelectionProxy
          )))
          .filter(Boolean);
        if (selectedObjects.length === 1) canvas.setActiveObject(selectedObjects[0]);
        else if (selectedObjects.length > 1) {
          canvas.setActiveObject(createOuterOnlyActiveSelection(selectedObjects, canvas));
        }
      }
    } finally {
      applyingRemoteRef.current = false;
      canvas.renderOnAddRemove = previousRenderOnAddRemove;
      canvas.requestRenderAll();
    }
  }, [
    applyBackground,
    applyObjectInteractivityToObjects,
    deduplicateRegisteredObjectIds,
    registeredObjectsById,
    removeRegisteredObjectsById,
  ]);

  const reconcileAuthoritativeIds = useCallback(async (
    objectIds,
    { includePendingMutations = true } = {},
  ) => {
    const ids = [...new Set((Array.isArray(objectIds) ? objectIds : [...(objectIds ?? [])])
      .filter(Boolean)
      .map(String))];
    if (!ids.length || !fabricCanvasRef.current) return true;
    const localMutationIds = getLocalMutationIds({ includePending: includePendingMutations });
    const safeIds = ids.filter((id) => !localMutationIds.has(id));
    if (!safeIds.length) return false;
    const ops = safeIds
      .map((id) => authoritativeObjectStatesRef.current.get(id)?.op)
      .filter(Boolean);
    if (!ops.length) return false;
    if (verifyAuthoritativeOps(ops)) return true;
    await replayPendingActionsLocally([{ ops }]);
    if (!verifyAuthoritativeOps(ops)) {
      throw new Error(`Адресное восстановление не прошло для ${safeIds.join(', ')}`);
    }
    return safeIds.length === ids.length;
  }, [getLocalMutationIds, replayPendingActionsLocally, verifyAuthoritativeOps]);

  const runTargetedReconciliation = useCallback(async () => {
    const state = targetedReconcileStateRef.current;
    state.timer = null;
    if (state.running || !state.pending.size) return;
    state.running = true;
    const batch = [...state.pending.entries()];
    state.pending.clear();
    const retry = [];
    let shouldRequestJournal = false;

    try {
      const localMutationIds = getLocalMutationIds();
      const readyIds = [];
      for (const [objectId, request] of batch) {
        const fence = authoritativeObjectStatesRef.current.get(objectId);
        const minimumUpdatedAt = Number(request.minimumUpdatedAt ?? 0);
        const minimumRevision = Number(request.minimumRevision ?? 0);
        const attempts = Number(request.attempts ?? 0);
        const blocked = localMutationIds.has(objectId);
        const fenceCaughtUp = Boolean(fence)
          && (minimumRevision <= 0 || Number(fence.revision ?? 0) >= minimumRevision)
          && (fence.kind === 'delete'
            || minimumUpdatedAt <= 0
            || Number(fence.updatedAt ?? 0) >= minimumUpdatedAt);

        if (blocked || (!fenceCaughtUp && attempts < TARGETED_RECONCILE_MAX_WAIT_ATTEMPTS)) {
          retry.push([objectId, { minimumUpdatedAt, minimumRevision, attempts: attempts + 1 }]);
          if (!blocked && (attempts === 3 || attempts === 12)) shouldRequestJournal = true;
          continue;
        }
        if (fence) readyIds.push(objectId);
        else if (attempts === 3 || attempts === 12) shouldRequestJournal = true;
      }

      if (readyIds.length) await reconcileAuthoritativeIds(readyIds);
      if (shouldRequestJournal) syncFromServer(false);
    } catch (error) {
      console.warn('Не удалось адресно довести объекты до серверного состояния', error);
      batch.forEach(([objectId, request]) => {
        if (Number(request.attempts ?? 0) >= TARGETED_RECONCILE_MAX_WAIT_ATTEMPTS + 8) return;
        retry.push([objectId, {
          minimumUpdatedAt: Number(request.minimumUpdatedAt ?? 0),
          minimumRevision: Number(request.minimumRevision ?? 0),
          attempts: Number(request.attempts ?? 0) + 1,
        }]);
      });
      syncFromServer(false);
    } finally {
      retry.forEach(([objectId, request]) => {
        const existing = state.pending.get(objectId);
        state.pending.set(objectId, {
          minimumUpdatedAt: Math.max(
            Number(existing?.minimumUpdatedAt ?? 0),
            Number(request.minimumUpdatedAt ?? 0),
          ),
          minimumRevision: Math.max(
            Number(existing?.minimumRevision ?? 0),
            Number(request.minimumRevision ?? 0),
          ),
          attempts: Math.max(Number(existing?.attempts ?? 0), Number(request.attempts ?? 0)),
        });
      });
      state.running = false;
      if (state.pending.size && state.timer == null) {
        const hasLongWait = [...state.pending.values()]
          .some((request) => Number(request.attempts ?? 0) > 8);
        state.timer = window.setTimeout(
          () => targetedReconcileRunnerRef.current?.(),
          hasLongWait ? 1_000 : TARGETED_RECONCILE_RETRY_DELAY,
        );
      }
    }
  }, [getLocalMutationIds, reconcileAuthoritativeIds, syncFromServer]);

  targetedReconcileRunnerRef.current = runTargetedReconciliation;

  const scheduleTargetedReconciliation = useCallback((
    objectIds,
    {
      minimumUpdatedAtById = null,
      minimumRevisionById = null,
      delay = TARGETED_RECONCILE_DELAY,
    } = {},
  ) => {
    const state = targetedReconcileStateRef.current;
    const ids = [...new Set((Array.isArray(objectIds) ? objectIds : [...(objectIds ?? [])])
      .filter(Boolean)
      .map(String))];
    ids.forEach((objectId) => {
      const existing = state.pending.get(objectId);
      const requestedVersion = Number(
        minimumUpdatedAtById instanceof Map
          ? minimumUpdatedAtById.get(objectId)
          : minimumUpdatedAtById?.[objectId],
      ) || 0;
      const requestedRevision = Number(
        minimumRevisionById instanceof Map
          ? minimumRevisionById.get(objectId)
          : minimumRevisionById?.[objectId],
      ) || 0;
      state.pending.set(objectId, {
        minimumUpdatedAt: Math.max(Number(existing?.minimumUpdatedAt ?? 0), requestedVersion),
        minimumRevision: Math.max(Number(existing?.minimumRevision ?? 0), requestedRevision),
        attempts: Number(existing?.attempts ?? 0),
      });
    });
    if (!state.pending.size || state.timer != null || state.running) return;
    state.timer = window.setTimeout(
      () => targetedReconcileRunnerRef.current?.(),
      Math.max(0, Number(delay ?? TARGETED_RECONCILE_DELAY)),
    );
  }, []);

  const recoverRejectedServerAction = useCallback(async (rejectedObjectIds = []) => {
    const realtime = realtimeRef.current;
    realtime?.pauseWrites?.();
    setSaveStatus('Сервер отклонил конфликтующее действие — сверяю изменённые объекты…');
    setSyncTone('recovering');
    let pendingActions = [];
    try {
      // Never patch an object underneath an active Pencil/touch gesture. Queued durable
      // actions are handled separately and replayed after the missing server operations.
      while (getLocalMutationIds({ includePending: false }).size > 0) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => window.setTimeout(resolve, 250));
      }
      pendingActions = await realtime?.getPendingActions?.() ?? [];
      rebasingPendingActionsRef.current = true;

      try {
        let serverState = await getBoardRevision(boardId, boardKey);
        if (!serverState) throw new Error('Серверная ревизия недоступна');
        let serverRevision = Number(serverState.revision ?? 0);
        let currentRevision = Number(revisionRef.current ?? 0);
        let pageCount = 0;

        while (serverRevision > currentRevision) {
          pageCount += 1;
          if (pageCount > 100) throw new Error('Слишком много страниц журнала конфликта');
          // eslint-disable-next-line no-await-in-loop
          const changes = await getBoardChanges(
            boardId,
            boardKey,
            currentRevision,
            INSURANCE_SYNC_PAGE_SIZE,
          );
          if (!changes?.length) throw new Error('Журнал операций недоступен или содержит разрыв');
          for (const action of changes) {
            const actionRevision = Number(action?.revision ?? 0);
            if (actionRevision <= currentRevision) continue;
            if (actionRevision !== currentRevision + 1) {
              throw new Error(`Разрыв журнала: ожидалась ревизия ${currentRevision + 1}`);
            }
            const applyOperation = applyRemoteOpsRef.current;
            if (!applyOperation) throw new Error('Обработчик адресной синхронизации не готов');
            // eslint-disable-next-line no-await-in-loop
            const applied = await applyOperation(
              action.ops,
              actionRevision,
              false,
              action.background,
              action.actionId,
              action.clientId,
            );
            if (!applied) throw new Error(`Не удалось применить ревизию ${actionRevision}`);
            currentRevision = Number(revisionRef.current ?? currentRevision);
          }
          if (changes.length < INSURANCE_SYNC_PAGE_SIZE || currentRevision >= serverRevision) {
            // eslint-disable-next-line no-await-in-loop
            serverState = await getBoardRevision(boardId, boardKey);
            serverRevision = Number(serverState?.revision ?? currentRevision);
          }
        }

        const rejectedIds = [...new Set((Array.isArray(rejectedObjectIds) ? rejectedObjectIds : [])
          .filter(Boolean)
          .map(String))];
        if (rejectedIds.length) {
          const missingFence = rejectedIds.some((id) => !authoritativeObjectStatesRef.current.has(id));
          if (missingFence) throw new Error('Нет адресной серверной версии конфликтующего объекта');
          const reconciled = await reconcileAuthoritativeIds(rejectedIds, {
            includePendingMutations: false,
          });
          if (!reconciled) throw new Error('Конфликтующие объекты ещё используются локально');
        }
        await replayPendingActionsLocally(pendingActions);
      } catch (journalError) {
        // This is an emergency-only compatibility path for an absent/corrupt operation
        // journal. It is never scheduled periodically and never runs merely because the
        // board is idle.
        console.warn('Targeted conflict recovery fell back to a snapshot', journalError);
        const recovery = await getBoardRecovery(boardId, boardKey);
        if (!recovery?.snapshot) throw new Error('Серверный снимок недоступен');
        seedAuthoritativeSnapshot(recovery.snapshot, Number(recovery.revision ?? 0));
        let rebasedSnapshot = recovery.snapshot;
        for (const pendingAction of Array.isArray(pendingActions) ? pendingActions : []) {
          rebasedSnapshot = applyOpsToSnapshot(
            rebasedSnapshot,
            pendingAction?.ops ?? [],
            pendingAction?.background ?? null,
          );
        }
        await applyAuthoritativeSnapshot(rebasedSnapshot, Number(recovery.revision ?? 0));
      }
      setSaveStatus('Конфликт устранён, локальные действия восстановлены');
      setSyncTone('recovered');
      window.clearTimeout(transientStatusTimerRef.current);
      transientStatusTimerRef.current = window.setTimeout(() => {
        setSaveStatus('Сохранено');
        setSyncTone('saved');
      }, 2200);
    } catch (caught) {
      console.error('Не удалось восстановиться после отклонённой операции', caught);
      setSaveStatus('Не удалось устранить конфликт автоматически');
      setSyncTone('error');
    } finally {
      rebasingPendingActionsRef.current = false;
      realtime?.resumeWrites?.();
    }
  }, [
    applyAuthoritativeSnapshot,
    boardId,
    boardKey,
    getLocalMutationIds,
    reconcileAuthoritativeIds,
    replayPendingActionsLocally,
    seedAuthoritativeSnapshot,
  ]);

  const handleRemoteSelectionTransaction = useCallback((message) => {
    const task = authoritativeApplyQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        const canvas = fabricCanvasRef.current;
        const transactionId = String(message?.transactionId ?? '');
        const phase = message?.phase;
        const sourceIds = Array.isArray(message?.sourceIds)
          ? message.sourceIds.filter(Boolean).map(String)
          : [];
        const validPhases = ['start', 'style', 'operation', 'commit', 'cancel'];
        if (!canvas || !validPhases.includes(phase) || (phase !== 'operation' && !transactionId)) return;
        // A selection transaction is only a visual preview. Once Supabase confirmed its
        // final objects, no delayed start/style/operation packet may recreate the proxy.
        if (transactionId && authoritativeSelectionTransactionsRef.current.has(transactionId)) return;
        const baseRevision = normalizeRealtimeBaseRevision(message?.baseRevision);

        if (phase === 'operation') {
          const operationId = String(message?.operationId ?? '');
          const now = Date.now();
          for (const [id, receivedAt] of remoteSelectionOperationIdsRef.current) {
            if (now - Number(receivedAt ?? 0) > 120000) {
              remoteSelectionOperationIdsRef.current.delete(id);
            }
          }
          if (operationId && remoteSelectionOperationIdsRef.current.has(operationId)) return;
          if (operationId) remoteSelectionOperationIdsRef.current.set(operationId, now);
        }

        const existingState = transactionId
          ? remoteSelectionTransactionsRef.current.get(transactionId)
          : null;
        const causalObjectIds = [...new Set([
          ...sourceIds,
          ...(Array.isArray(message?.objectIds) ? message.objectIds : []),
          ...(Array.isArray(existingState?.sourceIds) ? existingState.sourceIds : []),
        ].filter(Boolean).map(String))];
        const localMutationIds = getLocalMutationIds();
        if (causalObjectIds.some((objectId) => localMutationIds.has(objectId))) return;
        if (baseRevision != null && causalObjectIds.some((objectId) => (
          isRealtimeMutationCausallyStale(
            authoritativeObjectStatesRef.current.get(objectId),
            baseRevision,
          )
        ))) return;
        if (existingState?.phase === 'authoritative') return;
        if (['commit', 'awaiting-authoritative', 'commit-ready'].includes(existingState?.phase) && phase === 'start') return;
        applyingRemoteRef.current = true;
        const previousRenderOnAddRemove = canvas.renderOnAddRemove;
        canvas.renderOnAddRemove = false;
        try {
          if (phase === 'start') {
            const proxyId = String(message?.proxyId ?? `selection-proxy:${transactionId}`);
            const originalSourceObjects = sourceIds
              .map((id) => registeredObjectsById(id).find((object) => (
                !object.transientPreview && !object.transientSelectionProxy
              )))
              .filter(Boolean);
            const sourceRecords = originalSourceObjects.length === sourceIds.length
              ? getObjectRecords(originalSourceObjects)
              : [];
            const activeIds = canvas.getActiveObjects()
              .map((object) => object.boardObjectId)
              .filter(Boolean)
              .map(String);
            if (activeIds.some((id) => sourceIds.includes(id))) canvas.discardActiveObject();

            let proxy = null;
            const proxyRecord = message?.proxyRecord;
            const serialized = proxyRecord?.object;

            // Backward compatibility with older senders that still include the whole
            // serialized proxy. New clients send only ids and build the group locally.
            if (serialized) {
              await preloadSerializedImages(serialized);
              [proxy] = await util.enlivenObjects([serialized]);
            } else {
              const sourceObjects = sourceIds
                .map((id) => originalSourceObjects.find((object) => (
                  String(object.boardObjectId ?? '') === id
                )))
                .filter(Boolean);
              if (sourceObjects.length !== sourceIds.length || sourceObjects.length < 2) {
                window.setTimeout(() => syncFromServer(true), 100);
                return;
              }
              const ordered = sourceIds
                .map((id) => sourceObjects.find((object) => String(object.boardObjectId ?? '') === id))
                .filter(Boolean);
              ordered.forEach((object) => canvas.remove(object));
              proxy = new Group(ordered, {
                subTargetCheck: false,
                interactive: false,
                objectCaching: false,
                selectable: false,
                evented: false,
                hasControls: false,
                hasBorders: false,
              });
            }

            if (!proxy) {
              window.setTimeout(() => syncFromServer(true), 100);
              return;
            }
            proxy.boardObjectId = proxyId;
            proxy.transientSelectionProxy = true;
            proxy.selectionTransactionId = transactionId;
            proxy.selectionSourceIds = sourceIds;
            proxy.creationClientId = message?.clientId ?? proxy.creationClientId ?? '';
            proxy.previewReceivedAt = Date.now();
            proxy.selectable = false;
            proxy.evented = false;
            proxy.hasControls = false;
            proxy.hasBorders = false;

            // The complete group is ready before it is added. renderOnAddRemove is
            // disabled around this whole transaction, so observers never see a blank
            // frame while many source objects become one lightweight live proxy.
            if (serialized) sourceIds.forEach((id) => removeBoardObjectsById(canvas, id));
            removeRegisteredSelectionTransactionObjects(transactionId);
            canvas.add(proxy);
            const minimumZ = Number(message?.minimumZ ?? proxyRecord?.zIndex ?? 0);
            if (Number.isFinite(minimumZ) && typeof canvas.moveObjectTo === 'function') {
              canvas.moveObjectTo(proxy, clamp(Math.round(minimumZ), 0, canvas.getObjects().length - 1));
            }
            proxy.setCoords();
            remoteSelectionTransactionsRef.current.set(transactionId, {
              phase: 'start',
              sourceIds,
              sourceZIndexes: Array.isArray(message?.sourceZIndexes)
                ? message.sourceZIndexes.map((value) => Number(value))
                : [],
              proxyId,
              proxy,
              sourceRecords,
              receivedAt: Date.now(),
              clientId: message?.clientId ?? '',
            });
          }

          if (phase === 'style') {
            const transactionProxy = canvas.getObjects().find((object) => (
              object.transientSelectionProxy
              && String(object.selectionTransactionId ?? '') === transactionId
            ));
            const sampled = message?.sampled;
            if (transactionProxy && sampled && typeof transactionProxy.getObjects === 'function') {
              transactionProxy.getObjects().forEach((object) => {
                applySampledStyleToObject(object, sampled, { colorOnly: Boolean(message?.colorOnly) });
                object.dirty = true;
                object.setCoords?.();
              });
              transactionProxy.dirty = true;
              transactionProxy.previewReceivedAt = Date.now();
              transactionProxy.setCoords();
              const state = remoteSelectionTransactionsRef.current.get(transactionId);
              if (state) {
                state.receivedAt = Date.now();
                remoteSelectionTransactionsRef.current.set(transactionId, state);
              }
            }
          }

          if (phase === 'operation') {
            const operation = String(message?.operation ?? '');
            const objectIds = Array.isArray(message?.objectIds)
              ? message.objectIds.filter(Boolean).map(String)
              : sourceIds;
            const transactionProxy = transactionId
              ? canvas.getObjects().find((object) => (
                object.transientSelectionProxy
                && String(object.selectionTransactionId ?? '') === transactionId
              ))
              : null;

            let targets = [];
            if (transactionProxy && typeof transactionProxy.getObjects === 'function') {
              targets = transactionProxy.getObjects().filter((object) => !object.isEraserPath);
            } else {
              targets = objectIds
                .map((id) => canvas.getObjects().find((object) => String(object.boardObjectId ?? '') === id))
                .filter((object) => object && !object.isEraserPath);
            }

            if (!targets.length) {
              window.setTimeout(() => syncFromServer(true), 80);
              return;
            }

            if (operation === 'rotate') {
              const degrees = Number(message?.degrees ?? 0);
              if (Number.isFinite(degrees) && degrees !== 0) {
                targets.forEach((object) => {
                  object.rotate(Number(object.angle ?? 0) + degrees);
                  object.previewReceivedAt = Date.now();
                  object.dirty = true;
                  object.setCoords?.();
                });
              }
            } else if (operation === 'flip') {
              const axis = message?.axis === 'vertical' ? 'vertical' : 'horizontal';
              targets.forEach((object) => {
                if (axis === 'horizontal') object.set('flipX', !object.flipX);
                else object.set('flipY', !object.flipY);
                object.previewReceivedAt = Date.now();
                object.dirty = true;
                object.setCoords?.();
              });
            } else if (operation === 'layer' && !transactionProxy) {
              const direction = message?.direction === 'backward' ? 'backward' : 'forward';
              const ordered = [...targets].sort((left, right) => {
                const leftIndex = canvas.getObjects().indexOf(left);
                const rightIndex = canvas.getObjects().indexOf(right);
                return direction === 'forward' ? rightIndex - leftIndex : leftIndex - rightIndex;
              });
              ordered.forEach((object) => {
                const index = canvas.getObjects().indexOf(object);
                const nextIndex = direction === 'forward'
                  ? Math.min(canvas.getObjects().length - 1, index + 1)
                  : Math.max(0, index - 1);
                canvas.moveObjectTo(object, nextIndex);
                object.previewReceivedAt = Date.now();
                object.dirty = true;
                object.setCoords?.();
              });
            }

            if (transactionProxy) {
              transactionProxy.previewReceivedAt = Date.now();
              transactionProxy.dirty = true;
              transactionProxy.setCoords();
              const state = remoteSelectionTransactionsRef.current.get(transactionId);
              if (state) {
                state.receivedAt = Date.now();
                remoteSelectionTransactionsRef.current.set(transactionId, state);
              }
            }

            const lockIds = transactionProxy && Array.isArray(transactionProxy.selectionSourceIds)
              ? transactionProxy.selectionSourceIds.filter(Boolean).map(String)
              : objectIds;
            let lockUiChanged = false;
            lockIds.forEach((objectId) => {
              const current = remoteLocksRef.current.get(objectId);
              if (!current) return;
              remoteLocksRef.current.set(objectId, {
                ...current,
                expiresAt: Date.now() + LIVE_TRANSFORM_LOCK_TTL,
              });
              lockUiChanged = true;
            });
            if (lockUiChanged) {
              setRemoteLocks([...remoteLocksRef.current.entries()].map(([objectId, lock]) => ({ objectId, ...lock })));
            }
          }

          if (phase === 'commit') {
            // Keep the complete temporary proxy visible until the authoritative server
            // action (or a full snapshot) is ready. Removing it here used to create a
            // gap where only part of the final group had been revived on the observer.
            const finalIds = Array.isArray(message?.finalIds)
              ? message.finalIds.filter(Boolean).map(String)
              : [];
            remoteSelectionTransactionsRef.current.set(transactionId, {
              phase: 'awaiting-authoritative',
              sourceIds: sourceIds.length ? sourceIds : (existingState?.sourceIds ?? []),
              proxyId: existingState?.proxyId ?? String(message?.proxyId ?? ''),
              finalIds,
              finalCount: Number(message?.finalCount ?? finalIds.length ?? 0),
              receivedAt: Date.now(),
              clientId: message?.clientId ?? existingState?.clientId ?? '',
            });
          }

          if (phase === 'cancel') {
            const transactionState = remoteSelectionTransactionsRef.current.get(transactionId);
            const transactionProxy = transactionState?.proxy
              ?? canvas.getObjects().find((object) => (
                object.transientSelectionProxy
                && String(object.selectionTransactionId ?? '') === transactionId
              ));

            if (message?.reason === 'no-change'
              && transactionProxy
              && typeof transactionProxy.getObjects === 'function') {
              const children = [...transactionProxy.getObjects()];
              const absoluteMatrices = children.map((object) => (
                compactTransformMatrix(object.calcTransformMatrix())
              ));
              const serializations = children.map((object) => serializeObject(object));
              for (const serialized of serializations) {
                // eslint-disable-next-line no-await-in-loop
                await preloadSerializedImages(serialized);
              }
              const restored = await util.enlivenObjects(serializations);
              canvas.remove(transactionProxy);
              restored.forEach((object, index) => {
                const matrix = absoluteMatrices[index];
                if (matrix) util.applyTransformToObject(object, matrix);
                object.transientPreview = false;
                object.transientLiveDraw = false;
                object.transientSelectionProxy = false;
                object.selectionTransactionId = undefined;
                object.selectionSourceIds = undefined;
                object.selectable = activeToolRef.current === 'select';
                object.evented = activeToolRef.current === 'select';
                object.hasControls = true;
                object.hasBorders = true;
                object.setCoords();
                canvas.add(object);
                const zIndex = transactionState?.sourceZIndexes?.[index];
                if (Number.isInteger(zIndex) && typeof canvas.moveObjectTo === 'function') {
                  canvas.moveObjectTo(object, clamp(zIndex, 0, canvas.getObjects().length - 1));
                }
              });
              remoteSelectionTransactionsRef.current.delete(transactionId);
            } else {
              removeRegisteredSelectionTransactionObjects(transactionId);
              remoteSelectionTransactionsRef.current.delete(transactionId);
              window.setTimeout(() => syncFromServer(true), 40);
            }
          }
        } finally {
          applyingRemoteRef.current = false;
          canvas.renderOnAddRemove = previousRenderOnAddRemove;
          const transactionState = transactionId
            ? remoteSelectionTransactionsRef.current.get(transactionId)
            : null;
          const interactivityIds = new Set([
            ...sourceIds,
            ...(Array.isArray(message?.objectIds) ? message.objectIds : []),
            ...(Array.isArray(transactionState?.sourceIds) ? transactionState.sourceIds : []),
            transactionState?.proxyId,
            message?.proxyId,
          ].filter(Boolean).map(String));
          applyObjectInteractivityToObjects([
            ...[...interactivityIds].flatMap((objectId) => registeredObjectsById(objectId)),
            transactionState?.proxy,
          ]);
          canvas.requestRenderAll();
        }
      });
    authoritativeApplyQueueRef.current = task.catch((error) => {
      console.warn('Не удалось обработать временное групповое выделение', error);
      window.setTimeout(() => syncFromServer(true), 120);
    });
  }, [
    applyObjectInteractivityToObjects,
    getObjectRecords,
    getLocalMutationIds,
    registeredObjectsById,
    removeRegisteredSelectionTransactionObjects,
    syncFromServer,
  ]);

  const refreshHistoryRecords = useCallback((records) => {
    const baseTimestamp = Date.now();
    return (Array.isArray(records) ? records : []).map((record, index) => ({
      ...record,
      object: {
        ...record.object,
        // Restoring a deleted object is a new authoritative mutation. Reusing the
        // pre-delete timestamp can make server conflict checks or remote tombstones
        // treat the upsert as stale, even though it was restored locally.
        updatedAt: baseTimestamp + index,
        updatedBy: clientIdRef.current,
      },
    }));
  }, []);

  const applyHistoryAction = useCallback(async (action, direction) => {
    if (!action) return;
    applyingHistoryRef.current = true;
    applyingRemoteRef.current = true;
    try {
      if (action.type !== 'background') fabricCanvasRef.current?.discardActiveObject();
      if (action.type === 'add') {
        if (direction === 'undo') {
          const ids = action.records.map((record) => record.object.boardObjectId).filter(Boolean);
          removeIdsLocally(ids);
          await sendDeletes(ids);
        } else {
          const restoredRecords = refreshHistoryRecords(action.records);
          await applyRecordsLocally(restoredRecords);
          await sendRecordUpserts(restoredRecords, { restore: true, reorder: true });
        }
      }

      if (action.type === 'delete') {
        if (direction === 'undo') {
          const restoredRecords = refreshHistoryRecords(action.records);
          await applyRecordsLocally(restoredRecords);
          await sendRecordUpserts(restoredRecords, { restore: true, reorder: true });
        } else {
          const ids = action.records.map((record) => record.object.boardObjectId).filter(Boolean);
          removeIdsLocally(ids);
          await sendDeletes(ids);
        }
      }

      if (action.type === 'modify') {
        const sourceRecords = direction === 'undo' ? action.after : action.before;
        const records = refreshHistoryRecords(direction === 'undo' ? action.before : action.after);
        const ops = createRecordPatchOps(sourceRecords, records, {
          reorder: Boolean(action.reorder),
        });
        await replayPendingActionsLocally([{ ops }]);
        await sendDurableOps(ops, { atomic: true });
      }

      if (action.type === 'replace') {
        const removeRecords = direction === 'undo' ? action.after : action.before;
        const restoreRecords = refreshHistoryRecords(
          direction === 'undo' ? action.before : action.after,
        );
        const removeIds = removeRecords
          .map((record) => record.object?.boardObjectId)
          .filter(Boolean);
        removeIdsLocally(removeIds);
        await applyRecordsLocally(restoreRecords);
        await sendDurableOps([
          ...removeIds.map((id) => ({ type: 'delete', id })),
          ...restoreRecords.map((record) => ({
            type: 'upsert',
            object: record.object,
            zIndex: record.zIndex,
            restore: true,
            reorder: true,
          })),
        ], { atomic: true });
      }

      if (action.type === 'transform') {
        const canvas = fabricCanvasRef.current;
        const frames = direction === 'undo' ? action.before : action.after;
        if (canvas && Array.isArray(frames) && frames.length) {
          canvas.discardActiveObject();
          const touched = [];
          for (const frame of frames) {
            const candidates = registeredObjectsById(frame?.id)
              .filter((object) => !object.transientPreview && !object.transientTransformFallback);
            const object = candidates[0] ?? registeredObjectsById(frame?.id)[0] ?? null;
            const matrix = compactTransformMatrix(frame?.matrix);
            if (!object || !matrix) continue;
            util.applyTransformToObject(object, matrix.map(Number));
            markObject(object, clientIdRef.current);
            object.dirty = true;
            object.setCoords();
            touched.push(object);
          }
          if (touched.length) {
            const entries = captureTransformRecordInputs(touched);
            await sendLightweightTransforms(entries);
            applyObjectInteractivityToObjects(touched, { render: false });
          }
          canvas.requestRenderAll();
          updateSelectionState();
          updateSelectionStyleState();
        }
      }

      if (action.type === 'background') {
        applyBackground(direction === 'undo' ? action.before : action.after, {
          broadcast: true,
          persist: false,
        });
      }
    } finally {
      applyingRemoteRef.current = false;
      applyingHistoryRef.current = false;
      if (action.type !== 'transform') schedulePersistence();
    }
  }, [
    applyBackground,
    applyObjectInteractivityToObjects,
    applyRecordsLocally,
    getObjectRecords,
    captureTransformRecordInputs,
    markObject,
    registeredObjectsById,
    refreshHistoryRecords,
    removeIdsLocally,
    schedulePersistence,
    sendDeletes,
    sendDurableOps,
    sendRecordPatches,
    sendLightweightTransforms,
    sendRecordUpserts,
    updateSelectionState,
    updateSelectionStyleState,
  ]);

  const undo = useCallback(async () => {
    if (historyCommandBusyRef.current || !canEditRef.current || !undoStackRef.current.length) return;
    const action = undoStackRef.current.pop();
    redoStackRef.current.push(action);
    updateHistoryButtons();
    historyCommandBusyRef.current = true;
    try {
      await applyHistoryAction(action, 'undo');
    } catch (error) {
      const rollbackIndex = redoStackRef.current.lastIndexOf(action);
      if (rollbackIndex >= 0) redoStackRef.current.splice(rollbackIndex, 1);
      undoStackRef.current.push(action);
      updateHistoryButtons();
      console.error('Не удалось отменить действие', error);
    } finally {
      historyCommandBusyRef.current = false;
    }
  }, [applyHistoryAction, updateHistoryButtons]);

  const redo = useCallback(async () => {
    if (historyCommandBusyRef.current || !canEditRef.current || !redoStackRef.current.length) return;
    const action = redoStackRef.current.pop();
    undoStackRef.current.push(action);
    updateHistoryButtons();
    historyCommandBusyRef.current = true;
    try {
      await applyHistoryAction(action, 'redo');
    } catch (error) {
      const rollbackIndex = undoStackRef.current.lastIndexOf(action);
      if (rollbackIndex >= 0) undoStackRef.current.splice(rollbackIndex, 1);
      redoStackRef.current.push(action);
      updateHistoryButtons();
      console.error('Не удалось вернуть действие', error);
    } finally {
      historyCommandBusyRef.current = false;
    }
  }, [applyHistoryAction, updateHistoryButtons]);

  const applyRemoteOps = useCallback((
    ops,
    revision,
    needsSync = false,
    incomingBackground = null,
    _actionId = null,
    sourceClientId = '',
  ) => {
    if (!boardReadyRef.current) {
      syncRequestedRef.current = true;
      syncForceRef.current = true;
      return Promise.resolve(false);
    }
    const incomingRevision = Number(revision ?? 0);
    const currentRevision = Number(revisionRef.current ?? 0);
    const hasBackgroundChange = BACKGROUNDS.has(incomingBackground);
    const earlyTransactionIds = Array.isArray(ops)
      ? [...new Set(ops
        .flatMap((op) => {
          if (op?.type === 'upsert' && op.object?.selectionTransactionId) {
            return [String(op.object.selectionTransactionId)];
          }
          if (op?.type === 'patch' && op.patch?.selectionTransactionId) {
            return [String(op.patch.selectionTransactionId)];
          }
          return [];
        }))]
      : [];
    const deletedIds = new Set(Array.isArray(ops)
      ? ops.filter((op) => op?.type === 'delete' && op.id).map((op) => String(op.id))
      : []);
    const deleteMatchedTransactionIds = [];
    earlyTransactionIds.forEach((transactionId) => {
      const transaction = remoteSelectionTransactionsRef.current.get(transactionId);
      if (transaction) transaction.phase = 'commit-ready';
    });
    if (sourceClientId) {
      for (const [transactionId, transaction] of remoteSelectionTransactionsRef.current) {
        const sourceDeleted = Array.isArray(transaction.sourceIds)
          && transaction.sourceIds.length > 0
          && transaction.sourceIds.every((id) => deletedIds.has(String(id)));
        if (transaction.clientId === sourceClientId && (['commit', 'awaiting-authoritative', 'commit-ready'].includes(transaction.phase) || sourceDeleted)) {
          transaction.phase = 'commit-ready';
          transaction.receivedAt = Date.now();
          if (sourceDeleted) deleteMatchedTransactionIds.push(transactionId);
        }
      }
    }
    if (needsSync || !Array.isArray(ops) || (!ops.length && !hasBackgroundChange) || incomingRevision > currentRevision + 1) {
      syncFromServer(true);
      return Promise.resolve(false);
    }
    if (incomingRevision <= currentRevision) return Promise.resolve(true);
    const affectedIds = affectedOperationIds(ops);

    const upsertIds = [...new Set(ops
      .filter((op) => op?.type === 'upsert' && op.object?.boardObjectId)
      .map((op) => String(op.object.boardObjectId)))];
    const patchIds = [...new Set(ops
      .filter((op) => op?.type === 'patch' && op.id)
      .map((op) => String(op.id)))];
    const transformIds = [...new Set(ops
      .flatMap((op) => transformOperationEntries(op))
      .map((entry) => String(entry?.id ?? ''))
      .filter(Boolean))];
    const authoritativeObjectIds = [...new Set([...upsertIds, ...patchIds, ...transformIds])];
    const selectionTransactionIds = [...new Set(ops
      .flatMap((op) => {
        if (op?.type === 'upsert' && op.object?.selectionTransactionId) {
          return [String(op.object.selectionTransactionId)];
        }
        if (op?.type === 'patch' && op.patch?.selectionTransactionId) {
          return [String(op.patch.selectionTransactionId)];
        }
        return [];
      }))];
    const receivedAt = Date.now();
    const matchingTransformSessions = [...remoteTransformSessionsRef.current.values()].filter((session) => (
      receivedAt - Number(session?.receivedAt ?? 0) < 10000
      && Array.isArray(session?.objectIds)
      && session.objectIds.some((id) => authoritativeObjectIds.includes(String(id)))
    ));
    if (authoritativeObjectIds.length) {
      matchingTransformSessions.forEach((session) => {
        session.ended = true;
        session.receivedAt = receivedAt;
      });
    }

    const task = authoritativeApplyQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        const canvas = fabricCanvasRef.current;
        if (!canvas) return false;
        if (incomingRevision <= Number(revisionRef.current ?? 0)) return true;
        if (incomingRevision > Number(revisionRef.current ?? 0) + 1) {
          syncFromServer(true);
          return false;
        }
        const localMutationIds = getLocalMutationIds();
        if ([...affectedIds].some((objectId) => localMutationIds.has(objectId))) {
          // Keep this revision and every later revision queued until mouse-up / editing exit.
          window.setTimeout(() => syncFromServer(false), 500);
          return false;
        }
        if (hasBackgroundChange
          && !rebasingPendingActionsRef.current
          && pendingLocalBackgroundMutationCountRef.current > 0) {
          window.setTimeout(() => syncFromServer(false), 500);
          return false;
        }

        // Do not remove live previews before the authoritative objects are revived.
        // The replacement below is performed atomically with rendering paused, so the
        // receiving device never shows a white gap between realtime and saved state.

        // Revive the whole authoritative batch in one pass. Sequential enlivening made
        // a 40-object paste spend a long time in the apply queue even though rendering was
        // paused. Tombstones also stop an older queued upsert from reviving a deleted line.
        const preparedOps = ops.map((op) => ({
          op,
          revived: null,
          serialized: null,
          skipDeleted: false,
        }));
        const reviveEntries = [];
        preparedOps.forEach((entry, index) => {
          const op = entry.op;
          const id = String(op?.type === 'patch' ? op.id : op?.object?.boardObjectId ?? '');
          if (!['upsert', 'patch'].includes(op?.type) || !id) return;
          const tombstone = remoteDeletedObjectIdsRef.current.get(id);
          if (tombstone && !op.restore) {
            entry.skipDeleted = true;
            return;
          }
          if (tombstone) remoteDeletedObjectIdsRef.current.delete(id);
          let serialized = op.object ?? null;
          if (op.type === 'patch') {
            const current = registeredObjectsById(id).find((object) => (
              !object.transientPreview
              && !object.transientTransformFallback
              && !object.transientSelectionProxy
            ));
            const source = current?.pendingImageSerialized
              ?? serializedObjectCacheRef.current.get(current)
              ?? (current ? serializeObject(current) : null);
            serialized = applySerializedObjectPatch(source, op);
            if (!serialized) throw new Error(`Не найден объект для patch: ${id}`);
          }
          entry.serialized = serialized;
          reviveEntries.push({ index, serialized });
        });
        if (reviveEntries.length) {
          const serializedBatch = reviveEntries.map((entry) => entry.serialized);
          try {
            await preloadSerializedImages(serializedBatch);
            const revivedBatch = await util.enlivenObjects(serializedBatch);
            reviveEntries.forEach((entry, revivedIndex) => {
              preparedOps[entry.index].revived = revivedBatch[revivedIndex] ?? null;
            });
          } catch (batchError) {
            // One temporarily unavailable Storage image must not block all later revisions.
            for (const entry of reviveEntries) {
              try {
                // eslint-disable-next-line no-await-in-loop
                await preloadSerializedImages(entry.serialized);
                // eslint-disable-next-line no-await-in-loop
                const [revived] = await util.enlivenObjects([entry.serialized]);
                preparedOps[entry.index].revived = revived ?? null;
              } catch (entryError) {
                const serializedType = String(entry.serialized?.type ?? '').toLowerCase();
                const isImage = serializedType === 'image' || entry.serialized?.objectKind === 'image';
                if (!isImage) throw entryError ?? batchError;
                preparedOps[entry.index].revived = createPendingImagePlaceholder(entry.serialized);
              }
            }
          }
        }

        // Two people can grab the same selection before either lock reaches the other
        // iPad. If one server action wins, dismantle every competing transient proxy and
        // restore its original members inside the same paused render before applying the
        // winner. This prevents a transform from failing because its stable ids are
        // temporarily hidden as children of somebody else's Group.
        const supersededSelectionRestores = [];
        for (const [transactionId, transaction] of remoteSelectionTransactionsRef.current) {
          if (!transaction || transaction.phase === 'authoritative') continue;
          if (selectionTransactionIds.includes(String(transactionId))) continue;
          const sourceIds = Array.isArray(transaction.sourceIds)
            ? transaction.sourceIds.filter(Boolean).map(String)
            : [];
          if (!sourceIds.some((objectId) => affectedIds.has(objectId))) continue;
          const allSourcesDeleted = sourceIds.length > 0
            && sourceIds.every((objectId) => deletedIds.has(objectId));
          const records = allSourcesDeleted || !Array.isArray(transaction.sourceRecords)
            ? []
            : transaction.sourceRecords;
          let restored = [];
          if (records.length) {
            const serialized = records.map((record) => record.object).filter(Boolean);
            for (const object of serialized) {
              // eslint-disable-next-line no-await-in-loop
              await preloadSerializedImages(object);
            }
            // eslint-disable-next-line no-await-in-loop
            restored = await util.enlivenObjects(serialized);
            if (restored.length !== records.length) {
              throw new Error(`Не удалось восстановить конкурирующую группу ${transactionId}`);
            }
          }
          supersededSelectionRestores.push({
            transactionId: String(transactionId),
            transaction,
            records,
            restored,
          });
        }

        const incompleteSelectionBatch = selectionTransactionIds.length > 0
          && preparedOps.some(({ op, revived, skipDeleted }) => (
            ['upsert', 'patch'].includes(op?.type)
            && (op.object?.selectionTransactionId || op.patch?.selectionTransactionId)
            && !skipDeleted
            && !revived
          ));
        if (incompleteSelectionBatch) {
          selectionTransactionIds.forEach((transactionId) => {
            const transaction = remoteSelectionTransactionsRef.current.get(transactionId);
            if (transaction) {
              transaction.phase = 'awaiting-sync';
              transaction.receivedAt = Date.now();
            }
          });
          window.setTimeout(() => syncFromServer(true), 0);
          return false;
        }

        const creationSessionsToReplace = new Map();
        preparedOps.forEach(({ op, skipDeleted }) => {
          if (skipDeleted || op?.type !== 'upsert' || !op.object?.creationSessionId) return;
          const creationClientId = op.object.creationClientId ?? op.object.updatedBy ?? '';
          const sessionId = String(op.object.creationSessionId);
          creationSessionsToReplace.set(
            `${creationClientId}:${sessionId}`,
            { clientId: creationClientId, sessionId },
          );
        });

        const selectedIds = canvas
          .getActiveObjects()
          .map((object) => object.boardObjectId)
          .filter(Boolean);
        const selectedIdSet = new Set(selectedIds.map(String));
        const transformOnly = ops.length > 0
          && ops.every((op) => op?.type === 'transform')
          && !hasBackgroundChange;
        // Never dismantle an iPad user's active selection for an unrelated action.
        // Fabric stores selected members relative to its temporary wrapper, so only an
        // authoritative operation touching one of those exact ids needs a short rebuild.
        const actionTouchesSelection = [...affectedIds]
          .some((id) => selectedIdSet.has(String(id)));
        applyingRemoteRef.current = true;
        if (actionTouchesSelection) canvas.discardActiveObject();
        const previousRenderOnAddRemove = canvas.renderOnAddRemove;
        canvas.renderOnAddRemove = false;
        try {
          const reconciledObjects = [];
          supersededSelectionRestores.forEach((restore) => {
            removeRegisteredSelectionTransactionObjects(restore.transactionId);
            restore.restored.forEach((object, index) => {
              const record = restore.records[index];
              object.transientPreview = false;
              object.transientLiveDraw = false;
              object.transientSelectionProxy = false;
              object.selectionTransactionId = undefined;
              object.selectionSourceIds = undefined;
              object.setCoords?.();
              canvas.add(object);
              serializedObjectCacheRef.current.set(object, record.object);
              if (Number.isInteger(record.zIndex) && typeof canvas.moveObjectTo === 'function') {
                canvas.moveObjectTo(object, clamp(record.zIndex, 0, canvas.getObjects().length - 1));
              }
              reconciledObjects.push(object);
            });
            remoteSelectionTransactionsRef.current.set(restore.transactionId, {
              phase: 'authoritative',
              receivedAt: Date.now(),
            });
            authoritativeSelectionTransactionsRef.current.set(restore.transactionId, {
              revision: incomingRevision,
              recordedAt: Date.now(),
            });
          });
          creationSessionsToReplace.forEach(({ clientId, sessionId }) => {
            removeRegisteredObjectsByCreationSession(clientId, sessionId);
            remoteDrawSessionsRef.current.delete(`${clientId}:${sessionId}`);
          });
          [...new Set([...selectionTransactionIds, ...deleteMatchedTransactionIds])].forEach((transactionId) => {
            removeRegisteredSelectionTransactionObjects(transactionId);
            remoteSelectionTransactionsRef.current.set(transactionId, {
              phase: 'authoritative',
              receivedAt: Date.now(),
            });
          });
          const atomicReorderIds = new Set(preparedOps
            .filter(({ op, skipDeleted }) => (
              !skipDeleted
              && ['upsert', 'patch'].includes(op?.type)
              && Boolean(op.reorder || op.restore)
              && (op.object?.boardObjectId || op.id)
            ))
            .map(({ op }) => String(op.object?.boardObjectId ?? op.id)));
          atomicReorderIds.forEach((objectId) => removeBoardObjectsById(canvas, objectId));

          for (const { op, revived, serialized, skipDeleted } of preparedOps) {
            if (op?.type === 'delete') {
              const id = String(op.id ?? '');
              if (id) {
                remoteDeletedObjectIdsRef.current.set(id, {
                  timestamp: Date.now(),
                  clientId: sourceClientId,
                  confirmed: true,
                });
                remotePreviewTokensRef.current.delete(id);
                remotePreviewPendingRef.current.records.delete(id);
              }
              removeBoardObjectsById(canvas, op.id);
              continue;
            }

            if (op?.type === 'transform') {
              for (const patch of transformOperationEntries(op)) {
                const id = String(patch?.id ?? '');
                if (!id || !patch?.transform) continue;
                const registered = registeredObjectsById(id);
                const candidates = registered
                  .filter((object) => !object.transientPreview && !object.transientTransformFallback);
                const object = candidates[0] ?? registered[0] ?? null;
                if (!object) throw new Error(`Не найден объект для transform: ${id}`);
                object.set(patch.transform);
                object.updatedAt = Number(patch.updatedAt ?? Date.now());
                object.updatedBy = patch.updatedBy ?? sourceClientId ?? object.updatedBy;
                object.dirty = true;
                object.setCoords();
                reconciledObjects.push(object);
                penTransformSpatialApiRef.current?.updateObjects?.([object]);
                const cached = serializedObjectCacheRef.current.get(object);
                if (cached) {
                  Object.assign(cached, patch.transform, {
                    boardObjectId: id,
                    updatedAt: object.updatedAt,
                    updatedBy: object.updatedBy,
                  });
                }
                if (op.reorder && Number.isInteger(patch.zIndex)
                  && typeof canvas.moveObjectTo === 'function') {
                  canvas.moveObjectTo(object, clamp(patch.zIndex, 0, canvas.getObjects().length - 1));
                }
              }
              continue;
            }

            const replacementId = String(op?.type === 'patch' ? op.id : op?.object?.boardObjectId ?? '');
            if (skipDeleted || !['upsert', 'patch'].includes(op?.type) || !replacementId || !revived) continue;
            if (op.restore) remoteDeletedObjectIdsRef.current.delete(replacementId);
            remotePreviewTokensRef.current.delete(replacementId);
            const preserveExistingOrder = op.type === 'patch' ? !op.reorder : op.preserveOrder;
            const existingObject = preserveExistingOrder && !atomicReorderIds.has(replacementId)
              ? registeredObjectsById(replacementId)[0]
              : null;
            const existingIndex = existingObject ? canvas.getObjects().indexOf(existingObject) : -1;
            removeBoardObjectsById(canvas, replacementId);
            revived.transientPreview = false;
            revived.transientLiveDraw = false;
            revived.transientAwaitingCommit = false;
            canvas.add(revived);
            reconciledObjects.push(revived);
            serializedObjectCacheRef.current.set(revived, serialized ?? op.object);
            const requestedIndex = preserveExistingOrder && existingIndex >= 0
              ? existingIndex
              : op.zIndex;
            if (Number.isInteger(requestedIndex) && typeof canvas.moveObjectTo === 'function') {
              canvas.moveObjectTo(revived, clamp(requestedIndex, 0, canvas.getObjects().length - 1));
            }
          }

          deduplicateRegisteredObjectIds(affectedIds);
          if (BACKGROUNDS.has(incomingBackground)) applyBackground(incomingBackground);
          applyObjectInteractivityToObjects(reconciledObjects, { render: false });
          if (actionTouchesSelection
            && activeToolRef.current === 'select'
            && selectedIds.length) {
            const selectedObjects = selectedIds
              .map((id) => registeredObjectsById(id).find((object) => (
                !object.transientPreview
                && !object.transientTransformFallback
                && !object.transientSelectionProxy
              )))
              .filter(Boolean);
            if (selectedObjects.length === 1) {
              canvas.setActiveObject(selectedObjects[0]);
            } else if (selectedObjects.length > 1) {
              canvas.setActiveObject(createOuterOnlyActiveSelection(selectedObjects, canvas));
            }
          }
          const verifiableOps = preparedOps
            .filter((entry) => !entry.skipDeleted)
            .map((entry) => entry.op);
          if (!verifyAuthoritativeOps(verifiableOps, incomingBackground)) {
            throw new Error(`Адресная проверка операции ${incomingRevision} не пройдена`);
          }
          rememberAuthoritativeOps(verifiableOps, incomingRevision);
          if (BACKGROUNDS.has(incomingBackground)) {
            authoritativeBackgroundStateRef.current = {
              revision: incomingRevision,
              background: incomingBackground,
            };
          }
          [...new Set([...selectionTransactionIds, ...deleteMatchedTransactionIds])]
            .forEach((transactionId) => {
              authoritativeSelectionTransactionsRef.current.set(String(transactionId), {
                revision: incomingRevision,
                recordedAt: Date.now(),
              });
            });
          revisionRef.current = incomingRevision;
          bufferSnapshotAction(ops, incomingBackground, incomingRevision);
          if (transformOnly) {
            canvas.getActiveObject()?.setCoords?.();
          } else if (actionTouchesSelection) {
            updateSelectionState();
            updateSelectionStyleState();
          }
          return true;
        } finally {
          applyingRemoteRef.current = false;
          canvas.renderOnAddRemove = previousRenderOnAddRemove;
          canvas.requestRenderAll();
        }
      });

    const guardedTask = task.catch((caught) => {
      console.error(caught);
      setSaveStatus('Не удалось применить серверную операцию');
      window.setTimeout(() => syncFromServer(true), 900);
      return false;
    });

    authoritativeApplyQueueRef.current = guardedTask;
    return guardedTask;
  }, [
    applyBackground,
    applyObjectInteractivityToObjects,
    bufferSnapshotAction,
    deduplicateRegisteredObjectIds,
    getLocalMutationIds,
    registeredObjectsById,
    rememberAuthoritativeOps,
    removeRegisteredObjectsByCreationSession,
    removeRegisteredSelectionTransactionObjects,
    syncFromServer,
    updateSelectionState,
    updateSelectionStyleState,
    verifyAuthoritativeOps,
  ]);

  applyRemoteOpsRef.current = applyRemoteOps;

  const handleRemoteSettings = useCallback((settings, revision, needsSync = false) => {
    // Legacy settings packets still pass through the same strict authoritative queue.
    applyRemoteOps([], revision, needsSync, settings?.background ?? null);
  }, [applyRemoteOps]);


  const handleRemoteBackgroundLive = useCallback((background, message = null) => {
    if (!BACKGROUNDS.has(background)) return;
    if (pendingLocalBackgroundMutationCountRef.current > 0) return;
    const baseRevision = normalizeRealtimeBaseRevision(message?.baseRevision);
    if (isRealtimeMutationCausallyStale(
      authoritativeBackgroundStateRef.current,
      baseRevision,
    )) return;
    applyBackground(background, { broadcast: false, persist: false });
  }, [applyBackground]);

  const handleRemoteMode = useCallback((mode) => {
    if (!['edit', 'view', 'closed'].includes(mode)) return;
    setGuestModeState(mode);
    if (isOwner) return;
    if (mode === 'closed') {
      onAccessChange({ ...initialAccess, permission: 'closed', guestMode: 'closed' });
      return;
    }
    setPermission(mode);
    if (mode !== 'edit') cancelCreationDraftRef.current?.('permission-change');
    canEditRef.current = mode === 'edit';
    activeToolRef.current = mode === 'edit' ? 'pencil' : 'select';
    if (mode === 'edit') activateDrawingStyle('pencil');
    setToolState(activeToolRef.current);
    applyObjectInteractivity();
    configureBrushAndMode();
  }, [activateDrawingStyle, applyObjectInteractivity, configureBrushAndMode, initialAccess, isOwner, onAccessChange]);

  const copySelection = useCallback(async ({ deselect = false } = {}) => {
    const canvas = fabricCanvasRef.current;
    if (!canvas || !canEditRef.current) return false;
    const active = canvas.getActiveObject();
    const objects = selectionUiObjects(canvas);
    if (!objects.length) return false;

    try {
      const serialized = objects.map(serializeObject);
      const matrices = objects.map((object) => compactTransformMatrix(object.calcTransformMatrix?.()));
      await preloadSerializedImages(serialized);
      const absoluteCopies = await util.enlivenObjects(serialized);
      absoluteCopies.forEach((object, index) => {
        const matrix = matrices[index];
        if (matrix) util.applyTransformToObject(object, matrix);
        object.transientPreview = undefined;
        object.transientTransformFallback = undefined;
        object.transientSelectionProxy = undefined;
        object.selectionTransactionId = undefined;
        object.selectionSourceIds = undefined;
        object.setCoords?.();
      });
      clipboardRef.current = absoluteCopies.map(serializeObject);

      const bounds = active?.getBoundingRect?.()
        ?? objects.reduce((result, object) => {
          const box = object.getBoundingRect();
          if (!result) return { ...box };
          const left = Math.min(result.left, box.left);
          const top = Math.min(result.top, box.top);
          const right = Math.max(result.left + result.width, box.left + box.width);
          const bottom = Math.max(result.top + result.height, box.top + box.height);
          return { left, top, width: right - left, height: bottom - top };
        }, null);
      clipboardCenterRef.current = bounds
        ? new Point(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)
        : getViewportSceneCenter();
      internalClipboardArmedRef.current = true;
      clipboardSourceBoardIdRef.current = boardId;
      const clipboardSaved = await setCrossBoardClipboard({
        version: 1,
        sourceBoardId: boardId,
        copiedAt: Date.now(),
        center: {
          x: Number(clipboardCenterRef.current?.x ?? 0),
          y: Number(clipboardCenterRef.current?.y ?? 0),
        },
        objects: clipboardRef.current,
      });
      const clipboardWarning = clipboardSaved ? '' : ' — только в текущей вкладке';

      if (deselect) {
        mobilePasteAwaitingPointRef.current = true;
        canvas.discardActiveObject();
        updateSelectionVisuals();
        updateSelectionState();
        updateSelectionStyleState();
        canvas.requestRenderAll();
        setSaveStatus(objects.length > 1
          ? `Скопировано: ${objects.length}. Нажмите место вставки${clipboardWarning}`
          : `Объект скопирован. Нажмите место вставки${clipboardWarning}`);
      } else {
        setSaveStatus(objects.length > 1
          ? `Скопировано: ${objects.length}${clipboardWarning}`
          : `Объект скопирован${clipboardWarning}`);
      }
      return true;
    } catch (error) {
      console.error('Не удалось скопировать выделение', error);
      setSaveStatus('Не удалось скопировать выделение');
      return false;
    }
  }, [boardId, getViewportSceneCenter, updateSelectionState, updateSelectionStyleState, updateSelectionVisuals]);

  const copySelectionFromToolbar = useCallback(async () => {
    const mobile = Number(navigator.maxTouchPoints ?? 0) > 0
      && (window.matchMedia?.('(pointer: coarse)')?.matches || window.innerWidth <= 1024);
    const copied = await copySelection({ deselect: mobile });
    if (!copied) return;

    // The pointer has to travel from the board to the toolbar before the Paste button
    // can be pressed. Keep a stable click anchor instead of using the later hover point
    // under the toolbar. Keyboard Ctrl/Cmd+V intentionally keeps its old cursor logic.
    toolbarPastePointRef.current = lastPointerSceneRef.current ?? getViewportSceneCenter();
    toolbarPasteAwaitingPointRef.current = true;
    if (!mobile) setSaveStatus('Скопировано. Нажмите точку вставки, затем «Вставить»');
  }, [copySelection, getViewportSceneCenter]);

  const insertPastedText = useCallback((rawText, point = null) => {
    const canvas = fabricCanvasRef.current;
    if (!canvas || !canEditRef.current) return false;
    const text = normalizePastedPlainText(rawText).replace(/\n+$/g, '');
    if (!text.trim()) return false;
    const requestedPoint = point && Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y))
      ? point
      : null;
    const position = requestedPoint ?? lastPointerSceneRef.current ?? getViewportSceneCenter();
    const hasLineBreaks = text.includes('\n');
    const estimatedWidth = text.length * fontSizeRef.current * 0.56;
    const longSingleLine = !hasLineBreaks && (text.length >= 64 || estimatedWidth > 620);
    const common = {
      left: Number(position.x ?? 0),
      top: Number(position.y ?? 0),
      originX: 'left',
      originY: 'top',
      fill: hexToRgba(colorRef.current, opacityRef.current),
      fontFamily: fontFamilyRef.current,
      fontSize: fontSizeRef.current,
      objectKind: 'text',
      editable: true,
      lineHeight: 1.22,
    };
    const textObject = longSingleLine
      ? new Textbox(text, {
        ...common,
        width: clamp((canvas.getWidth() / Math.max(canvas.getZoom(), MIN_ZOOM)) * 0.52, 280, 560),
        splitByGrapheme: false,
      })
      : new IText(text, common);
    const result = addObjectsToBoard([textObject]);
    if (result?.added?.length) selectInsertedObjects(result.added);
    return true;
  }, [addObjectsToBoard, getViewportSceneCenter, selectInsertedObjects]);

  const pasteSelection = useCallback(async (requestedPoint = null) => {
    const canvas = fabricCanvasRef.current;
    if (!canvas || !canEditRef.current) return false;
    if (!clipboardRef.current.length) {
      const savedClipboard = await getCrossBoardClipboard();
      if (Array.isArray(savedClipboard?.objects) && savedClipboard.objects.length) {
        clipboardRef.current = savedClipboard.objects;
        clipboardCenterRef.current = new Point(
          Number(savedClipboard?.center?.x ?? 0),
          Number(savedClipboard?.center?.y ?? 0),
        );
        internalClipboardArmedRef.current = true;
        clipboardSourceBoardIdRef.current = savedClipboard.sourceBoardId ?? null;
      }
    }
    if (!clipboardRef.current.length) return false;
    const hasRequestedToolbarPoint = Boolean(
      requestedPoint
      && Number.isFinite(Number(requestedPoint.x))
      && Number.isFinite(Number(requestedPoint.y)),
    );
    const point = hasRequestedToolbarPoint
      ? requestedPoint
      : (lastPointerSceneRef.current ?? getViewportSceneCenter());
    const sourceCenter = clipboardCenterRef.current ?? new Point(0, 0);
    const offsetX = Number(point.x) - Number(sourceCenter.x ?? 0);
    const offsetY = Number(point.y) - Number(sourceCenter.y ?? 0);
    const clientId = clientIdRef.current;

    try {
      if (clipboardSourceBoardIdRef.current
        && String(clipboardSourceBoardIdRef.current) !== String(boardId)) {
        setSaveStatus('Копирую изображения в новую доску…');
        clipboardRef.current = await copySerializedBoardImages(clipboardRef.current, boardId);
        clipboardSourceBoardIdRef.current = boardId;
        await setCrossBoardClipboard({
          version: 1,
          sourceBoardId: boardId,
          copiedAt: Date.now(),
          center: {
            x: Number(clipboardCenterRef.current?.x ?? 0),
            y: Number(clipboardCenterRef.current?.y ?? 0),
          },
          objects: clipboardRef.current,
        });
      }
      await preloadSerializedImages(clipboardRef.current);
      const revived = await util.enlivenObjects(clipboardRef.current);
      const pasteTransactionId = `paste:${clientId}:${Date.now()}:${randomToken(6)}`;
      const added = revived.map((object, index) => {
        object.set({
          left: Number(object.left ?? 0) + offsetX,
          top: Number(object.top ?? 0) + offsetY,
        });
        object.boardObjectId = randomToken(10);
        object.updatedAt = Date.now();
        object.updatedBy = clientId;
        object.creationSessionId = `${pasteTransactionId}:${index}`;
        object.creationClientId = clientId;
        object.selectionTransactionId = undefined;
        object.selectionSourceIds = undefined;
        object.transientPreview = undefined;
        object.transientTransformFallback = undefined;
        object.transientSelectionProxy = undefined;
        object.selectable = true;
        object.evented = true;
        object.hasControls = true;
        object.hasBorders = true;
        object.setCoords();
        canvas.add(object);
        return object;
      });

      // Capture one authoritative absolute-coordinate batch before ActiveSelection
      // converts members into group-local coordinates, then select the inserted batch.
      const records = getObjectRecords(added);
      selectInsertedObjects(added);
      // The local history entry must exist as soon as the objects become visible.
      // Waiting for preview delivery made Ctrl/Cmd+Z appear broken on a large paste.
      recordAction({ type: 'add', records });
      // Queue every durable chunk now, in order, before returning control to a possible
      // immediate Undo. Preview fanout is best-effort and must never block history/UI.
      sendRecordUpserts(records).catch(() => undefined);
      sendPreviewBatches(records).catch(() => undefined);
      schedulePersistence();
      updateSelectionVisuals();
      updateSelectionState();
      updateSelectionStyleState();
      mobilePasteAwaitingPointRef.current = false;
      if (hasRequestedToolbarPoint) {
        // The internal clipboard remains armed after a toolbar paste. Re-arm only the
        // point picker so the next click on the board replaces the previous anchor,
        // while pressing Paste again without another click still uses the last point.
        toolbarPasteAwaitingPointRef.current = true;
        setSaveStatus(added.length > 1
          ? `Вставлено: ${added.length}. Выберите следующую точку или вставьте ещё раз сюда`
          : 'Объект вставлен. Выберите следующую точку или вставьте ещё раз сюда');
      } else {
        setSaveStatus(added.length > 1 ? `Вставлено: ${added.length}` : 'Объект вставлен');
      }
      return true;
    } catch (error) {
      console.error('Не удалось вставить выделение', error);
      setSaveStatus('Не удалось вставить объекты');
      return false;
    }
  }, [
    boardId,
    getObjectRecords,
    getViewportSceneCenter,
    recordAction,
    schedulePersistence,
    selectInsertedObjects,
    sendPreviewBatches,
    sendRecordUpserts,
    updateSelectionState,
    updateSelectionStyleState,
    updateSelectionVisuals,
  ]);


  const deleteSelection = useCallback(() => {
    const canvas = fabricCanvasRef.current;
    if (!canvas || !canEditRef.current) return;
    const transaction = localSelectionTransactionRef.current;
    if (transaction?.proxy === canvas.getActiveObject()) {
      selectionTransactionTransitionRef.current = true;
      applyingRemoteRef.current = true;
      const composedDelete = localDeletionCompositorRef.current?.removeObjects?.([transaction.proxy]);
      if (!composedDelete) {
        canvas.discardActiveObject();
        canvas.remove(transaction.proxy);
      }
      applyingRemoteRef.current = false;
      realtimeRef.current?.sendSelectionTransaction?.({
        phase: 'commit',
        transactionId: transaction.transactionId,
        proxyId: transaction.proxyId,
        sourceIds: transaction.sourceIds,
        finalRecords: [],
        baseRevision: transaction.baseRevision,
      });
      sendDeletes(transaction.sourceIds);
      recordAction({ type: 'delete', records: transaction.sourceRecords });
      realtimeRef.current?.sendLock?.(transaction.sourceIds, false);
      localLockIdsRef.current = [];
      localSelectionTransactionRef.current = null;
      selectionTransactionTransitionRef.current = false;
      if (!composedDelete) canvas.requestRenderAll();
      updateSelectionState();
      updateSelectionStyleState();
      schedulePersistence();
      return;
    }
    const objects = canvas.getActiveObjects().filter((object) => !object.isEraserPath);
    if (!objects.length) return;
    if (isActiveSelectionObject(canvas.getActiveObject())) {
      canvas.discardActiveObject();
      objects.forEach((object) => object.setCoords());
    }
    const records = getObjectRecords(objects);
    const ids = records.map((record) => record.object.boardObjectId).filter(Boolean);
    applyingRemoteRef.current = true;
    const composedDelete = localDeletionCompositorRef.current?.removeObjects?.(objects);
    if (!composedDelete) objects.forEach((object) => canvas.remove(object));
    applyingRemoteRef.current = false;
    canvas.discardActiveObject();
    if (!composedDelete) canvas.requestRenderAll();
    updateSelectionState();
    updateSelectionStyleState();
    sendDeletes(ids);
    recordAction({ type: 'delete', records });
    schedulePersistence();
  }, [getObjectRecords, recordAction, schedulePersistence, sendDeletes, updateSelectionState, updateSelectionStyleState]);

  const clearBoard = useCallback(() => {
    const canvas = fabricCanvasRef.current;
    if (!canvas || !isOwner) return;
    if (!window.confirm('Удалить все линии и штрихи с доски?')) return;
    const objects = canvas.getObjects();
    if (!objects.length) return;
    const records = getObjectRecords(objects);
    const ids = records.map((record) => record.object.boardObjectId).filter(Boolean);
    applyingRemoteRef.current = true;
    const composedDelete = localDeletionCompositorRef.current?.removeObjects?.(objects, { fullCanvas: true });
    if (!composedDelete) objects.forEach((object) => canvas.remove(object));
    applyingRemoteRef.current = false;
    canvas.discardActiveObject();
    if (!composedDelete) canvas.requestRenderAll();
    updateSelectionState();
    updateSelectionStyleState();
    sendDeletes(ids);
    recordAction({ type: 'delete', records });
    schedulePersistence();
  }, [getObjectRecords, isOwner, recordAction, schedulePersistence, sendDeletes, updateSelectionState]);

  const changeZoom = useCallback((factor) => {
    const canvas = fabricCanvasRef.current;
    if (!canvas) return;
    const nextZoom = clamp(canvas.getZoom() * factor, MIN_ZOOM, MAX_ZOOM);
    canvas.zoomToPoint(new Point(canvas.getWidth() / 2, canvas.getHeight() / 2), nextZoom);
    setZoom(nextZoom);
    updateBackgroundTransform();
    sendTeacherViewThrottled();
  }, [sendTeacherViewThrottled, updateBackgroundTransform]);

  const resetZoom = useCallback(() => {
    const canvas = fabricCanvasRef.current;
    if (!canvas) return;
    // Keep the same scene point under the centre of the screen. Only the scale changes.
    canvas.zoomToPoint(new Point(canvas.getWidth() / 2, canvas.getHeight() / 2), 1);
    setZoom(1);
    updateBackgroundTransform();
    sendTeacherViewThrottled();
  }, [sendTeacherViewThrottled, updateBackgroundTransform]);

  const handleRemoteCursor = useCallback((cursor) => {
    if (!cursor?.clientId || !Number.isFinite(Number(cursor.x)) || !Number.isFinite(Number(cursor.y))) return;
    setRemoteCursors((current) => {
      const next = current.filter((item) => item.clientId !== cursor.clientId && Date.now() - Number(item.receivedAt ?? 0) < 12000);
      next.push(cursor);
      return next;
    });
  }, []);

  const handleRemoteLock = useCallback((message) => {
    const ids = Array.isArray(message?.objectIds) ? message.objectIds.filter(Boolean) : [];
    if (!ids.length) return;
    if (message.locked === false) {
      ids.forEach((id) => remoteLocksRef.current.delete(id));
    } else {
      ids.forEach((id) => remoteLocksRef.current.set(id, message));
    }
    setRemoteLocks([...remoteLocksRef.current.entries()].map(([objectId, lock]) => ({ objectId, ...lock })));
    const touched = ids.flatMap((id) => registeredObjectsById(id));
    applyObjectInteractivityToObjects(touched);
  }, [applyObjectInteractivityToObjects, registeredObjectsById]);

  const sendCursorThrottled = useCallback((scenePoint) => {
    if (!scenePoint || !realtimeRef.current) return;
    const cursorState = cursorSendRef.current;
    cursorState.pending = { x: scenePoint.x, y: scenePoint.y };
    const elapsed = Date.now() - cursorState.lastSentAt;
    const send = () => {
      cursorState.timer = null;
      if (!cursorState.pending || !realtimeRef.current) return;
      cursorState.lastSentAt = Date.now();
      realtimeRef.current.sendCursor(cursorState.pending);
      cursorState.pending = null;
    };
    if (elapsed >= LIVE_TRANSFORM_INTERVAL) send();
    else if (!cursorState.timer) {
      cursorState.timer = window.setTimeout(send, LIVE_TRANSFORM_INTERVAL - elapsed);
    }
  }, []);

  const sendLocalLock = useCallback((objects, locked) => {
    const targets = Array.isArray(objects) ? objects : flattenTarget(objects);
    const ids = targets
      .map((object) => object?.boardObjectId)
      .filter(Boolean);
    if (!ids.length || !realtimeRef.current) return;
    if (locked) localLockIdsRef.current = ids;
    else {
      const releasedIds = new Set(ids);
      localLockIdsRef.current = localLockIdsRef.current.filter((id) => !releasedIds.has(id));
    }
    realtimeRef.current.sendLock(ids, locked);
  }, []);


  const getLiveTransformObjects = useCallback((target) => (
    transformFramesForObjects(
      flattenTarget(target),
      fabricCanvasRef.current,
      liveTransformSendRef.current.zIndexMap,
    )
  ), []);

  const sendLiveTransformNow = useCallback((target, phase = 'update') => {
    const realtime = realtimeRef.current;
    const state = liveTransformSendRef.current;
    if (!realtime?.sendTransform || !target) return;
    if (!state.sessionId) state.sessionId = randomToken(12);
    const objects = getLiveTransformObjects(target);
    if (!objects.length) return;
    const signature = objects
      .map((frame) => `${frame.id}:${frame.matrix.join(',')}`)
      .join('|');
    if (phase === 'update' && signature === state.lastSignature) return;
    state.lastSignature = signature;
    state.sequence += 1;
    state.lastSentAt = Date.now();
    const pointer = lastPointerSceneRef.current;
    realtime.sendTransform({
      sessionId: state.sessionId,
      sessionOrder: state.sessionOrder,
      sequence: state.sequence,
      phase,
      mode: 'objects',
      baseRevision: Number(state.baseRevision ?? revisionRef.current ?? 0),
      objects,
      cursor: pointer && Number.isFinite(Number(pointer.x)) && Number.isFinite(Number(pointer.y))
        ? [Number(Number(pointer.x).toFixed(2)), Number(Number(pointer.y).toFixed(2))]
        : null,
    });
  }, [getLiveTransformObjects]);

  const beginLiveTransform = useCallback((target, { zIndexMap = null } = {}) => {
    const state = liveTransformSendRef.current;
    window.clearTimeout(state.timer);
    state.timer = null;
    state.pendingTarget = target;
    state.sessionId = randomToken(12);
    state.sessionOrder += 1;
    state.sequence = 0;
    state.lastSentAt = 0;
    state.lastSignature = '';
    state.baseRevision = Number(revisionRef.current ?? 0);
    // Moving objects does not alter layer order. Keeping this null removes the old
    // O(all board objects) z-index scan from the beginning of every Pencil transform.
    state.zIndexMap = zIndexMap ?? null;

    // Existing board objects already have rendering policy and coordinates. Re-running
    // markObject for every member used to recurse through complex groups and call
    // setCoords at the start of every Pencil move.
    const now = Date.now();
    flattenTarget(target).forEach((object, index) => {
      if (!object.boardObjectId) markObject(object, clientIdRef.current);
      else {
        object.updatedAt = Math.max(now + index, Number(object.updatedAt ?? 0) + 1);
        object.updatedBy = clientIdRef.current;
        registerCanvasObject(object);
      }
    });
    const sessionId = state.sessionId;
    sendLiveTransformNow(target, 'start');
    return sessionId;
  }, [markObject, registerCanvasObject, sendLiveTransformNow]);

  const sendLiveTransformThrottled = useCallback((target) => {
    if (!target || !realtimeRef.current?.sendTransform) return;
    const state = liveTransformSendRef.current;
    if (!state.sessionId) beginLiveTransform(target);
    state.pendingTarget = target;
    const elapsed = Date.now() - state.lastSentAt;
    const send = () => {
      state.timer = null;
      const latestTarget = state.pendingTarget;
      if (!latestTarget || !state.sessionId) return;
      sendLiveTransformNow(latestTarget, 'update');
    };
    if (elapsed >= LIVE_TRANSFORM_INTERVAL) send();
    else if (!state.timer) state.timer = window.setTimeout(send, LIVE_TRANSFORM_INTERVAL - elapsed);
  }, [beginLiveTransform, sendLiveTransformNow]);

  const endLiveTransform = useCallback((target, expectedSessionId = null) => {
    const state = liveTransformSendRef.current;
    if (!state.sessionId || (expectedSessionId && state.sessionId !== expectedSessionId)) return false;
    window.clearTimeout(state.timer);
    state.timer = null;
    state.pendingTarget = target ?? state.pendingTarget;
    if (state.pendingTarget) sendLiveTransformNow(state.pendingTarget, 'end');
    state.sessionId = null;
    state.sequence = 0;
    state.lastSentAt = 0;
    state.lastSignature = '';
    state.pendingTarget = null;
    state.zIndexMap = null;
    state.baseRevision = Number(revisionRef.current ?? 0);
    return true;
  }, [sendLiveTransformNow]);

  const processRemoteTransform = useCallback((message) => {
    const canvas = fabricCanvasRef.current;
    const remoteClientId = String(message?.clientId ?? '');
    const sessionId = String(message?.sessionId ?? '');
    const sessionOrder = Number(message?.sessionOrder ?? 0);
    const sequence = Number(message?.sequence ?? 0);
    const baseRevision = normalizeRealtimeBaseRevision(message?.baseRevision);
    const phase = ['start', 'update', 'end'].includes(message?.phase) ? message.phase : 'update';
    const rawFrames = Array.isArray(message?.objects) ? message.objects : [];
    const remotePointer = Array.isArray(message?.cursor) ? message.cursor : null;
    if (remotePointer && Number.isFinite(Number(remotePointer[0])) && Number.isFinite(Number(remotePointer[1]))) {
      handleRemoteCursor({
        clientId: remoteClientId,
        name: message?.name,
        color: message?.color,
        x: Number(remotePointer[0]),
        y: Number(remotePointer[1]),
        receivedAt: Date.now(),
      });
    }
    if (!canvas || !remoteClientId || !sessionId
      || !Number.isFinite(sessionOrder) || !Number.isFinite(sequence) || !rawFrames.length) return;

    const frameMap = new Map();
    rawFrames.forEach((frame) => {
      const matrix = compactTransformMatrix(frame?.matrix);
      if (!frame?.id || !matrix) return;
      frameMap.set(String(frame.id), {
        ...frame,
        id: String(frame.id),
        matrix,
      });
    });
    const frames = [...frameMap.values()];
    if (!frames.length) return;

    const latestClientOrder = Number(remoteTransformClientOrderRef.current.get(remoteClientId) ?? -1);
    if (sessionOrder < latestClientOrder) return;
    if (sessionOrder > latestClientOrder) {
      remoteTransformClientOrderRef.current.set(remoteClientId, sessionOrder);
    }

    const sessionKey = `${remoteClientId}:${sessionId}`;
    const previous = remoteTransformSessionsRef.current.get(sessionKey);
    if (previous?.ended || sequence <= Number(previous?.sequence ?? -1)) return;
    const affectedIds = frames.map((frame) => frame.id);
    const frameUpdatedAtById = new Map(frames.map((frame) => [
      String(frame.id),
      Number(frame.updatedAt ?? 0),
    ]));
    if (affectedIds.some((id) => localLockIdsRef.current.includes(id))) return;

    deduplicateRegisteredObjectIds(affectedIds);

    const usedObjects = new Set();
    let legacyPreviewCandidates = null;

    const resolveExistingObject = (frame) => {
      const creationClientId = frame.creationClientId ?? remoteClientId;
      const sameId = registeredObjectsById(frame.id);
      const sameSession = frame.creationSessionId
        ? registeredObjectsByCreationSession(creationClientId, frame.creationSessionId)
        : [];
      const candidates = [...new Set([...sameId, ...sameSession])]
        .filter((candidate) => !usedObjects.has(candidate));
      let object = candidates.find((candidate) => !candidate.transientPreview)
        ?? candidates[0]
        ?? null;

      // Older clients could finish a Pencil stroke with a different id than the
      // temporary drawing preview. Match such a preview by type, z-order and the
      // absolute transform of the first group frame instead of creating anything.
      if (!object) {
        if (!legacyPreviewCandidates) {
          legacyPreviewCandidates = canvas.getObjects().filter((candidate) => (
            candidate.transientPreview
            && (!candidate.creationClientId || candidate.creationClientId === remoteClientId)
          ));
        }
        const expectedKind = frame.objectKind ?? frame.objectType ?? null;
        const expectedIndex = Number(frame.zIndex ?? -1);
        let best = null;
        let bestScore = Number.POSITIVE_INFINITY;
        legacyPreviewCandidates.forEach((candidate) => {
          if (usedObjects.has(candidate)) return;
          const candidateKind = candidate.objectKind ?? candidate.type ?? null;
          if (expectedKind && candidateKind && expectedKind !== candidateKind) return;
          const matrix = typeof candidate.calcTransformMatrix === 'function'
            ? candidate.calcTransformMatrix()
            : null;
          const matrixScore = transformMatrixDistance(matrix, frame.matrix);
          const candidateIndex = canvas.getObjects().indexOf(candidate);
          const indexScore = expectedIndex >= 0 && candidateIndex >= 0
            ? Math.abs(candidateIndex - expectedIndex) * 6
            : 0;
          const score = matrixScore + indexScore;
          if (score < bestScore) {
            best = candidate;
            bestScore = score;
          }
        });
        if (best && bestScore < 240) object = best;
      }

      if (!object) return null;
      usedObjects.add(object);

      // Collapse objects carrying the same stable id/session. Other completed
      // previews from this author are removed after every frame has been resolved.
      candidates.forEach((candidate) => {
        if (candidate !== object) canvas.remove(candidate);
      });
      object.boardObjectId = frame.id;
      object.creationSessionId = frame.creationSessionId ?? object.creationSessionId ?? null;
      object.creationClientId = creationClientId ?? object.creationClientId ?? null;
      registerCanvasObject(object);
      return object;
    };

    const resolved = frames.map((frame) => ({ frame, object: resolveExistingObject(frame) }));
    const missing = resolved.filter(({ object }) => !object);
    if (missing.length) {
      const now = Date.now();
      remoteTransformSessionsRef.current.set(sessionKey, {
        ...(previous ?? {}),
        sequence,
        ended: false,
        receivedAt: now,
        objectIds: affectedIds,
        updatedAtById: frameUpdatedAtById,
        baseRevision,
        missing: true,
      });
      if (!previous?.missing || now - Number(previous?.receivedAt ?? 0) > 350) {
        window.setTimeout(() => syncFromServer(true), 80);
      }
      return;
    }

    // Never clear unrelated previews merely because the same person moved another
    // object. Each drawing preview is replaced only by its own creationSessionId.

    remoteTransformSessionsRef.current.set(sessionKey, {
      sequence,
      ended: phase === 'end',
      receivedAt: Date.now(),
      objectIds: affectedIds,
      updatedAtById: frameUpdatedAtById,
      baseRevision,
      missing: false,
    });

    const affectedSet = new Set(affectedIds);
    const activeIds = canvas.getActiveObjects().map((object) => object.boardObjectId).filter(Boolean);
    if (activeIds.some((id) => affectedSet.has(id))) canvas.discardActiveObject();

    applyingRemoteRef.current = true;
    try {
      let appliedAnyFrame = false;
      resolved.forEach(({ frame, object }) => {
        const incomingUpdatedAt = Number(frame.updatedAt ?? 0);
        const authoritativeUpdatedAt = Number(object.updatedAt ?? 0);
        const authoritativeFence = authoritativeObjectStatesRef.current.get(frame.id);
        // Realtime and durable operations use separate transports. Under an iPad
        // network stall an old update/start frame can therefore arrive after the
        // server-confirmed transform. The final live `end` frame and its durable
        // transform intentionally share one timestamp, therefore comparing only with
        // object.updatedAt is insufficient: equality is accepted before confirmation
        // but must be rejected after the per-object authoritative fence is installed.
        if (shouldRejectRealtimeObjectFrame(authoritativeFence, {
          baseRevision,
          updatedAt: incomingUpdatedAt,
        })) return;
        if (incomingUpdatedAt > 0 && authoritativeUpdatedAt > incomingUpdatedAt) return;
        util.applyTransformToObject(object, frame.matrix.map(Number));
        object.previewReceivedAt = Date.now();
        if (object.selectionTransactionId) {
          const transaction = remoteSelectionTransactionsRef.current.get(object.selectionTransactionId);
          if (transaction) transaction.receivedAt = Date.now();
        }
        object.dirty = true;
        object.setCoords();
        appliedAnyFrame = true;
      });
      if (appliedAnyFrame) canvas.requestRenderAll();
    } catch (error) {
      console.warn('Не удалось применить живое изменение объекта', error);
      window.setTimeout(() => syncFromServer(true), 120);
    } finally {
      applyingRemoteRef.current = false;
    }

    const lockNow = Date.now();
    const lockIds = [...new Set(resolved.flatMap(({ frame, object }) => (
      object?.transientSelectionProxy && Array.isArray(object.selectionSourceIds)
        ? object.selectionSourceIds.filter(Boolean).map(String)
        : [frame.id]
    )))];
    let lockUiChanged = false;
    lockIds.forEach((objectId) => {
      const existingLock = remoteLocksRef.current.get(objectId);
      const nextLock = {
        clientId: remoteClientId,
        name: message.name,
        color: message.color,
        objectIds: lockIds,
        locked: true,
        expiresAt: lockNow + (phase === 'end' ? 1800 : LIVE_TRANSFORM_LOCK_TTL),
      };
      remoteLocksRef.current.set(objectId, { ...existingLock, ...nextLock });
      if (!existingLock || existingLock.clientId !== remoteClientId) lockUiChanged = true;
    });
    if (lockUiChanged) {
      setRemoteLocks([...remoteLocksRef.current.entries()].map(([objectId, lock]) => ({ objectId, ...lock })));
      applyObjectInteractivityToObjects(
        lockIds.flatMap((objectId) => registeredObjectsById(objectId)),
      );
    }
    if (phase === 'end') {
      const durableIds = resolved
        .filter(({ object, frame }) => (
          !object?.transientSelectionProxy
          && Number(frame.updatedAt ?? 0) > 0
        ))
        .map(({ frame }) => String(frame.id));
      if (durableIds.length) {
        const minimumRevisionById = baseRevision == null
          ? null
          : new Map(durableIds.map((objectId) => [objectId, baseRevision + 1]));
        scheduleTargetedReconciliation(durableIds, {
          minimumUpdatedAtById: frameUpdatedAtById,
          minimumRevisionById,
        });
      }
    }
  }, [
    applyObjectInteractivityToObjects,
    deduplicateRegisteredObjectIds,
    handleRemoteCursor,
    registeredObjectsByCreationSession,
    registeredObjectsById,
    registerCanvasObject,
    scheduleTargetedReconciliation,
    syncFromServer,
  ]);

  const handleRemoteTransform = useCallback((message) => {
    const task = remoteTransformApplyQueueRef.current
      .catch(() => undefined)
      .then(() => processRemoteTransform(message));
    remoteTransformApplyQueueRef.current = task.catch((error) => {
      console.warn('Не удалось обработать живую трансформацию', error);
      window.setTimeout(() => syncFromServer(true), 150);
    });
  }, [processRemoteTransform, syncFromServer]);


  const sendLiveDrawNow = useCallback((phase = 'update') => {
    const realtime = realtimeRef.current;
    const state = liveDrawSendRef.current;
    if (!realtime?.sendDraw || !state.sessionId || !state.objectId || !state.tool) return;

    let from = 0;
    let points = [];
    let replace = false;
    if (state.tool === 'line') {
      // A line is always only two points, so replacing both is cheaper and safer than
      // maintaining a delta cursor for its moving endpoint.
      points = state.points;
      replace = true;
    } else {
      from = phase === 'start' ? 0 : state.lastSentPointIndex;
      points = state.points.slice(from);
      if (phase === 'update' && points.length === 0) return;
    }

    state.sequence += 1;
    state.lastSentAt = Date.now();
    realtime.sendDraw({
      sessionId: state.sessionId,
      sessionOrder: state.sessionOrder,
      sequence: state.sequence,
      phase,
      tool: state.tool,
      objectId: state.objectId,
      from,
      replace,
      points: points.map((point) => [
        Number(Number(point.x).toFixed(2)),
        Number(Number(point.y).toFixed(2)),
      ]),
      cursor: (() => {
        const pointer = lastPointerSceneRef.current ?? state.points[state.points.length - 1];
        return pointer && Number.isFinite(Number(pointer.x)) && Number.isFinite(Number(pointer.y))
          ? [Number(Number(pointer.x).toFixed(2)), Number(Number(pointer.y).toFixed(2))]
          : null;
      })(),
      style: state.style,
    });
    state.lastSentPointIndex = state.points.length;
  }, []);

  const beginLiveDraw = useCallback((toolName, objectId, firstPoint, style) => {
    const state = liveDrawSendRef.current;
    window.clearTimeout(state.timer);
    state.timer = null;
    if (state.sessionId) sendLiveDrawNow('cancel');
    state.sessionId = randomToken(12);
    state.sessionOrder += 1;
    state.sequence = 0;
    state.lastSentAt = 0;
    state.lastSentPointIndex = 0;
    state.tool = toolName;
    state.objectId = objectId;
    state.points = [{ x: firstPoint.x, y: firstPoint.y }];
    state.style = style;
    state.acceptingPoints = true;
    const sessionId = state.sessionId;
    sendLiveDrawNow('start');
    return sessionId;
  }, [sendLiveDrawNow]);

  const updateLiveDraw = useCallback((point) => {
    const state = liveDrawSendRef.current;
    if (!state.sessionId || !state.acceptingPoints || !point) return;
    if (state.tool === 'line') {
      state.points = [state.points[0], { x: point.x, y: point.y }];
    } else {
      const last = state.points[state.points.length - 1];
      const minimumDistance = Math.max(1.2, Number(state.style?.width ?? 3) * 0.22);
      if (last && Math.hypot(point.x - last.x, point.y - last.y) < minimumDistance) return;
      state.points.push({ x: point.x, y: point.y });
      if (state.points.length > 2400) {
        // Keep visual quality while bounding memory. Reset the delta cursor because the
        // point array was compacted locally.
        state.points = state.points.filter((_, index) => index % 2 === 0);
        state.lastSentPointIndex = 0;
      }
    }
    const elapsed = Date.now() - state.lastSentAt;
    const send = () => {
      state.timer = null;
      sendLiveDrawNow('update');
    };
    if (elapsed >= LIVE_TRANSFORM_INTERVAL) send();
    else if (!state.timer) state.timer = window.setTimeout(send, LIVE_TRANSFORM_INTERVAL - elapsed);
  }, [sendLiveDrawNow]);

  const finishLiveDraw = useCallback((phase = 'end', expectedSessionId = null) => {
    const state = liveDrawSendRef.current;
    if (!state.sessionId || (expectedSessionId && state.sessionId !== expectedSessionId)) return false;
    window.clearTimeout(state.timer);
    state.timer = null;
    sendLiveDrawNow(phase);
    state.sessionId = null;
    state.sequence = 0;
    state.lastSentAt = 0;
    state.lastSentPointIndex = 0;
    state.tool = null;
    state.objectId = null;
    state.points = [];
    state.style = null;
    state.acceptingPoints = false;
    return true;
  }, [sendLiveDrawNow]);

  const handleRemoteDraw = useCallback((message) => {
    const canvas = fabricCanvasRef.current;
    const remoteClientId = String(message?.clientId ?? '');
    const sessionId = String(message?.sessionId ?? '');
    const objectId = String(message?.objectId ?? '');
    const sessionOrder = Number(message?.sessionOrder ?? 0);
    const sequence = Number(message?.sequence ?? 0);
    const phase = ['start', 'update', 'end', 'cancel'].includes(message?.phase) ? message.phase : 'update';
    const toolName = message?.tool === 'line' ? 'line' : 'pencil';
    const remotePointer = Array.isArray(message?.cursor) ? message.cursor : null;
    if (remotePointer && Number.isFinite(Number(remotePointer[0])) && Number.isFinite(Number(remotePointer[1]))) {
      handleRemoteCursor({
        clientId: remoteClientId,
        name: message?.name,
        color: message?.color,
        x: Number(remotePointer[0]),
        y: Number(remotePointer[1]),
        receivedAt: Date.now(),
      });
    }
    const incomingPoints = Array.isArray(message?.points)
      ? message.points.map((point) => {
        if (Array.isArray(point)) return { x: Number(point[0]), y: Number(point[1]) };
        return { x: Number(point?.x), y: Number(point?.y) };
      }).filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
      : [];
    if (!canvas || !remoteClientId || !sessionId || !objectId) return;

    const deletedAt = Number(remoteDeletedObjectIdsRef.current.get(objectId)?.timestamp ?? 0);
    if (deletedAt && Date.now() - deletedAt < 120000) {
      if (phase === 'cancel' || phase === 'end') {
        removeRegisteredObjectsByCreationSession(
          remoteClientId,
          sessionId,
          null,
          { transientOnly: true },
        );
      }
      return;
    }

    const sessionKey = `${remoteClientId}:${sessionId}`;
    const previous = remoteDrawSessionsRef.current.get(sessionKey);
    if (previous?.objectId && String(previous.objectId) !== objectId) return;
    if (previous && (sessionOrder < previous.sessionOrder || sequence <= previous.sequence)) return;
    if (previous?.ended && phase !== 'cancel') return;

    if (phase === 'cancel') {
      remoteDrawSessionsRef.current.set(sessionKey, {
        ...(previous ?? {}), sessionOrder, sequence, objectId, receivedAt: Date.now(), ended: true,
      });
      removeRegisteredObjectsByCreationSession(
        remoteClientId,
        sessionId,
        null,
        { transientOnly: true },
      );
      canvas.requestRenderAll();
      return;
    }

    let points = Array.isArray(previous?.points) ? [...previous.points] : [];
    const replace = Boolean(message?.replace) || toolName === 'line' || phase === 'start';
    if (replace) {
      points = incomingPoints;
    } else {
      const requestedFrom = Math.max(0, Number(message?.from ?? points.length));
      if (requestedFrom > points.length) {
        remoteDrawSessionsRef.current.set(sessionKey, {
          ...(previous ?? {}),
          sessionOrder,
          sequence,
          objectId,
          receivedAt: Date.now(),
          missingDelta: true,
        });
        window.setTimeout(() => syncFromServer(true), 60);
        return;
      }
      points = points.slice(0, requestedFrom).concat(incomingPoints);
    }
    if (!points.length) return;

    const ended = phase === 'end';
    remoteDrawSessionsRef.current.set(sessionKey, {
      sessionOrder,
      sequence,
      objectId,
      points,
      tool: toolName,
      style: message?.style ?? previous?.style ?? {},
      receivedAt: Date.now(),
      ended,
      awaitingCommit: ended,
    });

    const sessionPreviews = registeredObjectsByCreationSession(remoteClientId, sessionId)
      .filter((object) => object.transientPreview);
    const existingObjects = registeredObjectsById(objectId);
    const authoritativeExisting = existingObjects.find((object) => !object.transientPreview);
    const existing = authoritativeExisting ?? existingObjects[0] ?? sessionPreviews[0] ?? null;
    if (authoritativeExisting) {
      removeRegisteredObjectsByCreationSession(
        remoteClientId,
        sessionId,
        null,
        { transientOnly: true },
      );
      canvas.requestRenderAll();
      return;
    }
    if (existing?.transientPreview && !existing.transientLiveDraw && !ended) return;

    const style = message?.style ?? previous?.style ?? {};
    const common = {
      stroke: typeof style.stroke === 'string' ? style.stroke : '#111827',
      strokeWidth: clamp(Number(style.width ?? 3), 1, 100),
      strokeUniform: true,
      opacity: clamp(Number(style.opacity ?? 1), 0.05, 1),
      fill: null,
      strokeLineCap: 'round',
      strokeLineJoin: 'round',
      selectable: false,
      evented: false,
      hasControls: false,
      objectKind: toolName === 'line' ? 'line' : 'path',
      boardObjectId: objectId,
      transientPreview: true,
      transientLiveDraw: !ended,
      transientAwaitingCommit: ended,
      previewReceivedAt: Date.now(),
      creationSessionId: sessionId,
      creationClientId: remoteClientId,
    };
    let preview = null;
    if (toolName === 'line') {
      const first = points[0];
      const last = points[points.length - 1] ?? first;
      preview = new Line([first.x, first.y, last.x, last.y], common);
    } else if (points.length >= 2) {
      preview = new Path(livePathData(points), common);
    }
    if (!preview) return;

    applyingRemoteRef.current = true;
    const previousRenderOnAddRemove = canvas.renderOnAddRemove;
    canvas.renderOnAddRemove = false;
    try {
      const oldObjects = [...new Set([...sessionPreviews, ...existingObjects])]
        .filter((object) => object !== authoritativeExisting);
      const oldIndex = existing ? canvas.getObjects().indexOf(existing) : canvas.getObjects().length;
      canvas.add(preview);
      if (oldIndex >= 0 && typeof canvas.moveObjectTo === 'function') {
        canvas.moveObjectTo(preview, Math.min(oldIndex, canvas.getObjects().length - 1));
      }
      oldObjects.forEach((object) => {
        if (object !== preview) canvas.remove(object);
      });
      preview.setCoords();
    } finally {
      applyingRemoteRef.current = false;
      canvas.renderOnAddRemove = previousRenderOnAddRemove;
      canvas.requestRenderAll();
    }
  }, [
    handleRemoteCursor,
    registeredObjectsByCreationSession,
    registeredObjectsById,
    removeRegisteredObjectsByCreationSession,
    syncFromServer,
  ]);

  const flushRemotePreviewQueue = useCallback(() => {
    const pendingState = remotePreviewPendingRef.current;
    window.clearTimeout(pendingState.timer);
    pendingState.timer = null;
    if (pendingState.draining) return;
    pendingState.draining = true;

    const task = remotePreviewApplyQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        while (pendingState.records.size) {
          const pending = [...pendingState.records.values()];
          pendingState.records.clear();
          const canvas = fabricCanvasRef.current;
          if (!canvas || !pending.length) continue;
          const active = pending.filter(({ record, token }) => {
            const id = String(record?.object?.boardObjectId ?? '');
            if (!id || remotePreviewTokensRef.current.get(id) !== token) return false;
            const tombstone = remoteDeletedObjectIdsRef.current.get(id);
            return !tombstone || Date.now() - Number(tombstone.timestamp ?? 0) >= 120000;
          });
          if (!active.length) continue;

          const serializedObjects = active.map(({ record }) => record.object);
          await preloadSerializedImages(serializedObjects);
          const revivedObjects = await util.enlivenObjects(serializedObjects);

          applyingRemoteRef.current = true;
          const previousRenderOnAddRemove = canvas.renderOnAddRemove;
          canvas.renderOnAddRemove = false;
          try {
            active.forEach(({ record, message, token }, index) => {
              const serialized = record?.object;
              const id = String(serialized?.boardObjectId ?? '');
              const revived = revivedObjects[index];
              if (!id || !revived || remotePreviewTokensRef.current.get(id) !== token) return;
              const tombstone = remoteDeletedObjectIdsRef.current.get(id);
              if (tombstone && Date.now() - Number(tombstone.timestamp ?? 0) < 120000) return;

              const creationSessionId = serialized?.creationSessionId;
              const creationClientId = serialized?.creationClientId ?? message?.clientId ?? '';
              const existingObjects = registeredObjectsById(id);
              const authoritativeExisting = existingObjects.find((object) => !object.transientPreview);
              const existing = authoritativeExisting ?? existingObjects[0] ?? null;
              const existingIndex = existing ? canvas.getObjects().indexOf(existing) : canvas.getObjects().length;
              if (authoritativeExisting) {
                if (creationSessionId) {
                  registeredObjectsByCreationSession(creationClientId, creationSessionId)
                    .filter((object) => object.transientPreview)
                    .forEach((object) => canvas.remove(object));
                } else {
                  existingObjects
                    .filter((object) => object.transientPreview)
                    .forEach((object) => canvas.remove(object));
                }
                return;
              }

              const oldObjects = [...new Set([
                ...existingObjects,
                ...(creationSessionId
                  ? registeredObjectsByCreationSession(creationClientId, creationSessionId)
                  : []),
              ])];
              revived.transientPreview = true;
              revived.transientLiveDraw = false;
              revived.transientAwaitingCommit = true;
              revived.previewReceivedAt = Date.now();
              revived.selectable = false;
              revived.evented = false;
              revived.hasControls = false;
              canvas.add(revived);
              const targetIndex = Number.isInteger(record.zIndex) ? record.zIndex : existingIndex;
              if (typeof canvas.moveObjectTo === 'function') {
                canvas.moveObjectTo(revived, clamp(targetIndex, 0, canvas.getObjects().length - 1));
              }
              oldObjects.forEach((object) => {
                if (object !== revived) canvas.remove(object);
              });
              revived.setCoords();
            });
          } finally {
            applyingRemoteRef.current = false;
            canvas.renderOnAddRemove = previousRenderOnAddRemove;
            canvas.requestRenderAll();
          }
        }
      })
      .catch((error) => {
        console.warn('Не удалось атомарно показать создаваемые объекты', error);
        window.setTimeout(() => syncFromServer(true), 100);
      })
      .finally(() => {
        pendingState.draining = false;
        if (pendingState.records.size && !pendingState.timer) {
          pendingState.timer = window.setTimeout(flushRemotePreviewQueue, 8);
        }
      });

    remotePreviewApplyQueueRef.current = task;
  }, [registeredObjectsByCreationSession, registeredObjectsById, syncFromServer]);

  const enqueueRemotePreviewRecords = useCallback((records, message) => {
    const safeRecords = Array.isArray(records) ? records : [];
    if (!safeRecords.length) return;
    const token = randomToken(8);
    safeRecords.forEach((record) => {
      const id = String(record?.object?.boardObjectId ?? '');
      if (!id) return;
      const tombstone = remoteDeletedObjectIdsRef.current.get(id);
      if (tombstone && Date.now() - Number(tombstone.timestamp ?? 0) < 120000) return;
      remotePreviewTokensRef.current.set(id, token);
      remotePreviewPendingRef.current.records.set(id, { record, message, token });
    });
    if (!remotePreviewPendingRef.current.records.size) return;
    if (!remotePreviewPendingRef.current.timer) {
      remotePreviewPendingRef.current.timer = window.setTimeout(flushRemotePreviewQueue, 12);
    }
  }, [flushRemotePreviewQueue]);

  const handleRemotePreview = useCallback((message) => {
    const records = Array.isArray(message?.records) ? message.records : [];
    if (!records.length) return;
    const chunkCount = Math.max(1, Number(message?.chunkCount ?? 1));
    const chunkIndex = clamp(Number(message?.chunkIndex ?? 0), 0, chunkCount - 1);
    const batchId = String(message?.batchId ?? '');
    if (chunkCount <= 1 || !batchId) {
      enqueueRemotePreviewRecords(records, message);
      return;
    }

    const batchKey = `${message?.clientId ?? ''}:${batchId}`;
    const existing = remotePreviewChunksRef.current.get(batchKey) ?? {
      chunks: new Map(),
      chunkCount,
      receivedAt: Date.now(),
      message,
    };
    existing.chunkCount = chunkCount;
    existing.receivedAt = Date.now();
    existing.message = message;
    existing.chunks.set(chunkIndex, records);
    remotePreviewChunksRef.current.set(batchKey, existing);
    if (existing.chunks.size < chunkCount) return;

    const merged = [];
    for (let index = 0; index < chunkCount; index += 1) {
      const chunk = existing.chunks.get(index);
      if (!Array.isArray(chunk)) return;
      merged.push(...chunk);
    }
    remotePreviewChunksRef.current.delete(batchKey);
    enqueueRemotePreviewRecords(merged, message);
  }, [enqueueRemotePreviewRecords]);


  const handleRemoteObjectLive = useCallback((message) => {
    const record = message?.record;
    const objectId = String(record?.object?.boardObjectId ?? '');
    if (!objectId || String(message?.clientId ?? '') === String(clientIdRef.current)) return;

    const task = authoritativeApplyQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        const canvas = fabricCanvasRef.current;
        if (!canvas || getLocalMutationIds().has(objectId)) return;
        const incomingUpdatedAt = Number(record?.object?.updatedAt ?? 0);
        const authoritativeFence = authoritativeObjectStatesRef.current.get(objectId);
        const baseRevision = normalizeRealtimeBaseRevision(message?.baseRevision);
        if (shouldRejectRealtimeObjectFrame(authoritativeFence, {
          baseRevision,
          updatedAt: incomingUpdatedAt,
        })) return;
        await preloadSerializedImages(record.object);
        const [revived] = await util.enlivenObjects([record.object]);
        if (!revived || getLocalMutationIds().has(objectId)) return;

        const existing = registeredObjectsById(objectId);
        const newestExistingUpdate = Math.max(
          0,
          ...existing.map((object) => Number(object?.updatedAt ?? 0)),
        );
        if (newestExistingUpdate >= incomingUpdatedAt && incomingUpdatedAt > 0) return;
        const existingIndex = existing.length
          ? canvas.getObjects().indexOf(existing[0])
          : Number(record.zIndex ?? canvas.getObjects().length);
        const activeIds = canvas.getActiveObjects()
          .map((object) => String(object?.boardObjectId ?? ''));

        applyingRemoteRef.current = true;
        const previousRenderOnAddRemove = canvas.renderOnAddRemove;
        canvas.renderOnAddRemove = false;
        try {
          if (activeIds.includes(objectId)) canvas.discardActiveObject();
          existing.forEach((object) => canvas.remove(object));
          revived.selectable = false;
          revived.evented = false;
          revived.hasControls = false;
          revived.hasBorders = false;
          revived.setCoords?.();
          canvas.add(revived);
          if (typeof canvas.moveObjectTo === 'function') {
            canvas.moveObjectTo(
              revived,
              clamp(Number(record.zIndex ?? existingIndex), 0, canvas.getObjects().length - 1),
            );
          }
        } finally {
          applyingRemoteRef.current = false;
          canvas.renderOnAddRemove = previousRenderOnAddRemove;
          applyObjectInteractivityToObjects([revived], { render: false });
          canvas.requestRenderAll();
        }
      });

    authoritativeApplyQueueRef.current = task;
  }, [applyObjectInteractivityToObjects, getLocalMutationIds, registeredObjectsById]);

  const handleRemoteDeletePreview = useCallback((message) => {
    const canvas = fabricCanvasRef.current;
    const baseRevision = normalizeRealtimeBaseRevision(message?.baseRevision);
    const localMutationIds = getLocalMutationIds();
    const ids = [...new Set((Array.isArray(message?.ids) ? message.ids : []).filter(Boolean).map(String))]
      .filter((objectId) => {
        if (localMutationIds.has(objectId)) return false;
        const fence = authoritativeObjectStatesRef.current.get(objectId);
        return !shouldRejectRealtimeObjectFrame(fence, { baseRevision });
      });
    if (!canvas || !ids.length) return;
    const timestamp = Date.now();
    const idSet = new Set(ids);
    const activeIds = canvas.getActiveObjects().map((object) => String(object.boardObjectId ?? ''));
    const deletedActiveObject = activeIds.some((id) => idSet.has(id));
    const previewObjects = [...new Set(ids.flatMap((id) => registeredObjectsById(id)))];

    applyingRemoteRef.current = true;
    const previousRenderOnAddRemove = canvas.renderOnAddRemove;
    canvas.renderOnAddRemove = false;
    let composedDelete = false;
    try {
      composedDelete = Boolean(localDeletionCompositorRef.current?.removeObjects?.(
        previewObjects,
        { discardActiveObject: deletedActiveObject },
      ));
      if (!composedDelete && deletedActiveObject) canvas.discardActiveObject();
      ids.forEach((id) => {
        remoteDeletedObjectIdsRef.current.set(id, {
          timestamp,
          clientId: String(message?.clientId ?? ''),
          confirmed: false,
        });
        remotePreviewTokensRef.current.delete(id);
        remotePreviewPendingRef.current.records.delete(id);
        removeBoardObjectsById(canvas, id);
      });

      for (const [sessionKey, session] of remoteDrawSessionsRef.current) {
        if (!idSet.has(String(session?.objectId ?? ''))) continue;
        const [remoteClientId, ...sessionParts] = sessionKey.split(':');
        removeRegisteredObjectsByCreationSession(remoteClientId, sessionParts.join(':'));
        remoteDrawSessionsRef.current.delete(sessionKey);
      }
      for (const [sessionKey, session] of remoteTransformSessionsRef.current) {
        if (Array.isArray(session?.objectIds)
          && session.objectIds.some((id) => idSet.has(String(id)))) {
          remoteTransformSessionsRef.current.delete(sessionKey);
        }
      }
    } finally {
      applyingRemoteRef.current = false;
      canvas.renderOnAddRemove = previousRenderOnAddRemove;
      updateSelectionState();
      updateSelectionStyleState();
      if (!composedDelete) canvas.requestRenderAll();
    }
    if (ids.length && message?.expectDurable !== false) {
      const minimumRevisionById = baseRevision == null
        ? null
        : new Map(ids.map((objectId) => [objectId, baseRevision + 1]));
      scheduleTargetedReconciliation(ids, {
        minimumRevisionById,
        delay: 320,
      });
    }
  }, [
    getLocalMutationIds,
    registeredObjectsById,
    removeRegisteredObjectsByCreationSession,
    scheduleTargetedReconciliation,
    updateSelectionState,
    updateSelectionStyleState,
  ]);

  const changeGuestMode = useCallback(async (mode) => {
    await setGuestMode(boardId, boardKey, mode);
    setGuestModeState(mode);
    realtimeRef.current?.sendMode(mode);
  }, [boardId, boardKey]);

  const createWholeBoardExport = useCallback(() => {
    const canvas = fabricCanvasRef.current;
    if (!canvas) throw new Error('Доска ещё не готова');
    return renderFabricCanvas(canvas, backgroundRef.current, { wholeBoard: true, multiplier: 2 });
  }, []);

  const createCurrentAreaExport = useCallback(() => {
    const canvas = fabricCanvasRef.current;
    if (!canvas) throw new Error('Доска ещё не готова');
    return renderFabricCanvas(canvas, backgroundRef.current, { wholeBoard: false, multiplier: 2 });
  }, []);

  const exportCurrentPng = useCallback(async () => {
    try {
      setSaveStatus('Создаю PNG текущей области…');
      const exportCanvas = createCurrentAreaExport();
      await downloadCanvasPng(exportCanvas, `${safeFilename(initialAccess.title)}-область.png`);
      setSaveStatus('PNG текущей области сохранён');
    } catch (error) {
      setSaveStatus(error instanceof Error ? error.message : 'Не удалось создать PNG');
    }
  }, [createCurrentAreaExport, initialAccess.title]);

  const exportPng = useCallback(async () => {
    try {
      setSaveStatus('Создаю PNG…');
      const exportCanvas = createWholeBoardExport();
      await downloadCanvasPng(exportCanvas, `${safeFilename(initialAccess.title)}.png`);
      setSaveStatus('PNG сохранён');
    } catch (error) {
      setSaveStatus(error instanceof Error ? error.message : 'Не удалось создать PNG');
    }
  }, [createWholeBoardExport, initialAccess.title]);

  const exportPdf = useCallback(() => {
    try {
      setSaveStatus('Создаю PDF…');
      const exportCanvas = createWholeBoardExport();
      downloadCanvasPdf(exportCanvas, `${safeFilename(initialAccess.title)}.pdf`, initialAccess.title);
      setSaveStatus('PDF сохранён');
    } catch (error) {
      setSaveStatus(error instanceof Error ? error.message : 'Не удалось создать PDF');
    }
  }, [createWholeBoardExport, initialAccess.title]);

  const copyBoardImage = useCallback(async () => {
    try {
      const exportCanvas = createWholeBoardExport();
      await copyCanvasPng(exportCanvas);
      setSaveStatus('Изображение скопировано');
    } catch (error) {
      setSaveStatus(error instanceof Error ? error.message : 'Не удалось скопировать изображение');
    }
  }, [createWholeBoardExport]);

  const shareBoardImage = useCallback(async () => {
    try {
      const exportCanvas = createWholeBoardExport();
      const shared = await shareCanvasPng(
        exportCanvas,
        `${safeFilename(initialAccess.title)}.png`,
        initialAccess.title,
      );
      setSaveStatus(shared ? 'Итог урока отправлен' : 'PNG сохранён — его можно отправить ученику');
    } catch (error) {
      if (error?.name !== 'AbortError') {
        setSaveStatus(error instanceof Error ? error.message : 'Не удалось отправить итог');
      }
    }
  }, [createWholeBoardExport, initialAccess.title]);

  useEffect(() => {
    const canvasElement = canvasElementRef.current;
    const host = canvasHostRef.current;
    if (!canvasElement || !host) return undefined;

    const clientId = clientIdRef.current;
    const canvas = new Canvas(canvasElement, {
      preserveObjectStacking: true,
      selection: false,
      enableRetinaScaling: true,
      perPixelTargetFind: false,
      skipOffscreen: true,
      targetFindTolerance: 8,
      fireRightClick: true,
      stopContextMenu: true,
    });
    // Full devicePixelRatio can be 3-4 on phones and would multiply the canvas area
    // by 9-16. A capped 2x backing store keeps vector edges sharp without making a
    // busy board unnecessarily heavy. setDimensions() below rebuilds both canvases
    // using this value.
    const renderPixelRatio = clamp(Number(window.devicePixelRatio ?? 1), 1, MAX_CANVAS_PIXEL_RATIO);
    canvas.getRetinaScaling = () => renderPixelRatio;
    fabricCanvasRef.current = canvas;
    canvas.freeDrawingBrush = new PencilBrush(canvas);

    const drawBoardBackgroundOnCanvas = (event = {}) => {
      const context = event.ctx ?? canvas.contextContainer;
      if (!context) return;
      const width = canvas.getWidth();
      const height = canvas.getHeight();
      const viewport = canvas.viewportTransform ?? [1, 0, 0, 1, 0, 0];
      const zoomLevel = Math.max(canvas.getZoom(), MIN_ZOOM);

      context.save();
      const retinaScale = Math.max(1, Number(canvas.getRetinaScaling?.() ?? 1));
      context.setTransform(retinaScale, 0, 0, retinaScale, 0, 0);
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, width, height);
      const boardBackground = backgroundRef.current;
      if (boardBackground === 'blank') {
        context.restore();
        return;
      }

      // Keep the background in the same scene coordinate system as Fabric objects.
      // At very small zooms, draw every 2nd/4th grid line instead of thousands of
      // sub-pixel lines; every visible line still represents an exact board coordinate.
      let sceneSpacing = 32;
      while (sceneSpacing * zoomLevel < 7) sceneSpacing *= 2;
      const screenSpacing = sceneSpacing * zoomLevel;
      const startX = ((Number(viewport[4] ?? 0) % screenSpacing) + screenSpacing) % screenSpacing;
      const startY = ((Number(viewport[5] ?? 0) % screenSpacing) + screenSpacing) % screenSpacing;

      if (boardBackground === 'grid') {
        context.beginPath();
        context.strokeStyle = 'rgba(203, 213, 225, 0.72)';
        context.lineWidth = 1;
        for (let x = startX; x <= width; x += screenSpacing) {
          context.moveTo(x, 0);
          context.lineTo(x, height);
        }
        for (let y = startY; y <= height; y += screenSpacing) {
          context.moveTo(0, y);
          context.lineTo(width, y);
        }
        context.stroke();
      } else if (boardBackground === 'dots') {
        context.fillStyle = 'rgba(148, 163, 184, 0.86)';
        const radius = clamp(0.85 + zoomLevel * 0.18, 0.9, 1.45);
        for (let x = startX; x <= width; x += screenSpacing) {
          for (let y = startY; y <= height; y += screenSpacing) {
            context.beginPath();
            context.arc(x, y, radius, 0, Math.PI * 2);
            context.fill();
          }
        }
      }
      context.restore();
    };
    canvas.on('before:render', drawBoardBackgroundOnCanvas);
    configureBrushAndMode();

    const transformSpatialIndex = {
      cellSize: PEN_TRANSFORM_SPATIAL_CELL_SIZE,
      cells: new Map(),
      globals: new Set(),
      entries: new Map(),
      orderDirty: true,
      ready: false,
    };

    const spatialCellKey = (x, y) => `${x}:${y}`;

    const removeTransformSpatialEntry = (object) => {
      const entry = transformSpatialIndex.entries.get(object);
      if (!entry) return;
      for (const key of entry.cells) {
        const bucket = transformSpatialIndex.cells.get(key);
        if (!bucket) continue;
        bucket.delete(object);
        if (!bucket.size) transformSpatialIndex.cells.delete(key);
      }
      transformSpatialIndex.globals.delete(object);
      transformSpatialIndex.entries.delete(object);
    };

    const indexTransformSpatialObject = (object, order = null) => {
      if (!object || object.canvas !== canvas || object.isEraserPath) return;
      const previousOrder = transformSpatialIndex.entries.get(object)?.order;
      const resolvedOrder = Number.isFinite(Number(order))
        ? Number(order)
        : (Number.isFinite(Number(previousOrder)) ? Number(previousOrder) : -1);
      removeTransformSpatialEntry(object);
      let bounds;
      try {
        bounds = finiteRect(object.getBoundingRect());
      } catch {
        return;
      }
      const cellSize = transformSpatialIndex.cellSize;
      const minX = Math.floor(bounds.left / cellSize);
      const maxX = Math.floor(bounds.right / cellSize);
      const minY = Math.floor(bounds.top / cellSize);
      const maxY = Math.floor(bounds.bottom / cellSize);
      const cellCount = Math.max(1, (maxX - minX + 1) * (maxY - minY + 1));
      const entry = {
        bounds,
        cells: [],
        order: resolvedOrder,
      };
      transformSpatialIndex.entries.set(object, entry);
      if (cellCount > PEN_TRANSFORM_SPATIAL_GLOBAL_CELL_LIMIT) {
        transformSpatialIndex.globals.add(object);
        return;
      }
      for (let y = minY; y <= maxY; y += 1) {
        for (let x = minX; x <= maxX; x += 1) {
          const key = spatialCellKey(x, y);
          const bucket = transformSpatialIndex.cells.get(key) ?? new Set();
          bucket.add(object);
          transformSpatialIndex.cells.set(key, bucket);
          entry.cells.push(key);
        }
      }
    };

    const refreshTransformSpatialOrder = () => {
      canvas.getObjects().forEach((object, index) => {
        const entry = transformSpatialIndex.entries.get(object);
        if (entry) entry.order = index;
        else indexTransformSpatialObject(object, index);
      });
      transformSpatialIndex.orderDirty = false;
      transformSpatialIndex.ready = true;
    };

    const rebuildTransformSpatialIndex = () => {
      transformSpatialIndex.cells.clear();
      transformSpatialIndex.globals.clear();
      transformSpatialIndex.entries.clear();
      canvas.getObjects().forEach((object, index) => indexTransformSpatialObject(object, index));
      transformSpatialIndex.orderDirty = false;
      transformSpatialIndex.ready = true;
    };

    const updateTransformSpatialObjects = (objects, { orderDirty = false } = {}) => {
      for (const object of Array.isArray(objects) ? objects : [objects]) {
        if (object) indexTransformSpatialObject(object);
      }
      if (orderDirty) transformSpatialIndex.orderDirty = true;
    };

    const queryTransformSpatialObjects = (sceneRect, excludedObjects = new Set()) => {
      if (!transformSpatialIndex.ready) rebuildTransformSpatialIndex();
      if (transformSpatialIndex.orderDirty) refreshTransformSpatialOrder();
      const rect = finiteRect(sceneRect);
      const cellSize = transformSpatialIndex.cellSize;
      const minX = Math.floor(rect.left / cellSize);
      const maxX = Math.floor(rect.right / cellSize);
      const minY = Math.floor(rect.top / cellSize);
      const maxY = Math.floor(rect.bottom / cellSize);
      const candidates = new Set(transformSpatialIndex.globals);
      for (let y = minY; y <= maxY; y += 1) {
        for (let x = minX; x <= maxX; x += 1) {
          const bucket = transformSpatialIndex.cells.get(spatialCellKey(x, y));
          bucket?.forEach((object) => candidates.add(object));
        }
      }
      return [...candidates]
        .filter((object) => {
          if (!object || excludedObjects.has(object) || object.visible === false
            || Number(object.opacity ?? 1) <= 0.001 || object.canvas !== canvas) return false;
          const entry = transformSpatialIndex.entries.get(object);
          return entry && rectsIntersect(entry.bounds, rect);
        })
        .sort((first, second) => (
          Number(transformSpatialIndex.entries.get(first)?.order ?? 0)
          - Number(transformSpatialIndex.entries.get(second)?.order ?? 0)
        ));
    };

    const originalCanvasMoveObjectTo = typeof canvas.moveObjectTo === 'function'
      ? canvas.moveObjectTo.bind(canvas)
      : null;
    if (originalCanvasMoveObjectTo) {
      canvas.moveObjectTo = (object, index) => {
        const result = originalCanvasMoveObjectTo(object, index);
        transformSpatialIndex.orderDirty = true;
        return result;
      };
    }

    penTransformSpatialApiRef.current = {
      rebuild: rebuildTransformSpatialIndex,
      updateObjects: updateTransformSpatialObjects,
      addObject(object) {
        indexTransformSpatialObject(object, Math.max(0, canvas.getObjects().length - 1));
        transformSpatialIndex.ready = true;
      },
      removeObject(object) {
        removeTransformSpatialEntry(object);
      },
      markOrderDirty() {
        transformSpatialIndex.orderDirty = true;
      },
    };

    let pendingPenRenderRestoreTimer = null;
    let pendingPenRenderRestoreSession = null;
    let penSelectionRenderGuard = null;
    let selectionTargetFindRestoreState = null;

    const restorePenSelectionRenderGuard = () => {
      const guard = penSelectionRenderGuard;
      if (!guard) return;
      window.clearTimeout(guard.restoreTimer);
      guard.restoreTimer = null;
      if (guard.frame != null) window.cancelAnimationFrame(guard.frame);
      guard.frame = null;
      if (canvas.requestRenderAll === guard.topOnlyRender) canvas.requestRenderAll = guard.originalRequestRenderAll;
      if (canvas.renderAll === guard.topOnlyRender) canvas.renderAll = guard.originalRenderAll;
      penSelectionRenderGuard = null;
    };

    const beginPenSelectionRenderGuard = () => {
      restorePenSelectionRenderGuard();
      const guard = {
        originalRequestRenderAll: canvas.requestRenderAll,
        originalRenderAll: canvas.renderAll,
        topOnlyRender: null,
        frame: null,
        restoreTimer: null,
      };
      guard.topOnlyRender = () => {
        if (guard.frame != null) return canvas;
        guard.frame = window.requestAnimationFrame(() => {
          guard.frame = null;
          if (fabricCanvasRef.current !== canvas) return;
          try { canvas.renderTop?.(); } catch { /* Ignore a disposed top layer. */ }
        });
        return canvas;
      };
      canvas.requestRenderAll = guard.topOnlyRender;
      canvas.renderAll = guard.topOnlyRender;
      penSelectionRenderGuard = guard;
    };

    const finishPenSelectionRenderGuard = () => {
      const guard = penSelectionRenderGuard;
      if (!guard) return;
      window.clearTimeout(guard.restoreTimer);
      guard.restoreTimer = window.setTimeout(() => restorePenSelectionRenderGuard(), 0);
    };

    const restorePenTransformRenderMethods = (session = pendingPenRenderRestoreSession) => {
      if (!session) return;
      window.clearTimeout(pendingPenRenderRestoreTimer);
      pendingPenRenderRestoreTimer = null;
      if (canvas.requestRenderAll === session.suppressedRequestRenderAll) {
        canvas.requestRenderAll = session.originalRequestRenderAll;
      }
      if (canvas.renderAll === session.suppressedRenderAll) {
        canvas.renderAll = session.originalRenderAll;
      }
      if (canvas.renderTop === session.suppressedRenderTop) {
        canvas.renderTop = session.originalRenderTop;
      }
      if (pendingPenRenderRestoreSession === session) pendingPenRenderRestoreSession = null;
    };

    const schedulePenTransformRenderRestore = (session) => {
      restorePenTransformRenderMethods();
      pendingPenRenderRestoreSession = session;
      // Fabric can request one final lower-canvas render after object:modified listeners
      // return. Keep that same-task request suppressed, then restore normal rendering
      // before the browser can deliver the next physical input event.
      pendingPenRenderRestoreTimer = window.setTimeout(() => {
        restorePenTransformRenderMethods(session);
      }, 0);
    };

    const createCroppedRasterLayer = (rect, className, zIndex) => {
      const safeRect = finiteRect(rect);
      const ratio = Math.max(1, Number(canvas.getRetinaScaling?.() ?? 1));
      const element = document.createElement('canvas');
      element.className = className;
      element.width = Math.max(1, Math.ceil(safeRect.width * ratio));
      element.height = Math.max(1, Math.ceil(safeRect.height * ratio));
      Object.assign(element.style, {
        position: 'absolute',
        left: `${safeRect.left}px`,
        top: `${safeRect.top}px`,
        width: `${safeRect.width}px`,
        height: `${safeRect.height}px`,
        pointerEvents: 'none',
        zIndex: String(zIndex),
        transform: 'translate3d(0px, 0px, 0)',
        transformOrigin: '0 0',
        willChange: 'transform',
      });
      return { element, rect: safeRect, ratio };
    };

    const hardClearPenTransformTop = () => {
      const contextTop = canvas.contextTop;
      const upperCanvas = canvas.upperCanvasEl;
      if (!contextTop || !upperCanvas) return;
      // Fabric's helper normally clears contextTop correctly, but the large-board
      // compositor deliberately interrupts the normal render lifecycle. Safari can
      // therefore leave pixels from offset controls (rotation / hand) in the backing
      // store even after the border itself has been refreshed. Clear the physical
      // backing canvas with an identity transform so no old control pixel survives.
      contextTop.save();
      try {
        contextTop.setTransform(1, 0, 0, 1, 0, 0);
        contextTop.clearRect(0, 0, upperCanvas.width, upperCanvas.height);
      } finally {
        contextTop.restore();
      }
      canvas.contextTopDirty = false;
    };

    const refreshPenTransformControlCoords = (target) => {
      if (!target) return;
      if (isActiveSelectionObject(target)) installSelectionMoveHandle(target);
      try { target.setCoords?.(); } catch { /* Ignore a disposed target. */ }
      // Fabric 7 can keep oCoords for controls with offsetX/offsetY one transform behind
      // on ActiveSelection. The border then lands at the new position while the rotation
      // square / custom hand are painted at the previous center. Recalculate oCoords
      // explicitly only for this large-board visual path.
      if (typeof target.calcOCoords === 'function') {
        try { target.oCoords = target.calcOCoords(); } catch { /* Keep Fabric's coords. */ }
      }
    };

    const disposeOrphanPenTransformLayers = (wrapper, keepElements = new Set()) => {
      if (!wrapper?.querySelectorAll) return;
      wrapper.querySelectorAll(
        'canvas.pen-transform-origin-patch, canvas.pen-transform-moving-overlay, canvas.pen-transform-controls-overlay',
      ).forEach((element) => {
        if (keepElements.has(element)) return;
        element.remove();
        // Release the backing store as well; this also guarantees a detached stale
        // controls overlay cannot remain as a Safari composited texture.
        element.width = 1;
        element.height = 1;
      });
    };

    const drawBackgroundIntoCroppedLayer = (layer) => {
      const context = layer.element.getContext('2d');
      if (!context) return;
      const rect = layer.rect;
      const ratio = layer.ratio;
      context.save();
      context.setTransform(ratio, 0, 0, ratio, -rect.left * ratio, -rect.top * ratio);
      context.fillStyle = '#ffffff';
      context.fillRect(rect.left, rect.top, rect.width, rect.height);
      const boardBackground = backgroundRef.current;
      if (boardBackground === 'blank') {
        context.restore();
        return;
      }
      const viewport = canvas.viewportTransform ?? [1, 0, 0, 1, 0, 0];
      const zoomLevel = Math.max(canvas.getZoom(), MIN_ZOOM);
      let sceneSpacing = 32;
      while (sceneSpacing * zoomLevel < 7) sceneSpacing *= 2;
      const screenSpacing = sceneSpacing * zoomLevel;
      const originX = ((Number(viewport[4] ?? 0) % screenSpacing) + screenSpacing) % screenSpacing;
      const originY = ((Number(viewport[5] ?? 0) % screenSpacing) + screenSpacing) % screenSpacing;
      const firstX = originX + Math.floor((rect.left - originX) / screenSpacing) * screenSpacing;
      const firstY = originY + Math.floor((rect.top - originY) / screenSpacing) * screenSpacing;
      if (boardBackground === 'grid') {
        context.beginPath();
        context.strokeStyle = 'rgba(203, 213, 225, 0.72)';
        context.lineWidth = 1;
        for (let x = firstX; x <= rect.right + screenSpacing; x += screenSpacing) {
          context.moveTo(x, rect.top);
          context.lineTo(x, rect.bottom);
        }
        for (let y = firstY; y <= rect.bottom + screenSpacing; y += screenSpacing) {
          context.moveTo(rect.left, y);
          context.lineTo(rect.right, y);
        }
        context.stroke();
      } else if (boardBackground === 'dots') {
        context.fillStyle = 'rgba(148, 163, 184, 0.86)';
        const radius = clamp(0.85 + zoomLevel * 0.18, 0.9, 1.45);
        for (let x = firstX; x <= rect.right + screenSpacing; x += screenSpacing) {
          for (let y = firstY; y <= rect.bottom + screenSpacing; y += screenSpacing) {
            context.beginPath();
            context.arc(x, y, radius, 0, Math.PI * 2);
            context.fill();
          }
        }
      }
      context.restore();
    };

    const renderObjectsIntoCroppedLayer = (layer, objects) => {
      const context = layer.element.getContext('2d');
      if (!context) return;
      const rect = layer.rect;
      const ratio = layer.ratio;
      const viewport = canvas.viewportTransform ?? [1, 0, 0, 1, 0, 0];
      context.save();
      context.setTransform(ratio, 0, 0, ratio, -rect.left * ratio, -rect.top * ratio);
      context.transform(
        Number(viewport[0] ?? 1),
        Number(viewport[1] ?? 0),
        Number(viewport[2] ?? 0),
        Number(viewport[3] ?? 1),
        Number(viewport[4] ?? 0),
        Number(viewport[5] ?? 0),
      );
      for (const object of objects) {
        if (!object || object.visible === false || Number(object.opacity ?? 1) <= 0.001) continue;
        try {
          object.render(context);
        } catch (error) {
          console.warn('Не удалось отрисовать локальный слой переноса', error);
        }
      }
      context.restore();
    };

    const captureSelectionControlsIntoCroppedLayer = (layer, target) => {
      const upperCanvas = canvas.upperCanvasEl;
      const contextTop = canvas.contextTop;
      if (!layer?.element || !upperCanvas || !contextTop || !target) return false;

      // Repaint only the active selection controls into Fabric's transparent top canvas.
      // This is O(1) with respect to board size and guarantees that a fresh single
      // selection, an ActiveSelection border, the rotation square and our hand control
      // are captured as one visual unit before the large-board compositor takes over.
      try {
        hardClearPenTransformTop();
        refreshPenTransformControlCoords(target);
        if (typeof target._renderControls === 'function') target._renderControls(contextTop);
        canvas.contextTopDirty = true;
      } catch {
        return false;
      }

      const context = layer.element.getContext('2d');
      if (!context) return false;
      const rect = layer.rect;
      const sourceRatioX = upperCanvas.width / Math.max(1, canvas.getWidth());
      const sourceRatioY = upperCanvas.height / Math.max(1, canvas.getHeight());
      const desiredSx = rect.left * sourceRatioX;
      const desiredSy = rect.top * sourceRatioY;
      const desiredEx = rect.right * sourceRatioX;
      const desiredEy = rect.bottom * sourceRatioY;
      const sx = Math.max(0, Math.floor(desiredSx));
      const sy = Math.max(0, Math.floor(desiredSy));
      const ex = Math.min(upperCanvas.width, Math.ceil(desiredEx));
      const ey = Math.min(upperCanvas.height, Math.ceil(desiredEy));
      const sw = ex - sx;
      const sh = ey - sy;
      if (sw <= 0 || sh <= 0) return false;

      const dx = Math.max(0, Math.round((sx / sourceRatioX - rect.left) * layer.ratio));
      const dy = Math.max(0, Math.round((sy / sourceRatioY - rect.top) * layer.ratio));
      const dw = Math.max(1, Math.round((sw / sourceRatioX) * layer.ratio));
      const dh = Math.max(1, Math.round((sh / sourceRatioY) * layer.ratio));
      context.save();
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, layer.element.width, layer.element.height);
      context.drawImage(upperCanvas, sx, sy, sw, sh, dx, dy, dw, dh);
      context.restore();
      return true;
    };

    const disposeCroppedRasterLayer = (layer) => {
      if (!layer?.element) return;
      layer.element.remove();
      // Release the backing store immediately. Repeated full-retina canvases otherwise
      // stay as GPU textures until Safari's GC and create the old cumulative slowdown.
      layer.element.width = 1;
      layer.element.height = 1;
    };

    const clipViewportRectToCanvas = (rect) => {
      const source = finiteRect(rect);
      const left = clamp(source.left, 0, canvas.getWidth());
      const top = clamp(source.top, 0, canvas.getHeight());
      const right = clamp(source.right, 0, canvas.getWidth());
      const bottom = clamp(source.bottom, 0, canvas.getHeight());
      if (right <= left || bottom <= top) return null;
      return finiteRect({ left, top, width: right - left, height: bottom - top });
    };

    const mergeOverlappingViewportRects = (rects) => {
      const merged = [];
      for (const source of Array.isArray(rects) ? rects : []) {
        let current = clipViewportRectToCanvas(source);
        if (!current) continue;
        let mergedAgain = true;
        while (mergedAgain) {
          mergedAgain = false;
          for (let index = merged.length - 1; index >= 0; index -= 1) {
            const candidate = merged[index];
            const touches = current.left <= candidate.right + 2
              && current.right + 2 >= candidate.left
              && current.top <= candidate.bottom + 2
              && current.bottom + 2 >= candidate.top;
            if (!touches) continue;
            const left = Math.min(current.left, candidate.left);
            const top = Math.min(current.top, candidate.top);
            const right = Math.max(current.right, candidate.right);
            const bottom = Math.max(current.bottom, candidate.bottom);
            current = finiteRect({ left, top, width: right - left, height: bottom - top });
            merged.splice(index, 1);
            mergedAgain = true;
          }
        }
        merged.push(current);
      }
      return merged;
    };

    const compositeCroppedLayerIntoLowerCanvas = (layer) => {
      const lowerCanvas = canvas.lowerCanvasEl;
      const context = lowerCanvas?.getContext?.('2d');
      if (!context || !layer?.element) return false;
      const ratioX = lowerCanvas.width / Math.max(1, canvas.getWidth());
      const ratioY = lowerCanvas.height / Math.max(1, canvas.getHeight());
      context.save();
      try {
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.drawImage(
          layer.element,
          Math.round(layer.rect.left * ratioX),
          Math.round(layer.rect.top * ratioY),
          Math.round(layer.rect.width * ratioX),
          Math.round(layer.rect.height * ratioY),
        );
      } finally {
        context.restore();
      }
      return true;
    };

    const renderLocalDeletionPatches = (rects) => {
      const patches = mergeOverlappingViewportRects(rects);
      if (!patches.length) return true;
      try {
        for (const screenRect of patches) {
          const patch = createCroppedRasterLayer(screenRect, 'object-eraser-patch', 0);
          try {
            drawBackgroundIntoCroppedLayer(patch);
            const sceneRect = sceneRectFromViewportRect(screenRect, canvas.viewportTransform);
            renderObjectsIntoCroppedLayer(patch, queryTransformSpatialObjects(sceneRect));
            if (!compositeCroppedLayerIntoLowerCanvas(patch)) return false;
          } finally {
            disposeCroppedRasterLayer(patch);
          }
        }
        return true;
      } catch (error) {
        console.warn('Не удалось отрисовать локальную область удаления', error);
        return false;
      }
    };

    const removeObjectsWithLocalDeletionPatches = (objects, {
      fullCanvas = false,
      discardActiveObject = true,
    } = {}) => {
      const targets = [...new Set((Array.isArray(objects) ? objects : [objects]).filter((object) => (
        object?.canvas === canvas
      )))];
      if (!targets.length) return true;
      const viewport = canvas.viewportTransform ?? [1, 0, 0, 1, 0, 0];
      const patchRects = fullCanvas
        ? [finiteRect({ left: 0, top: 0, width: canvas.getWidth(), height: canvas.getHeight() })]
        : targets.map((object) => {
          const entry = transformSpatialIndex.entries.get(object);
          const bounds = finiteRect(entry?.bounds ?? object.getBoundingRect());
          return expandedRect(viewportRectFromSceneRect(bounds, viewport), 4);
        });
      const previousRenderOnAddRemove = canvas.renderOnAddRemove;
      canvas.renderOnAddRemove = false;
      try {
        if (discardActiveObject) canvas.discardActiveObject();
        targets.forEach((object) => canvas.remove(object));
        // discardActiveObject() asks Fabric for a full lower-canvas render even though
        // only its transparent controls changed. Cancel that request and clear the top
        // backing store directly; the cropped patches update the lower scene below.
        if (discardActiveObject) {
          canvas.cancelRequestedRender?.();
          hardClearPenTransformTop();
        }
        if (!renderLocalDeletionPatches(patchRects)) canvas.requestRenderAll();
      } finally {
        canvas.renderOnAddRemove = previousRenderOnAddRemove;
      }
      return true;
    };

    localDeletionCompositorRef.current = {
      removeObjects: removeObjectsWithLocalDeletionPatches,
    };

    const finishPenTransformIsolation = ({ composite = true } = {}) => {
      const session = penTransformIsolationRef.current;
      if (!session || session.canvas !== canvas) return false;
      penTransformIsolationRef.current = null;
      if (session.topFrame != null) window.cancelAnimationFrame(session.topFrame);
      session.topFrame = null;
      // The lower scene is composited from cropped layers, but the Fabric selection
      // frame lives on the upper canvas. Recalculate it before the final top render so
      // every control stays together at the destination instead of being left behind.
      refreshPenTransformControlCoords(session.target);
      schedulePenTransformRenderRestore(session);

      if (session.upperCanvas) {
        session.upperCanvas.style.zIndex = session.originalUpperZIndex;
        session.upperCanvas.style.willChange = session.originalUpperWillChange;
      }

      if (composite && canvas.lowerCanvasEl) {
        const context = canvas.lowerCanvasEl.getContext('2d');
        if (context) {
          const ratioX = canvas.lowerCanvasEl.width / Math.max(1, canvas.getWidth());
          const ratioY = canvas.lowerCanvasEl.height / Math.max(1, canvas.getHeight());
          context.save();
          context.setTransform(1, 0, 0, 1, 0, 0);
          context.drawImage(
            session.patch.element,
            Math.round(session.patch.rect.left * ratioX),
            Math.round(session.patch.rect.top * ratioY),
            Math.round(session.patch.rect.width * ratioX),
            Math.round(session.patch.rect.height * ratioY),
          );
          context.drawImage(
            session.overlay.element,
            Math.round((session.overlay.rect.left + Number(session.deltaX ?? 0)) * ratioX),
            Math.round((session.overlay.rect.top + Number(session.deltaY ?? 0)) * ratioY),
            Math.round(session.overlay.rect.width * ratioX),
            Math.round(session.overlay.rect.height * ratioY),
          );
          context.restore();
        }
      }

      disposeCroppedRasterLayer(session.patch);
      disposeCroppedRasterLayer(session.overlay);
      updateTransformSpatialObjects(session.selectedObjects);

      // Keep the already-captured controls overlay alive until Fabric has completely
      // finished the current pointerup/object:modified task. Previously it was disposed
      // immediately while renderTop was still intentionally suppressed, leaving the
      // large-board selection active but visually blank whenever the Pencil stopped.
      if (penTransformTopRefreshFrameRef.current != null) {
        window.cancelAnimationFrame(penTransformTopRefreshFrameRef.current);
        penTransformTopRefreshFrameRef.current = null;
      }
      if (penTransformPendingControlsOverlayRef.current
        && penTransformPendingControlsOverlayRef.current !== session.controlsOverlay) {
        disposeCroppedRasterLayer(penTransformPendingControlsOverlayRef.current);
      }
      penTransformPendingControlsOverlayRef.current = session.controlsOverlay;

      penTransformTopRefreshFrameRef.current = window.requestAnimationFrame(() => {
        penTransformTopRefreshFrameRef.current = null;
        // Normal render methods are restored before the next physical input event, but
        // restore them here as well so this final controls paint is deterministic even
        // if WebKit delays the zero-timeout used by the render guard.
        restorePenTransformRenderMethods(session);

        if (fabricCanvasRef.current === canvas) {
          const active = canvas.getActiveObject();
          const contextTop = canvas.contextTop;
          if (active && contextTop && typeof active._renderControls === 'function') {
            try {
              hardClearPenTransformTop();
              refreshPenTransformControlCoords(active);
              active._renderControls(contextTop);
              canvas.contextTopDirty = true;
            } catch {
              hardClearPenTransformTop();
              try { session.originalRenderTop?.call(canvas); } catch { /* Ignore a disposed top layer. */ }
            }
          } else {
            hardClearPenTransformTop();
            try { session.originalRenderTop?.call(canvas); } catch { /* Ignore a disposed top layer. */ }
          }
        }

        if (penTransformPendingControlsOverlayRef.current === session.controlsOverlay) {
          penTransformPendingControlsOverlayRef.current = null;
        }
        disposeCroppedRasterLayer(session.controlsOverlay);
        disposeOrphanPenTransformLayers(canvas.wrapperEl ?? host);
      });
      return true;
    };
    finishPenTransformIsolationRef.current = finishPenTransformIsolation;

    const beginPenTransformIsolation = (target, transform, nativeEvent) => {
      const pointerType = nativeEvent?.pointerType
        ?? (selectionPenSessionRef.current.active || penInputRef.current.active ? 'pen' : 'unknown');
      const action = String(transform?.action ?? '');
      const moveAction = action === 'drag' || action === 'move' || (!transform?.corner && !action);
      if (pointerType !== 'pen' || !moveAction || canvas.getObjects().length < 90 || !target) return false;

      restorePenSelectionRenderGuard();
      restorePenTransformRenderMethods();
      finishPenTransformIsolation({ composite: true });
      restorePenTransformRenderMethods();
      // A new physical drag must never inherit the one-frame handoff layer from the
      // previous drag. If the user starts again before that frame is painted, release
      // the old overlay now; the new selection capture below becomes authoritative.
      if (penTransformTopRefreshFrameRef.current != null) {
        window.cancelAnimationFrame(penTransformTopRefreshFrameRef.current);
        penTransformTopRefreshFrameRef.current = null;
      }
      if (penTransformPendingControlsOverlayRef.current) {
        disposeCroppedRasterLayer(penTransformPendingControlsOverlayRef.current);
        penTransformPendingControlsOverlayRef.current = null;
      }
      canvas.cancelRequestedRender?.();

      const selectedObjects = flattenTarget(target)
        .filter((object) => object?.canvas === canvas && !object.isEraserPath);
      if (!selectedObjects.length) return false;
      const selectedSet = new Set(selectedObjects);
      if (!transformSpatialIndex.ready) rebuildTransformSpatialIndex();
      selectedObjects.forEach((object) => indexTransformSpatialObject(object));

      let targetSceneBounds;
      try {
        targetSceneBounds = finiteRect(target.getBoundingRect());
      } catch {
        return false;
      }
      const viewport = [...(canvas.viewportTransform ?? [1, 0, 0, 1, 0, 0])];
      const targetScreenRect = viewportRectFromSceneRect(targetSceneBounds, viewport);
      const screenRect = expandedRect(targetScreenRect, PEN_TRANSFORM_PATCH_PADDING);
      const controlsRect = expandedRect(targetScreenRect, PEN_TRANSFORM_CONTROLS_PADDING);
      if (screenRect.width < 1 || screenRect.height < 1) return false;

      const patch = createCroppedRasterLayer(screenRect, 'pen-transform-origin-patch', 2);
      const overlay = createCroppedRasterLayer(screenRect, 'pen-transform-moving-overlay', 3);
      const controlsOverlay = createCroppedRasterLayer(controlsRect, 'pen-transform-controls-overlay', 4);
      drawBackgroundIntoCroppedLayer(patch);
      const patchSceneRect = sceneRectFromViewportRect(screenRect, viewport);
      const underlyingObjects = queryTransformSpatialObjects(patchSceneRect, selectedSet);
      renderObjectsIntoCroppedLayer(patch, underlyingObjects);
      renderObjectsIntoCroppedLayer(overlay, [target]);
      captureSelectionControlsIntoCroppedLayer(controlsOverlay, target);

      const wrapper = canvas.wrapperEl ?? host;
      // There must be exactly one set of temporary compositor canvases per physical
      // Pencil drag. Remove any detached/orphan layer that escaped a previous Safari
      // frame before the new authoritative layers are attached.
      disposeOrphanPenTransformLayers(wrapper);
      const upperCanvas = canvas.upperCanvasEl;
      const originalUpperZIndex = upperCanvas?.style.zIndex ?? '';
      const originalUpperWillChange = upperCanvas?.style.willChange ?? '';
      wrapper.appendChild(patch.element);
      wrapper.appendChild(overlay.element);
      wrapper.appendChild(controlsOverlay.element);

      // The moving frame now lives in controlsOverlay. Clear the real Fabric top layer
      // for the duration of the large-board drag so no stationary second frame, hand or
      // rotation square can remain at the origin.
      try {
        hardClearPenTransformTop();
      } catch { /* Ignore a disposed top layer. */ }
      if (upperCanvas) {
        upperCanvas.style.zIndex = '5';
        upperCanvas.style.willChange = 'auto';
      }

      const originalRequestRenderAll = canvas.requestRenderAll;
      const originalRenderAll = canvas.renderAll;
      const originalRenderTop = canvas.renderTop;
      const session = {
        canvas,
        target,
        selectedObjects,
        patch,
        overlay,
        controlsOverlay,
        upperCanvas,
        originalUpperZIndex,
        originalUpperWillChange,
        originalRequestRenderAll,
        originalRenderAll,
        originalRenderTop,
        startLeft: Number(target.left ?? 0),
        startTop: Number(target.top ?? 0),
        viewport,
        deltaX: 0,
        deltaY: 0,
        topFrame: null,
      };
      const suppressFabricRenderDuringIsolatedMove = () => canvas;
      session.suppressedRequestRenderAll = suppressFabricRenderDuringIsolatedMove;
      session.suppressedRenderAll = suppressFabricRenderDuringIsolatedMove;
      session.suppressedRenderTop = suppressFabricRenderDuringIsolatedMove;
      canvas.requestRenderAll = session.suppressedRequestRenderAll;
      canvas.renderAll = session.suppressedRenderAll;
      canvas.renderTop = session.suppressedRenderTop;
      penTransformIsolationRef.current = session;
      return true;
    };

    const updatePenTransformIsolation = (target) => {
      const session = penTransformIsolationRef.current;
      if (!session || session.canvas !== canvas || session.target !== target) return false;
      // oCoords are otherwise stale until Fabric finishes the transform. renderTop()
      // would then leave the outer frame's rotation square and hand at the old position.
      refreshPenTransformControlCoords(target);
      const sceneX = Number(target.left ?? 0) - session.startLeft;
      const sceneY = Number(target.top ?? 0) - session.startTop;
      const viewport = session.viewport;
      const deltaX = Number(viewport[0] ?? 1) * sceneX + Number(viewport[2] ?? 0) * sceneY;
      const deltaY = Number(viewport[1] ?? 0) * sceneX + Number(viewport[3] ?? 1) * sceneY;
      session.deltaX = deltaX;
      session.deltaY = deltaY;
      session.overlay.element.style.transform = `translate3d(${deltaX}px, ${deltaY}px, 0)`;
      if (session.controlsOverlay?.element) {
        session.controlsOverlay.element.style.transform = `translate3d(${deltaX}px, ${deltaY}px, 0)`;
      }
      return true;
    };

    const resize = () => {
      finishPenTransformIsolation({ composite: true });
      restorePenTransformRenderMethods();
      canvas.setDimensions({ width: host.clientWidth, height: host.clientHeight });
      updateBackgroundTransform();
      canvas.requestRenderAll();
    };
    resize();
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(host);

    let disposed = false;
    async function rebuildInitialSnapshot(baseSnapshot, baseRevision) {
      let confirmedRevision = Number(baseRevision ?? 0);
      let confirmedRevisionGap = false;
      const confirmedActions = await getConfirmedActionsAfter(boardId, confirmedRevision);
      for (const action of confirmedActions) {
        const actionRevision = Number(action.revision ?? 0);
        if (!confirmedRevisionGap && actionRevision === confirmedRevision + 1) {
          confirmedRevision = actionRevision;
        } else if (actionRevision > confirmedRevision) {
          confirmedRevisionGap = true;
        }
      }
      const confirmedSnapshot = applyActionsToSnapshot(baseSnapshot, confirmedActions);
      const pendingActions = await getPendingActions(boardId);
      const snapshot = applyActionsToSnapshot(confirmedSnapshot, pendingActions);
      return {
        snapshot,
        confirmedRevision,
        confirmedRevisionGap,
        confirmedSnapshot,
        confirmedActions,
      };
    }

    async function paintInitialSnapshot(snapshot, confirmedRevision) {
      if (!snapshot?.canvas || disposed) return;
      const initialBackground = BACKGROUNDS.has(snapshot.background) ? snapshot.background : 'grid';
      applyBackground(initialBackground);
      applyingRemoteRef.current = true;
      try {
        await loadCanvasJsonProgressively(canvas, snapshot.canvas);
        const serializedById = new Map((snapshot.canvas.objects ?? [])
          .filter((object) => object?.boardObjectId)
          .map((object) => [String(object.boardObjectId), object]));
        canvas.getObjects().forEach((object) => {
          const serialized = object.pendingImageSerialized
            ?? serializedById.get(String(object.boardObjectId ?? ''));
          if (serialized) serializedObjectCacheRef.current.set(object, serialized);
        });
        rebuildObjectRegistry();
        penTransformSpatialApiRef.current?.rebuild?.();
        revisionRef.current = Number(confirmedRevision ?? 0);
        applyObjectInteractivity();
        configureBrushAndMode();
        updateBackgroundTransform();
        canvas.requestRenderAll();
      } finally {
        applyingRemoteRef.current = false;
      }
      retryPendingServerImages();
    }

    async function loadInitialData() {
      // Start the full recovery request immediately. It runs in parallel with IndexedDB
      // and with the first paint instead of blocking the board behind every old action.
      const accessSnapshotRevision = Number(
        initialAccess.snapshotRevision ?? initialAccess.revision ?? 0,
      );
      const accessCurrentRevision = Number(initialAccess.revision ?? accessSnapshotRevision);
      const needsServerRecovery = isSupabaseConfigured
        && (!initialAccess.snapshot || accessSnapshotRevision < accessCurrentRevision);
      const recoveryPromise = needsServerRecovery
        ? getBoardRecovery(boardId, boardKey).catch((recoveryError) => {
          console.warn('Snapshot recovery fallback', recoveryError);
          return null;
        })
        : Promise.resolve(null);

      // Clipboard restoration is unrelated to showing the lesson. Never make the board
      // wait for it on Safari/iPad where IndexedDB startup can occasionally be slow.
      getCrossBoardClipboard().then((savedClipboard) => {
        if (disposed) return;
        if (Array.isArray(savedClipboard?.objects)
          && savedClipboard.objects.length
          && Date.now() - Number(savedClipboard.copiedAt ?? 0) < 24 * 60 * 60_000) {
          clipboardRef.current = savedClipboard.objects;
          clipboardCenterRef.current = new Point(
            Number(savedClipboard?.center?.x ?? 0),
            Number(savedClipboard?.center?.y ?? 0),
          );
          internalClipboardArmedRef.current = true;
          clipboardSourceBoardIdRef.current = savedClipboard.sourceBoardId ?? null;
        }
      }).catch(() => undefined);

      const cached = await getCachedSnapshot(boardId);
      let baseSnapshot = initialAccess.snapshot ?? {
        version: 2,
        background: 'grid',
        canvas: { objects: [] },
      };
      let baseRevision = accessSnapshotRevision;
      let authoritativeBase = Boolean(initialAccess.snapshot);

      // Use a newer local snapshot even while online. This gives reloads on the same
      // device an immediate full board, while server synchronization still verifies it.
      const cachedRevision = Number(cached?.revision ?? -1);
      if (cached?.snapshot
        && cachedRevision >= baseRevision
        && (!isSupabaseConfigured || cachedRevision <= accessCurrentRevision)) {
        baseSnapshot = cached.snapshot;
        baseRevision = cachedRevision;
        authoritativeBase = true;
      }

      const localState = await rebuildInitialSnapshot(baseSnapshot, baseRevision);
      snapshotCompactBaseRef.current = applyOpsToSnapshot(localState.confirmedSnapshot, []);
      snapshotCompactBaseRevisionRef.current = localState.confirmedRevision;
      snapshotCompactActionsRef.current = [];
      snapshotCompactTargetRevisionRef.current = localState.confirmedRevision;
      seedAuthoritativeSnapshot(localState.confirmedSnapshot, localState.confirmedRevision);
      await paintInitialSnapshot(localState.snapshot, localState.confirmedRevision);
      if (disposed) return;

      boardReadyRef.current = true;
      syncFromServer(false);

      if (authoritativeBase && baseSnapshot?.canvas) {
        const sanitizedBaseSnapshot = applyOpsToSnapshot(baseSnapshot, []);
        await setCachedSnapshot(boardId, {
          snapshot: sanitizedBaseSnapshot,
          revision: baseRevision,
          savedAt: Date.now(),
        });
        await pruneConfirmedActionsThrough(boardId, baseRevision);
      }
      if (!isSupabaseConfigured && !localState.confirmedRevisionGap
        && localState.confirmedActions.length && localState.confirmedSnapshot?.canvas) {
        await setCachedSnapshot(boardId, {
          snapshot: localState.confirmedSnapshot,
          revision: localState.confirmedRevision,
          savedAt: Date.now(),
        });
        await pruneConfirmedActionsThrough(boardId, localState.confirmedRevision);
      }

      const recovery = await recoveryPromise;
      if (disposed || !recovery?.snapshot) {
        schedulePersistence(1_000);
        return;
      }

      // Reapply edits that are still waiting to reach Supabase, so a recovery response
      // can never make the user's newest local work disappear.
      const pendingActions = await getPendingActions(boardId);
      seedAuthoritativeSnapshot(recovery.snapshot, Number(recovery.revision ?? accessCurrentRevision));
      const recoveredSnapshot = applyActionsToSnapshot(recovery.snapshot, pendingActions);

      if (pendingServerWritesRef.current > 0 || getLocalMutationIds().size > 0) {
        syncFromServer(true);
        schedulePersistence(1_500);
        return;
      }

      const recoveryRevision = Number(recovery.revision ?? accessCurrentRevision);
      await applyAuthoritativeSnapshot(recoveredSnapshot, recoveryRevision);
      if (Number(revisionRef.current ?? 0) === recoveryRevision) {
        snapshotCompactBaseRef.current = applyOpsToSnapshot(recovery.snapshot, []);
        snapshotCompactBaseRevisionRef.current = recoveryRevision;
        snapshotCompactActionsRef.current = [];
        snapshotCompactTargetRevisionRef.current = recoveryRevision;
        schedulePersistence(700);
      }
    }
    loadInitialData().catch((caught) => {
      console.error(caught);
      setFatalError('Не удалось восстановить сохранённое состояние доски.');
    });

    realtimeRef.current = connectBoardRealtime({
      boardId,
      boardKey,
      realtimeKey: initialAccess.realtimeKey,
      clientId,
      name: participantName,
      permission,
      getKnownRevision: () => Number(revisionRef.current ?? 0),
      onOps: applyRemoteOps,
      onUsers: setUsers,
      onMode: handleRemoteMode,
      onSettings: handleRemoteSettings,
      onBackgroundLive: handleRemoteBackgroundLive,
      onCursor: handleRemoteCursor,
      onLock: handleRemoteLock,
      onTransform: handleRemoteTransform,
      onDraw: handleRemoteDraw,
      onPreview: handleRemotePreview,
      onObjectLive: handleRemoteObjectLive,
      onDeletePreview: handleRemoteDeletePreview,
      onSelectionTransaction: handleRemoteSelectionTransaction,
      onView: handleRemoteView,
      onViewJump: handleRemoteViewJump,
      onViewRequest: handleRemoteViewRequest,
      onGameLibraryVisibility: handleRemoteGameLibraryVisibility,
      onSyncRequired() {
        syncFromServer(true);
      },
      onCommit(result, action, batchMeta = null) {
        const currentRevision = Number(revisionRef.current ?? 0);
        const committedRevision = Number(result?.revision ?? currentRevision);
        const rejected = Array.isArray(result?.rejectedObjectIds)
          ? result.rejectedObjectIds
          : [];
        if (rejected.length > 0) {
          // The complete logical action was rejected atomically. Pause later writes,
          // restore the durable snapshot, then reapply still-pending local actions.
          realtimeRef.current?.pauseWrites?.();
          recoverRejectedServerAction(rejected);
          return;
        }
        const sequentialCommit = result?.changed === false
          ? committedRevision === currentRevision
          : committedRevision === currentRevision + 1;
        if (!result?.needsSync && sequentialCommit) {
          // The local Canvas already contains this action. Advance only across the one
          // server revision that was just confirmed; never Math.max over missed actions.
          revisionRef.current = committedRevision;
          const committedOps = Array.isArray(result?.appliedOps) ? result.appliedOps : [];
          rememberAuthoritativeOps(committedOps, committedRevision);
          const committedBackground = result?.appliedBackground ?? null;
          if (BACKGROUNDS.has(committedBackground)) {
            authoritativeBackgroundStateRef.current = {
              revision: committedRevision,
              background: committedBackground,
            };
          }
          bufferSnapshotAction(
            committedOps,
            committedBackground,
            committedRevision,
          );

          const isLastInBatch = Number(batchMeta?.batchIndex ?? 0)
            === Number(batchMeta?.batchCount ?? 1) - 1;
          if (isLastInBatch) {
            const batchActions = Array.isArray(batchMeta?.actions) ? batchMeta.actions : [action];
            const batchResults = Array.isArray(batchMeta?.results) ? batchMeta.results : [result];
            const verificationOps = finalVerificationOps(batchActions, batchResults);
            const verificationBackground = [...batchActions]
              .map((batchAction, index) => (
                batchResults[index]?.appliedBackground ?? null
              ))
              .reverse()
              .find((value) => BACKGROUNDS.has(value)) ?? null;
            // Promise waiters clear their per-object pending markers immediately after
            // onCommit returns. Verify on the next task so a new user gesture always wins.
            window.setTimeout(() => {
              authoritativeApplyQueueRef.current
                .catch(() => undefined)
                .then(async () => {
                  if (pendingServerWritesRef.current > 0 || getLocalMutationIds().size > 0) return;
                  if (verifyAuthoritativeOps(verificationOps, verificationBackground)) return;
                  await replayPendingActionsLocally([{
                    ops: verificationOps,
                    background: verificationBackground,
                  }]);
                  if (!verifyAuthoritativeOps(verificationOps, verificationBackground)) {
                    throw new Error('Локальная адресная проверка подтверждённого действия не пройдена');
                  }
                })
                .catch((verificationError) => {
                  console.warn('Не удалось адресно сверить собственное действие', verificationError);
                  setSaveStatus('Нужна повторная синхронизация изменения');
                  setSyncTone('error');
                });
            }, 0);
          }
        } else {
          syncFromServer(true);
        }
      },
      onPendingChange(count) {
        pendingServerWritesRef.current = count;
        setPendingCount(count);
        if (count > 0 && navigator.onLine !== false) {
          setSaveStatus(count === 1 ? 'Сохраняется…' : `${count} изменений ожидают отправки`);
          setSyncTone('saving');
        }
        if (count === 0) {
          if (snapshotCompactionNeededRef.current) schedulePersistence();
          if (syncRequestedRef.current) {
            const force = syncForceRef.current;
            syncRequestedRef.current = false;
            syncForceRef.current = false;
            window.setTimeout(() => syncFromServer(force), 0);
          }
        }
      },
      onStatus(status) {
        if (status === 'SUBSCRIBED') {
          setSaveStatus(isSupabaseConfigured ? 'Сохранено' : 'Локальный режим');
          setSyncTone('saved');
          syncFromServer(false);
        }
        if (status === 'SAVING') {
          setSaveStatus('Сохраняется…');
          setSyncTone('saving');
        }
        if (status === 'ACTION_CONFIRMED') {
          setSaveStatus('Действие сохранено на сервере');
          setSyncTone('saved');
          window.clearTimeout(transientStatusTimerRef.current);
          transientStatusTimerRef.current = window.setTimeout(() => setSaveStatus('Сохранено'), 1500);
        }
        if (status === 'OFFLINE') {
          setSaveStatus('Нет соединения');
          setSyncTone('offline');
        }
        if (status === 'SAVE_ERROR') {
          setSaveStatus('Не удалось сохранить');
          setSyncTone('error');
        }
        if (status === 'RECOVERING') {
          setSaveStatus('Восстанавливаю синхронизацию…');
          setSyncTone('recovering');
        }
        if (status === 'RECOVERED') {
          setSaveStatus('Синхронизация восстановлена');
          setSyncTone('recovered');
          window.clearTimeout(transientStatusTimerRef.current);
          transientStatusTimerRef.current = window.setTimeout(() => {
            setSaveStatus('Сохранено');
            setSyncTone('saved');
          }, 2200);
        }
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          setSaveStatus('Нет соединения');
          setSyncTone('offline');
        }
      },
    });

    const syncInterval = window.setInterval(
      () => syncFromServer(false),
      INSURANCE_SYNC_INTERVAL,
    );
    const localLockRefreshInterval = window.setInterval(() => {
      const ids = [...new Set((localLockIdsRef.current ?? []).filter(Boolean).map(String))];
      if (ids.length) realtimeRef.current?.sendLock?.(ids, true);
    }, LOCAL_LOCK_REFRESH_INTERVAL);
    const pendingImageRetryInterval = window.setInterval(
      () => retryPendingServerImages(),
      IMAGE_RETRY_INTERVAL,
    );
    const lockCleanupInterval = window.setInterval(() => {
      const now = Date.now();
      const expiredLockIds = [];
      for (const [objectId, lock] of remoteLocksRef.current) {
        if (Number(lock.expiresAt ?? 0) <= now) {
          remoteLocksRef.current.delete(objectId);
          expiredLockIds.push(objectId);
        }
      }
      if (expiredLockIds.length) {
        setRemoteLocks([...remoteLocksRef.current.entries()].map(([objectId, lock]) => ({ objectId, ...lock })));
        applyObjectInteractivityToObjects(
          expiredLockIds.flatMap((objectId) => registeredObjectsById(objectId)),
        );
      }
      setRemoteCursors((current) => current.filter((cursor) => now - Number(cursor.receivedAt ?? 0) < 12000));
      for (const [sessionKey, session] of remoteTransformSessionsRef.current) {
        if (now - Number(session.receivedAt ?? 0) > 15000) {
          const versionedIds = (session.objectIds ?? []).filter((objectId) => (
            Number(session.updatedAtById?.get?.(String(objectId)) ?? 0) > 0
          ));
          if (versionedIds.length) {
            const minimumRevisionById = session.baseRevision != null
              && Number.isFinite(Number(session.baseRevision))
              ? new Map(versionedIds.map((objectId) => [objectId, Number(session.baseRevision) + 1]))
              : null;
            scheduleTargetedReconciliation(versionedIds, {
              minimumUpdatedAtById: session.updatedAtById,
              minimumRevisionById,
            });
          }
          remoteTransformSessionsRef.current.delete(sessionKey);
        }
      }
      let removedTransient = false;
      for (const [transactionId, transaction] of remoteSelectionTransactionsRef.current) {
        if (now - Number(transaction.receivedAt ?? 0) <= 45000) continue;
        if (removeRegisteredSelectionTransactionObjects(transactionId).length) removedTransient = true;
        remoteSelectionTransactionsRef.current.delete(transactionId);
      }
      for (const [objectId, tombstone] of remoteDeletedObjectIdsRef.current) {
        if (now - Number(tombstone?.timestamp ?? 0) > 120000) {
          remoteDeletedObjectIdsRef.current.delete(objectId);
        }
      }
      for (const [transactionId, marker] of authoritativeSelectionTransactionsRef.current) {
        if (now - Number(marker?.recordedAt ?? 0) > 300000) {
          authoritativeSelectionTransactionsRef.current.delete(transactionId);
        }
      }
      for (const [objectId, state] of authoritativeObjectStatesRef.current) {
        if (state?.kind === 'delete' && now - Number(state.recordedAt ?? 0) > 120000) {
          authoritativeObjectStatesRef.current.delete(objectId);
        }
      }
      for (const [batchKey, batch] of remotePreviewChunksRef.current) {
        if (now - Number(batch?.receivedAt ?? 0) > 12000) {
          remotePreviewChunksRef.current.delete(batchKey);
        }
      }
      for (const [sessionKey, session] of remoteDrawSessionsRef.current) {
        const age = now - Number(session.receivedAt ?? 0);
        if (session.ended && session.awaitingCommit && age > 12000 && !session.syncRequested) {
          session.syncRequested = true;
          session.receivedAt = Number(session.receivedAt ?? now);
          remoteDrawSessionsRef.current.set(sessionKey, session);
          syncFromServer(true);
        }
        // Never create a short white gap by deleting a completed preview after five
        // seconds. Keep it as the visible fallback until the saved object replaces it.
        if (age > 90000) {
          const [remoteClientId, ...sessionParts] = sessionKey.split(':');
          const sessionId = sessionParts.join(':');
          if (removeTransientDrawPreviewsBySession(canvas, remoteClientId, sessionId).length) {
            removedTransient = true;
          }
          remoteDrawSessionsRef.current.delete(sessionKey);
        }
      }
      for (const object of [...canvas.getObjects()]) {
        const stalePreview = object.transientPreview
          && now - Number(object.previewReceivedAt ?? now) > 90000;
        const staleRemoteSelectionProxy = object.transientSelectionProxy
          && object.creationClientId !== clientIdRef.current
          && now - Number(object.previewReceivedAt ?? now) > 45000;
        if (stalePreview || staleRemoteSelectionProxy) {
          canvas.remove(object);
          removedTransient = true;
        }
      }
      if (removedTransient) {
        canvas.requestRenderAll();
        syncFromServer(true);
      }
    }, 1500);
    const syncOnFocus = () => {
      realtimeRef.current?.flushPending?.();
      syncFromServer(true);
    };
    const syncOnVisibility = () => {
      if (document.visibilityState === 'visible') syncOnFocus();
      else flushDeferredTransformPersistence({ force: true }).catch(() => undefined);
    };
    const syncOnPageShow = () => syncOnFocus();
    const syncOnPageHide = () => {
      flushDeferredTransformPersistence({ force: true }).catch(() => undefined);
    };
    const syncOnOnline = () => syncOnFocus();
    window.addEventListener('focus', syncOnFocus);
    window.addEventListener('pageshow', syncOnPageShow);
    window.addEventListener('pagehide', syncOnPageHide);
    window.addEventListener('online', syncOnOnline);
    document.addEventListener('visibilitychange', syncOnVisibility);

    function commitAddedObject(object) {
      if (!object || applyingRemoteRef.current || applyingHistoryRef.current) return;
      markObject(object, clientId);
      const records = getObjectRecords([object]);
      const alreadyStreamedAsLiveDraw = Boolean(object.creationSessionId)
        && ['path', 'line'].includes(String(object.objectKind ?? object.type ?? '').toLowerCase());
      // A completed live stroke is already kept visible on observers until the server
      // upsert arrives. Sending the whole serialized path again wastes messages and can
      // briefly race the incremental preview.
      if (!alreadyStreamedAsLiveDraw) realtimeRef.current?.sendPreview?.(records);
      sendRecordUpserts(records);
      recordAction({ type: 'add', records });
      schedulePersistence();
      canvas.requestRenderAll();
    }

    // A move/scale/rotate is durable as one tiny transform patch. The path/image/text
    // payload is never materialized here. While one patch is awaiting Supabase, newer
    // moves stay coalesced in this Map, so the visible queue remains one in-flight action
    // plus at most one latest state in memory.
    const deferredTransformEntries = new Map();
    let deferredTransformTimer = null;
    let deferredTransformFlushPromise = null;

    function scheduleDeferredTransformFlush(delay = 24) {
      window.clearTimeout(deferredTransformTimer);
      deferredTransformTimer = window.setTimeout(() => {
        deferredTransformTimer = null;
        flushDeferredTransformPersistence().catch(() => undefined);
      }, Math.max(0, Number(delay ?? 24)));
    }

    function cacheLightweightTransformEntry(entry) {
      if (!entry?.object || !entry?.transform) return;
      const cached = entry.cached ?? serializedObjectCacheRef.current.get(entry.object);
      if (!cached) return;
      // Mutating the already cached JSON placement fields is O(1) and does not clone a
      // long Pencil path. A later real content edit will therefore serialize the current
      // position correctly.
      Object.assign(cached, entry.transform, {
        boardObjectId: entry.id,
        updatedAt: entry.updatedAt,
        updatedBy: entry.updatedBy,
      });
      serializedObjectCacheRef.current.set(entry.object, cached);
    }

    function queueDeferredTransformPersistence(entries) {
      for (const entry of Array.isArray(entries) ? entries : []) {
        if (!entry?.id || !entry?.transform) continue;
        cacheLightweightTransformEntry(entry);
        deferredTransformEntries.set(String(entry.id), entry);
      }
      scheduleDeferredTransformFlush();
    }

    async function flushDeferredTransformPersistence({
      force = false,
      objectIds = null,
    } = {}) {
      const requestedIds = objectIds instanceof Set
        ? objectIds
        : new Set((Array.isArray(objectIds) ? objectIds : []).map(String));
      if (requestedIds.size) {
        const overlaps = [...requestedIds].some((id) => deferredTransformEntries.has(String(id)));
        if (!overlaps) return deferredTransformFlushPromise;
      }

      if (deferredTransformFlushPromise) {
        if (!force || !deferredTransformEntries.size) return deferredTransformFlushPromise;
        // Ordering-sensitive delete/undo/page-hide may enqueue one final coalesced patch
        // behind the already in-flight action. Normal rapid moves never take this path.
        const forcedEntries = [...deferredTransformEntries.values()];
        deferredTransformEntries.clear();
        const forcedPromise = sendLightweightTransforms(forcedEntries, {
          skipDeferredFlush: true,
        }).catch(() => null);
        return Promise.allSettled([deferredTransformFlushPromise, forcedPromise]);
      }
      if (!deferredTransformEntries.size) return null;

      window.clearTimeout(deferredTransformTimer);
      deferredTransformTimer = null;
      const entries = [...deferredTransformEntries.values()];
      deferredTransformEntries.clear();
      deferredTransformFlushPromise = sendLightweightTransforms(entries, {
        skipDeferredFlush: true,
      }).catch(() => null).finally(() => {
        deferredTransformFlushPromise = null;
        if (deferredTransformEntries.size) scheduleDeferredTransformFlush(0);
      });
      return deferredTransformFlushPromise;
    }

    deferredTransformFlushRef.current = flushDeferredTransformPersistence;



    let creationPreviewFrame = null;
    let pendingNativeCreationPointer = null;

    function clearCreationPreview() {
      if (creationPreviewFrame != null) {
        window.cancelAnimationFrame(creationPreviewFrame);
        creationPreviewFrame = null;
      }
      const contextTop = canvas.contextTop;
      if (!contextTop) return;
      try {
        canvas.clearContext(contextTop);
      } catch {
        contextTop.clearRect(0, 0, canvas.upperCanvasEl.width, canvas.upperCanvasEl.height);
      }
    }

    function drawCreationPreviewNow() {
      creationPreviewFrame = null;
      const draft = shapeDraftRef.current ?? lineRef.current;
      const object = draft?.object;
      const contextTop = canvas.contextTop;
      if (!contextTop) return;

      try {
        canvas.clearContext(contextTop);
      } catch {
        contextTop.clearRect(0, 0, canvas.upperCanvasEl.width, canvas.upperCanvasEl.height);
      }
      if (!object || draft.cancelled || draft.finalized) return;

      contextTop.save();
      try {
        const viewport = canvas.viewportTransform ?? [1, 0, 0, 1, 0, 0];
        contextTop.transform(
          Number(viewport[0] ?? 1),
          Number(viewport[1] ?? 0),
          Number(viewport[2] ?? 0),
          Number(viewport[3] ?? 1),
          Number(viewport[4] ?? 0),
          Number(viewport[5] ?? 0),
        );
        object.render(contextTop);
      } finally {
        contextTop.restore();
      }
    }

    function scheduleCreationPreview() {
      if (creationPreviewFrame != null) return;
      creationPreviewFrame = window.requestAnimationFrame(drawCreationPreviewNow);
    }

    function prepareCreationPreviewObject(object) {
      if (!object) return;
      object.canvas = canvas;
      Object.defineProperty(object, 'creationDraftZIndex', {
        configurable: true,
        writable: true,
        value: canvas.getObjects().length,
      });
    }

    function addCreationObjectWithoutImmediateRender(object) {
      if (!object) return;
      try { delete object.creationDraftZIndex; } catch { object.creationDraftZIndex = undefined; }
      const previousRenderOnAddRemove = canvas.renderOnAddRemove;
      canvas.renderOnAddRemove = false;
      try {
        canvas.add(object);
      } finally {
        canvas.renderOnAddRemove = previousRenderOnAddRemove;
      }
    }

    function creationPointerFromNativeEvent(nativeEvent) {
      const directPointerId = nativeEvent?.pointerId;
      const directPointerType = typeof nativeEvent?.pointerType === 'string'
        ? nativeEvent.pointerType
        : null;
      if (directPointerId != null) {
        const pointerType = directPointerType || 'unknown';
        return {
          key: `pointer:${pointerType}:${String(directPointerId)}`,
          pointerId: directPointerId,
          pointerType,
        };
      }

      const changedTouches = nativeEvent?.changedTouches
        ? Array.from(nativeEvent.changedTouches)
        : [];
      const activeTouches = nativeEvent?.touches
        ? Array.from(nativeEvent.touches)
        : [];
      const touch = changedTouches.length === 1
        ? changedTouches[0]
        : (activeTouches.length === 1 ? activeTouches[0] : null);
      if (touch?.identifier != null) {
        return {
          key: `touch:${String(touch.identifier)}`,
          pointerId: touch.identifier,
          pointerType: 'touch',
        };
      }

      const eventType = String(nativeEvent?.type ?? '').toLowerCase();
      const pointerType = directPointerType
        || (eventType.startsWith('touch') ? 'touch' : (eventType.startsWith('mouse') ? 'mouse' : 'unknown'));
      return {
        key: pointerType === 'mouse' ? 'mouse:primary' : null,
        pointerId: null,
        pointerType,
      };
    }

    function rememberNativeCreationPointer(event) {
      if (!['line', 'shape'].includes(activeToolRef.current)) return;
      if (shapeDraftRef.current || lineRef.current) return;
      if (Number(event?.button ?? 0) > 0) return;
      pendingNativeCreationPointer = {
        key: `pointer:${String(event.pointerType || 'unknown')}:${String(event.pointerId)}`,
        pointerId: event.pointerId,
        pointerType: event.pointerType || 'unknown',
        clientX: Number(event.clientX ?? 0),
        clientY: Number(event.clientY ?? 0),
        startedAt: performance.now(),
      };
    }

    function creationPointerForDraft(nativeEvent) {
      const captured = pendingNativeCreationPointer;
      pendingNativeCreationPointer = null;
      if (captured && performance.now() - captured.startedAt < 500) return captured;
      return creationPointerFromNativeEvent(nativeEvent);
    }

    function clearPendingNativeCreationPointer(event = null) {
      if (!pendingNativeCreationPointer) return;
      if (event?.pointerId != null
        && String(event.pointerId) !== String(pendingNativeCreationPointer.pointerId)) return;
      pendingNativeCreationPointer = null;
    }

    function creationDraftOwnsEvent(draft, nativeEvent) {
      if (!draft) return false;
      const pointer = creationPointerFromNativeEvent(nativeEvent);
      if (draft.pointerId != null && pointer.pointerId != null) {
        return String(draft.pointerId) === String(pointer.pointerId);
      }
      if (draft.pointerKey && pointer.key) return draft.pointerKey === pointer.key;
      if (draft.pointerType && draft.pointerType !== 'unknown'
        && pointer.pointerType && pointer.pointerType !== 'unknown') {
        return draft.pointerType === pointer.pointerType;
      }
      // Some Fabric compatibility events do not retain pointer metadata. Accept such
      // an event only when there is no contradictory identity to compare.
      return pointer.key == null && pointer.pointerId == null;
    }

    function finalizeCreationDraft(nativeEvent = null) {
      const shapeDraft = shapeDraftRef.current;
      if (shapeDraft) {
        if (nativeEvent && !creationDraftOwnsEvent(shapeDraft, nativeEvent)) return false;
        if (shapeDraft.cancelled || shapeDraft.finalized) return false;
        shapeDraft.finalized = true;
        shapeDraftRef.current = null;
        clearCreationPreview();
        endLiveTransform(shapeDraft.object, shapeDraft.sessionId);

        const bounds = shapeDraft.object.getBoundingRect();
        if (bounds.width < 4 || bounds.height < 4) {
          realtimeRef.current?.sendDeletePreview?.(
            [shapeDraft.object.boardObjectId],
            { expectDurable: false },
          ).catch?.(() => undefined);
          setSaveStatus('Фигура слишком маленькая');
          return true;
        }

        shapeDraft.object.set({
          selectable: canEditRef.current,
          evented: canEditRef.current,
          hasControls: canEditRef.current,
          hasBorders: canEditRef.current,
        });
        shapeDraft.object.setCoords();
        addCreationObjectWithoutImmediateRender(shapeDraft.object);
        commitAddedObject(shapeDraft.object);
        setSaveStatus('Фигура создана — можно нарисовать следующую');
        return true;
      }

      const lineDraft = lineRef.current;
      if (lineDraft) {
        if (nativeEvent && !creationDraftOwnsEvent(lineDraft, nativeEvent)) return false;
        if (lineDraft.cancelled || lineDraft.finalized) return false;
        lineDraft.finalized = true;
        lineRef.current = null;
        lineStartRef.current = null;
        clearCreationPreview();

        const line = lineDraft.object;
        const length = Math.hypot(
          Number(line.x2) - lineDraft.start.x,
          Number(line.y2) - lineDraft.start.y,
        );
        if (length < 3) {
          finishLiveDraw('cancel', lineDraft.sessionId);
          return true;
        }

        finishLiveDraw('end', lineDraft.sessionId);
        line.set({
          selectable: canEditRef.current,
          evented: canEditRef.current,
          hasControls: canEditRef.current,
          hasBorders: canEditRef.current,
        });
        line.setCoords();
        addCreationObjectWithoutImmediateRender(line);
        commitAddedObject(line);
        return true;
      }

      return false;
    }


    function cancelCreationDraft(reason = 'cancel', nativeEvent = null) {
      let cancelled = false;
      let removedFromMainCanvas = false;
      const lineDraft = lineRef.current;
      if (lineDraft
        && (!nativeEvent || creationDraftOwnsEvent(lineDraft, nativeEvent))
        && !lineDraft.finalized
        && !lineDraft.cancelled) {
        lineDraft.cancelled = true;
        lineDraft.finalized = true;
        lineRef.current = null;
        lineStartRef.current = null;
        finishLiveDraw('cancel', lineDraft.sessionId);
        if (canvas.getObjects().includes(lineDraft.object)) {
          applyingRemoteRef.current = true;
          canvas.remove(lineDraft.object);
          applyingRemoteRef.current = false;
          removedFromMainCanvas = true;
        }
        cancelled = true;
      }

      const shapeDraft = shapeDraftRef.current;
      if (shapeDraft
        && (!nativeEvent || creationDraftOwnsEvent(shapeDraft, nativeEvent))
        && !shapeDraft.finalized
        && !shapeDraft.cancelled) {
        shapeDraft.cancelled = true;
        shapeDraft.finalized = true;
        shapeDraftRef.current = null;
        endLiveTransform(shapeDraft.object, shapeDraft.sessionId);
        if (canvas.getObjects().includes(shapeDraft.object)) {
          applyingRemoteRef.current = true;
          canvas.remove(shapeDraft.object);
          applyingRemoteRef.current = false;
          removedFromMainCanvas = true;
        }
        realtimeRef.current?.sendDeletePreview?.(
          [shapeDraft.object.boardObjectId],
          { expectDurable: false },
        ).catch?.(() => undefined);
        cancelled = true;
      }

      if (cancelled) {
        clearCreationPreview();
        if (removedFromMainCanvas) canvas.requestRenderAll();
        if (reason === 'pointercancel') setSaveStatus('Создание объекта отменено системой ввода');
      }
      return cancelled;
    }

    cancelCreationDraftRef.current = cancelCreationDraft;

    const redrawCreationPreviewAfterCanvasRender = () => {
      if (shapeDraftRef.current || lineRef.current) scheduleCreationPreview();
    };
    canvas.on('after:render', redrawCreationPreviewAfterCanvasRender);

    function scenePointFromClient(clientX, clientY) {
      const rect = canvas.upperCanvasEl.getBoundingClientRect();
      const viewportPoint = new Point(clientX - rect.left, clientY - rect.top);
      const inverse = util.invertTransform(canvas.viewportTransform ?? [1, 0, 0, 1, 0, 0]);
      return util.transformPoint(viewportPoint, inverse);
    }

    function updateCreationDraftFromNativeEvent(nativeEvent) {
      if (!nativeEvent || !['line', 'shape'].includes(activeToolRef.current)) return false;
      const draft = shapeDraftRef.current ?? lineRef.current;
      if (!draft || draft.cancelled || draft.finalized || !creationDraftOwnsEvent(draft, nativeEvent)) {
        return false;
      }
      const clientX = Number(nativeEvent.clientX);
      const clientY = Number(nativeEvent.clientY);
      if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return false;
      const point = scenePointFromClient(clientX, clientY);
      lastPointerSceneRef.current = point;

      if (draft.kind === 'shape') {
        const dx = point.x - draft.start.x;
        const dy = point.y - draft.start.y;
        const drawnWidth = Math.max(2, Math.abs(dx));
        const drawnHeight = Math.max(2, Math.abs(dy));
        draft.object.set({
          left: draft.start.x + dx / 2,
          top: draft.start.y + dy / 2,
          scaleX: drawnWidth / draft.baseWidth,
          scaleY: drawnHeight / draft.baseHeight,
        });
        draft.object.dirty = true;
        draft.object.setCoords();
        sendLiveTransformThrottled(draft.object);
        scheduleCreationPreview();
        return true;
      }

      if (draft.kind === 'line') {
        if (liveDrawSendRef.current.sessionId === draft.sessionId
          && liveDrawSendRef.current.tool === 'line') {
          updateLiveDraw(point);
        }
        draft.object.set({ x2: point.x, y2: point.y });
        draft.object.setCoords();
        scheduleCreationPreview();
        return true;
      }
      return false;
    }

    function objectAtScenePoint(scenePoint, { strictImageBounds = false, predicate = null, candidates = null } = {}) {
      const tolerance = Math.max(7, 18 / Math.max(canvas.getZoom(), MIN_ZOOM));
      const entries = Array.isArray(candidates) ? candidates : [...canvas.getObjects()].reverse();
      for (const entry of entries) {
        const object = entry?.object ?? entry;
        if (!object || object.canvas !== canvas) continue;
        if (object.isEraserPath || objectEraserRecordsRef.current.has(object.boardObjectId)) continue;
        if (predicate && !predicate(object)) continue;
        const bounds = entry?.bounds ?? object.getBoundingRect();
        const insideExpandedBounds = scenePoint.x >= bounds.left - tolerance
          && scenePoint.x <= bounds.left + bounds.width + tolerance
          && scenePoint.y >= bounds.top - tolerance
          && scenePoint.y <= bounds.top + bounds.height + tolerance;
        if (!insideExpandedBounds) continue;
        try {
          if (typeof object.containsPoint === 'function') {
            const contains = object.containsPoint(scenePoint);
            if (contains) return object;
            if (strictImageBounds && isImageObject(object)) continue;
          }
        } catch {
          // Thin paths and grouped shapes are handled by their expanded bounding box.
        }
        return object;
      }
      return null;
    }

    function preciseEyedropperTarget(scenePoint, viewportPoint) {
      if (!scenePoint || !viewportPoint) return null;
      const zoomLevel = Math.max(canvas.getZoom(), MIN_ZOOM);
      const sceneTolerance = Math.max(1.5, 4 / zoomLevel);
      const candidates = [];
      const objects = canvas.getObjects();
      for (let index = objects.length - 1; index >= 0 && candidates.length < 8; index -= 1) {
        const object = objects[index];
        if (!object || object.canvas !== canvas || object.isEraserPath
          || object.transientPreview || object.transientSelectionProxy
          || objectEraserRecordsRef.current.has(object.boardObjectId)) continue;
        const bounds = object.getBoundingRect();
        if (scenePoint.x < bounds.left - sceneTolerance
          || scenePoint.x > bounds.left + bounds.width + sceneTolerance
          || scenePoint.y < bounds.top - sceneTolerance
          || scenePoint.y > bounds.top + bounds.height + sceneTolerance) continue;
        candidates.push(object);
      }

      const distanceToSegment = (point, start, end) => {
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const lengthSquared = dx * dx + dy * dy;
        if (lengthSquared <= 0.000001) return Math.hypot(point.x - start.x, point.y - start.y);
        const ratio = clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared, 0, 1);
        return Math.hypot(point.x - (start.x + dx * ratio), point.y - (start.y + dy * ratio));
      };

      const lineHit = (object) => {
        if (!(object instanceof Line) && object.type !== 'line') return false;
        try {
          const local = typeof object.calcLinePoints === 'function'
            ? object.calcLinePoints()
            : { x1: object.x1, y1: object.y1, x2: object.x2, y2: object.y2 };
          const matrix = object.calcTransformMatrix();
          const first = util.transformPoint(new Point(Number(local.x1), Number(local.y1)), matrix);
          const second = util.transformPoint(new Point(Number(local.x2), Number(local.y2)), matrix);
          const scale = Math.max(
            Math.hypot(Number(matrix[0] ?? 1), Number(matrix[1] ?? 0)),
            Math.hypot(Number(matrix[2] ?? 0), Number(matrix[3] ?? 1)),
            1,
          );
          const strokeRadius = Math.max(0.5, Number(object.strokeWidth ?? 1) * scale / 2);
          return distanceToSegment(scenePoint, first, second) <= strokeRadius + sceneTolerance;
        } catch {
          return false;
        }
      };

      // Lines get a cheap mathematical hit-test, including a small near-line tolerance.
      // Other objects use Fabric's pixel transparency check, but only for at most eight
      // nearby candidates rather than every object on the board.
      for (const object of candidates) {
        if (lineHit(object)) return object;
        try {
          if (typeof canvas.isTargetTransparent === 'function'
            && !canvas.isTargetTransparent(object, viewportPoint.x, viewportPoint.y)) {
            return object;
          }
          if (typeof canvas.isTargetTransparent !== 'function'
            && typeof object.containsPoint === 'function'
            && object.containsPoint(scenePoint)) {
            return object;
          }
        } catch {
          // Continue to the next nearby candidate.
        }
      }

      // Permit a very small miss around strokes/shapes without expanding image frames.
      const nearOffsets = [[2, 0], [-2, 0], [0, 2], [0, -2]];
      for (const object of candidates.slice(0, 4)) {
        if (isImageObject(object) || typeof canvas.isTargetTransparent !== 'function') continue;
        try {
          const closeEnough = nearOffsets.some(([dx, dy]) => (
            !canvas.isTargetTransparent(object, viewportPoint.x + dx, viewportPoint.y + dy)
          ));
          if (closeEnough) return object;
        } catch {
          // Ignore a failed pixel probe and report no target.
        }
      }
      return null;
    }

    function preciseObjectEraserTarget(scenePoint, viewportPoint, entries) {
      if (!scenePoint || !viewportPoint) return null;
      const zoomLevel = Math.max(canvas.getZoom(), MIN_ZOOM);
      // Object erasing is intentionally a little forgiving. The tolerance is expressed
      // in SCREEN pixels so a tiny/thin object is equally easy to hit at every zoom.
      const hitTolerancePx = 9;
      const sceneTolerance = hitTolerancePx / zoomLevel;
      const distanceToSegment = (point, start, end) => {
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const lengthSquared = dx * dx + dy * dy;
        if (lengthSquared <= 0.000001) return Math.hypot(point.x - start.x, point.y - start.y);
        const ratio = clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared, 0, 1);
        return Math.hypot(point.x - (start.x + dx * ratio), point.y - (start.y + dy * ratio));
      };

      for (const entry of Array.isArray(entries) ? entries : []) {
        const object = entry?.object ?? entry;
        if (!object || object.canvas !== canvas || object.isEraserPath
          || object.transientPreview || object.transientSelectionProxy
          || objectEraserRecordsRef.current.has(object.boardObjectId)) continue;
        const bounds = finiteRect(entry?.bounds ?? object.getBoundingRect());
        if (scenePoint.x < bounds.left - sceneTolerance
          || scenePoint.x > bounds.right + sceneTolerance
          || scenePoint.y < bounds.top - sceneTolerance
          || scenePoint.y > bounds.bottom + sceneTolerance) continue;

        // Straight lines are common and can be tested exactly without a bitmap probe.
        if (object instanceof Line || object.type === 'line') {
          try {
            const local = typeof object.calcLinePoints === 'function'
              ? object.calcLinePoints()
              : { x1: object.x1, y1: object.y1, x2: object.x2, y2: object.y2 };
            const matrix = object.calcTransformMatrix();
            const first = util.transformPoint(new Point(Number(local.x1), Number(local.y1)), matrix);
            const second = util.transformPoint(new Point(Number(local.x2), Number(local.y2)), matrix);
            const objectScale = Math.max(
              Math.hypot(Number(matrix[0] ?? 1), Number(matrix[1] ?? 0)),
              Math.hypot(Number(matrix[2] ?? 0), Number(matrix[3] ?? 1)),
              1,
            );
            const effectiveScale = object.strokeUniform ? 1 : objectScale;
            const strokeRadius = Math.max(0.5, Number(object.strokeWidth ?? 1) * effectiveScale / 2);
            if (distanceToSegment(scenePoint, first, second) <= strokeRadius + sceneTolerance) return object;
            continue;
          } catch {
            // Continue with the rendered-geometry probe below.
          }
        }

        // For paths, shapes, text, images and groups, probe only a small square around
        // the contact. This ignores empty bounding-box space but still accepts a tap a
        // few pixels beside very thin geometry. It also makes a zero-movement tap erase.
        const probeRect = {
          left: scenePoint.x - sceneTolerance,
          top: scenePoint.y - sceneTolerance,
          right: scenePoint.x + sceneTolerance,
          bottom: scenePoint.y + sceneTolerance,
        };
        if (renderedObjectIntersectsSceneRect(object, probeRect, { pixelsPerSceneUnit: zoomLevel })) {
          return object;
        }
      }
      return null;
    }

    function flushObjectEraserDeletePreview() {
      window.clearTimeout(objectEraserRealtimeTimerRef.current);
      objectEraserRealtimeTimerRef.current = null;
      const ids = [...objectEraserRealtimeDeleteIdsRef.current];
      objectEraserRealtimeDeleteIdsRef.current.clear();
      if (ids.length) realtimeRef.current?.sendDeletePreview?.(ids).catch?.(() => undefined);
    }

    function queueObjectEraserDeletePreview(id) {
      if (!id) return;
      objectEraserRealtimeDeleteIdsRef.current.add(String(id));
      if (!objectEraserRealtimeTimerRef.current) {
        objectEraserRealtimeTimerRef.current = window.setTimeout(
          flushObjectEraserDeletePreview,
          32,
        );
      }
    }

    function objectEraserCandidatesNear(scenePoint) {
      const zoomLevel = Math.max(canvas.getZoom(), MIN_ZOOM);
      const sceneTolerance = 12 / zoomLevel;
      const queryRect = finiteRect({
        left: scenePoint.x - sceneTolerance,
        top: scenePoint.y - sceneTolerance,
        width: sceneTolerance * 2,
        height: sceneTolerance * 2,
      });
      // The large-board Pencil compositor already maintains this index incrementally for
      // adds, deletes and transforms. Reusing it avoids the former full board scan and
      // getBoundingRect() call for every object at the start of each eraser gesture.
      return queryTransformSpatialObjects(queryRect)
        .reverse()
        .map((object) => {
          const entry = transformSpatialIndex.entries.get(object);
          return {
            object,
            bounds: entry?.bounds ?? finiteRect(object.getBoundingRect()),
            zIndex: Number(entry?.order ?? 0),
          };
        });
    }

    function eraseAtClientPoint(clientX, clientY) {
      const pointer = objectEraserPointerRef.current;
      if (pointer?.active && pointer.lastX != null
        && Math.hypot(clientX - pointer.lastX, clientY - pointer.lastY) < 3) return;
      if (pointer) {
        pointer.lastX = clientX;
        pointer.lastY = clientY;
      }
      const scenePoint = scenePointFromClient(clientX, clientY);
      const canvasRect = canvas.upperCanvasEl.getBoundingClientRect();
      const viewportPoint = new Point(clientX - canvasRect.left, clientY - canvasRect.top);
      const target = preciseObjectEraserTarget(
        scenePoint,
        viewportPoint,
        objectEraserCandidatesNear(scenePoint),
      );
      if (!target) return;
      const spatialEntry = transformSpatialIndex.entries.get(target);
      const targetBounds = finiteRect(spatialEntry?.bounds ?? target.getBoundingRect());
      const record = {
        object: serializeObject(target),
        zIndex: Number(spatialEntry?.order ?? 0),
      };
      const id = record?.object?.boardObjectId;
      if (!id || objectEraserRecordsRef.current.has(id)) return;
      objectEraserRecordsRef.current.set(id, record);
      queueObjectEraserDeletePreview(id);
      applyingRemoteRef.current = true;
      canvas.remove(target);
      applyingRemoteRef.current = false;
      const targetScreenRect = expandedRect(
        viewportRectFromSceneRect(targetBounds, canvas.viewportTransform),
        4,
      );
      objectEraserPendingPatchRects.push(targetScreenRect);
      if (!objectEraserRenderFrameRef.current) {
        objectEraserRenderFrameRef.current = window.requestAnimationFrame(() => {
          objectEraserRenderFrameRef.current = null;
          flushObjectEraserVisualPatches();
        });
      }
    }

    function finishObjectEraser() {
      if (!erasingRef.current) return;
      erasingRef.current = false;
      objectEraserPointerRef.current = null;
      if (objectEraserRenderFrameRef.current) {
        window.cancelAnimationFrame(objectEraserRenderFrameRef.current);
        objectEraserRenderFrameRef.current = null;
      }
      flushObjectEraserVisualPatches();
      restoreObjectEraserRenderMode();
      const records = [...objectEraserRecordsRef.current.values()];
      objectEraserRecordsRef.current = new Map();
      updateSelectionState();
      updateSelectionStyleState();
      if (!records.length) return;
      const ids = records.map((record) => record.object.boardObjectId).filter(Boolean);
      flushObjectEraserDeletePreview();
      sendDeletes(ids, { announce: false });
      recordAction({ type: 'delete', records });
      schedulePersistence();
    }

    canvas.on('path:created', ({ path }) => {
      const isPartialEraserPath = activeToolRef.current === 'eraser'
        && eraserModeRef.current === 'partial';
      const now = Date.now();
      const activePending = activePencilRef.current;
      const candidates = pendingPencilQueueRef.current.filter((pending) => (
        !pending.consumed && now - Number(pending.startedAt ?? 0) < 1800
      ));

      // Match the Fabric path to the stroke that started at the same scene point.
      // Pure FIFO/LIFO matching can attach a delayed path:created event to a different
      // rapid stroke, which gives the observer a valid but completely unrelated line.
      let pathStartPoint = null;
      try {
        const firstCommand = Array.isArray(path?.path)
          ? path.path.find((command) => Array.isArray(command) && command[0] === 'M')
          : null;
        if (firstCommand && Number.isFinite(Number(firstCommand[1])) && Number.isFinite(Number(firstCommand[2]))) {
          const localPoint = new Point(
            Number(firstCommand[1]) - Number(path.pathOffset?.x ?? 0),
            Number(firstCommand[2]) - Number(path.pathOffset?.y ?? 0),
          );
          pathStartPoint = util.transformPoint(localPoint, path.calcTransformMatrix());
        }
      } catch {
        pathStartPoint = null;
      }

      let pendingCandidate = null;
      if (pathStartPoint) {
        const tolerance = Math.max(14, 34 / Math.max(canvas.getZoom(), MIN_ZOOM));
        const ranked = candidates
          .map((pending) => ({
            pending,
            distance: pending.firstPoint
              ? Math.hypot(
                Number(pending.firstPoint.x) - pathStartPoint.x,
                Number(pending.firstPoint.y) - pathStartPoint.y,
              )
              : Number.POSITIVE_INFINITY,
          }))
          .sort((left, right) => left.distance - right.distance
            || Number(left.pending.startedAt ?? 0) - Number(right.pending.startedAt ?? 0));
        if (ranked[0]?.distance <= tolerance) pendingCandidate = ranked[0].pending;
      }

      if (!pendingCandidate) {
        const recentlyReleased = candidates
          .filter((pending) => pending.mouseReleased
            && now - Number(pending.releasedAt ?? 0) <= 750)
          .sort((left, right) => Number(left.releasedAt ?? 0) - Number(right.releasedAt ?? 0));
        pendingCandidate = recentlyReleased[0]
          ?? (activePending && !activePending.consumed ? activePending : null)
          ?? candidates[0]
          ?? null;
      }

      const pendingPencil = !isPartialEraserPath && pendingCandidate
        ? pendingCandidate
        : null;
      if (pendingPencil) {
        pendingPencil.consumed = true;
        const queueIndex = pendingPencilQueueRef.current.indexOf(pendingPencil);
        if (queueIndex >= 0) pendingPencilQueueRef.current.splice(queueIndex, 1);
        window.clearTimeout(pendingPencil.cancelTimer);
        path.boardObjectId = pendingPencil.objectId;
        path.creationSessionId = pendingPencil.sessionId;
        path.creationClientId = clientId;
        if (activePencilRef.current === pendingPencil) activePencilRef.current = null;
        if (pendingPencil.cancelled) {
          finishLiveDraw('cancel', pendingPencil.sessionId);
          removeRegisteredObjectsByCreationSession(clientId, pendingPencil.sessionId);
          applyingRemoteRef.current = true;
          canvas.remove(path);
          applyingRemoteRef.current = false;
          return;
        }
        finishLiveDraw('end', pendingPencil.sessionId);
        // The authoritative Fabric path owns the session. Remove every temporary or
        // interrupted sibling carrying the same session, even when a buggy browser
        // assigned it a different boardObjectId.
        removeRegisteredObjectsByCreationSession(clientId, pendingPencil.sessionId, path);
      }
      if (isPartialEraserPath) {
        path.set({
          globalCompositeOperation: 'destination-out',
          isEraserPath: true,
          selectable: false,
          evented: false,
          hasControls: false,
          hasBorders: false,
        });
        path.dirty = true;
        canvas.requestRenderAll();
      } else {
        path.set({
          selectable: canEditRef.current,
          evented: canEditRef.current,
          hasControls: canEditRef.current,
          hasBorders: canEditRef.current,
        });
        path.setCoords();
      }
      commitAddedObject(path);
    });

    canvas.on('before:transform', ({ transform, e: nativeEvent }) => {
      if (applyingRemoteRef.current || applyingHistoryRef.current || !transform?.target) return;
      const pointerType = nativeEvent?.pointerType
        ?? (selectionPenSessionRef.current.active || penInputRef.current.active ? 'pen' : 'unknown');
      transformGestureRef.current.pointerType = pointerType;
      if (transform.target.transientSelectionProxy) {
        modifiedBeforeRef.current = [];
        transformGestureRef.current.activeId = beginLiveTransform(transform.target);
        lastLockBroadcastRef.current = Date.now();
        const isolated = beginPenTransformIsolation(transform.target, transform, nativeEvent);
        if (pointerType === 'pen' && manuallyPaintedPencilSelectionTarget) {
          if (isolated) manuallyPaintedPencilSelectionTarget = null;
          else clearManualPencilSelectionFrame();
        }
        return;
      }
      modifiedBeforeRef.current = transformFramesForObjects(flattenTarget(transform.target), canvas);
      sendLocalLock(transform.target, true);
      transformGestureRef.current.activeId = beginLiveTransform(transform.target);
      lastLockBroadcastRef.current = Date.now();
      const isolated = beginPenTransformIsolation(transform.target, transform, nativeEvent);
      if (pointerType === 'pen' && manuallyPaintedPencilSelectionTarget) {
        if (isolated) manuallyPaintedPencilSelectionTarget = null;
        else clearManualPencilSelectionFrame();
      }
    });

    const broadcastLiveTransform = ({ target, e: nativeEvent, transform }) => {
      if (!target || applyingRemoteRef.current || applyingHistoryRef.current) return;
      // Fabric's custom hand control does not consistently emit object:moving in
      // Safari. Start/update the same Pencil compositor directly from its action tick.
      if (!penTransformIsolationRef.current
        && (nativeEvent?.pointerType === 'pen' || selectionPenSessionRef.current.active)) {
        beginPenTransformIsolation(target, transform, nativeEvent);
      }
      updatePenTransformIsolation(target);
      sendLiveTransformThrottled(target);
      if (Date.now() - lastLockBroadcastRef.current < 1200) return;
      lastLockBroadcastRef.current = Date.now();
      sendLocalLock(target, true);
    };
    canvas.__alexSelectionMoveTick = broadcastLiveTransform;
    canvas.on('object:moving', broadcastLiveTransform);
    canvas.on('object:drag', broadcastLiveTransform);
    canvas.on('object:scaling', broadcastLiveTransform);
    canvas.on('object:rotating', broadcastLiveTransform);
    canvas.on('object:skewing', broadcastLiveTransform);

    canvas.on('object:modified', ({ target }) => {
      if (applyingRemoteRef.current || applyingHistoryRef.current || !target) return;
      const spatialIndexAlreadyUpdated = finishPenTransformIsolation({ composite: true, scheduleReconcile: true });
      if (target.transientSelectionProxy) {
        endLiveTransform(target);
        target.previewReceivedAt = Date.now();
        target.setCoords();
        modifiedBeforeRef.current = [];
        transformGestureRef.current.activeId = null;
        transformGestureRef.current.pointerType = null;
        canvas.requestRenderAll();
        return;
      }

      const groupSelection = isActiveSelectionObject(target);
      const selectedObjects = flattenTarget(target).filter(Boolean);
      selectedObjects.forEach((object) => {
        if (!object.boardObjectId) object.boardObjectId = randomToken(10);
        registerCanvasObject(object);
      });
      // Keep the lightweight spatial index correct after every transform, including
      // small boards where the cropped Pencil compositor is intentionally not used.
      // Without this update, the second Pencil drag looked up the object's old bounds,
      // treated the new contact as empty space and enabled the top-only render guard,
      // which made the object move invisibly until pointerup (the "teleport" bug).
      // Large-board isolated drags already updated these same entries while compositing.
      if (!spatialIndexAlreadyUpdated) updateTransformSpatialObjects(selectedObjects);
      const beforeTransforms = modifiedBeforeRef.current;
      const zIndexMap = liveTransformSendRef.current.zIndexMap;
      const gestureId = transformGestureRef.current.activeId;
      let afterTransforms = [];
      let recordInputs = [];
      let transformCaptureFailed = false;
      try {
        afterTransforms = transformFramesForObjects(selectedObjects, canvas, zIndexMap);
        recordInputs = captureTransformRecordInputs(selectedObjects, zIndexMap);
      } catch (error) {
        // A persistence-patch failure must never leave Fabric's transform session,
        // collaboration lock or Pencil selection capture alive. Version 1.29 passed a
        // null z-index map into captureTransformRecordInputs and threw here after every
        // move, which made the selection impossible to clear until reload.
        transformCaptureFailed = true;
        console.error('Не удалось собрать лёгкую transform-операцию', error);
      } finally {
        modifiedBeforeRef.current = [];
        endLiveTransform(target);
      }

      if (transformCaptureFailed) {
        transformGestureRef.current.activeId = null;
        transformGestureRef.current.pointerType = null;
        pendingGroupTransformCommitRef.current = null;
        sendLocalLock(selectedObjects, false);
        canvas.requestRenderAll();
        return;
      }

      const commitSignature = afterTransforms
        .map((frame) => `${frame.id}:${frame.matrix.join(',')}`)
        .sort()
        .join('|');
      const commitNow = performance.now();
      const duplicateGesture = Boolean(gestureId)
        && transformGestureRef.current.lastCommittedId === gestureId;
      // Safari may expose the same physical Pencil release once as pen and once as a
      // compatibility mouse release. Always deduplicate the final matrix, even when the
      // second route opened a fresh Fabric gesture id.
      const duplicateSignature = Boolean(commitSignature)
        && transformGestureRef.current.signature === commitSignature
        && commitNow - Number(transformGestureRef.current.committedAt ?? 0) < 1800;
      if (duplicateGesture || duplicateSignature) {
        transformGestureRef.current.activeId = null;
        transformGestureRef.current.pointerType = null;
        sendLocalLock(selectedObjects, false);
        return;
      }
      transformGestureRef.current.lastCommittedId = gestureId;
      transformGestureRef.current.signature = commitSignature;
      transformGestureRef.current.committedAt = commitNow;
      transformGestureRef.current.activeId = null;
      transformGestureRef.current.pointerType = null;

      const commitObjects = () => {
        // Fabric has already rendered the final transform. Release collaboration locks
        // and record Undo immediately; persistence must not hold the pointer-up frame.
        sendLocalLock(selectedObjects, false);
        if (beforeTransforms.length && afterTransforms.length) {
          recordAction({ type: 'transform', before: beforeTransforms, after: afterTransforms });
        }

        // Every input device uses the same lightweight durable transform. Apple
        // Pencil no longer has a special delayed full-upsert path, and mouse/touch no
        // longer serialize the whole object either.
        queueDeferredTransformPersistence(recordInputs);
      };

      if (!groupSelection) {
        commitObjects();
        return;
      }

      // Let Fabric finish dismantling its internal transform state first. The next frame
      // only queues the lightweight persistence patch; it no longer re-runs setCoords on
      // every member or serializes every selected path.
      const commitToken = {};
      pendingGroupTransformCommitRef.current = commitToken;
      window.requestAnimationFrame(() => {
        if (pendingGroupTransformCommitRef.current !== commitToken) return;
        pendingGroupTransformCommitRef.current = null;
        if (fabricCanvasRef.current !== canvas) return;
        commitObjects();
      });
    });

    const refreshSelectionUi = () => {
      const active = canvas.getActiveObject();
      selectionUiTouchedRef.current = new Set([active].filter(Boolean));
      // The selected members are already interactive board objects. Re-applying flags to
      // every member during selection:cleared made deselect O(group size) and duplicated
      // Fabric's own ActiveSelection dismantling. Only the active wrapper/object needs UI.
      applyObjectInteractivityToObjects([active].filter(Boolean), { render: false });
      updateSelectionVisuals();
      updateSelectionState();
      window.clearTimeout(selectionStyleRefreshTimerRef.current);
      selectionStyleRefreshTimerRef.current = window.setTimeout(() => {
        selectionStyleRefreshTimerRef.current = null;
        if (fabricCanvasRef.current === canvas) updateSelectionStyleState();
      }, 0);
    };
    const queueSelectionUiRefresh = () => {
      if (selectionUiRefreshFrameRef.current != null) return;
      selectionUiRefreshFrameRef.current = window.requestAnimationFrame(() => {
        selectionUiRefreshFrameRef.current = null;
        if (fabricCanvasRef.current === canvas) refreshSelectionUi();
      });
    };
    let manuallyPaintedPencilSelectionTarget = null;
    const clearManualPencilSelectionFrame = () => {
      if (!manuallyPaintedPencilSelectionTarget) return;
      manuallyPaintedPencilSelectionTarget = null;
      const contextTop = canvas.contextTop;
      if (!contextTop) return;
      try {
        canvas.clearContext?.(contextTop);
        canvas.contextTopDirty = false;
      } catch { /* Ignore a disposed top layer. */ }
    };
    const startTransactionalSelection = () => {
      // Selection UI is cosmetic. Run it after Fabric has completed the current pointer
      // event so clearing a large ActiveSelection cannot block the Pencil contact itself.
      manuallyPaintedPencilSelectionTarget = null;
      queueSelectionUiRefresh();
    };
    const startFreshPencilSingleSelection = () => {
      // A fresh single-object Pencil selection is created during the same native
      // pointerdown that can immediately become a drag. On busy boards the Pencil
      // transform compositor cancels Fabric's pending full render in before:transform,
      // so the first selection frame could be postponed until pointerup. Draw only the
      // controls on the top canvas synchronously before that cancellation can happen.
      // Touch, mouse, selection:updated and group paths stay exactly on 1.31.2.
      const active = canvas.getActiveObject();
      if (selectionPenSessionRef.current.active
        && active
        && !isActiveSelectionObject(active)) {
        active.hasControls = canEditRef.current;
        active.hasBorders = canEditRef.current;
        try { active.setCoords?.(); } catch { /* Ignore a disposed target. */ }
        const contextTop = canvas.contextTop;
        if (contextTop && typeof active._renderControls === 'function') {
          try {
            canvas.clearContext?.(contextTop);
            active._renderControls(contextTop);
            manuallyPaintedPencilSelectionTarget = active;
            // This frame was painted outside Fabric's normal render cycle. Mark the
            // upper context dirty so the next regular render can always clear it.
            canvas.contextTopDirty = true;
          } catch {
            try { canvas.renderTop?.(); } catch { /* Ignore a disposed top layer. */ }
          }
        } else {
          try { canvas.renderTop?.(); } catch { /* Ignore a disposed top layer. */ }
        }
      }
      queueSelectionUiRefresh();
    };
    const finishTransactionalSelection = () => {
      manuallyPaintedPencilSelectionTarget = null;
      queueSelectionUiRefresh();
    };

    const handleRegistryObjectAdded = ({ target }) => {
      registerCanvasObject(target);
      penTransformSpatialApiRef.current?.addObject?.(target);
    };
    const handleRegistryObjectRemoved = ({ target }) => {
      unregisterCanvasObject(target);
      penTransformSpatialApiRef.current?.removeObject?.(target);
    };
    canvas.on('object:added', handleRegistryObjectAdded);
    canvas.on('object:removed', handleRegistryObjectRemoved);

    canvas.on('selection:created', startFreshPencilSingleSelection);
    canvas.on('selection:updated', startTransactionalSelection);
    canvas.on('selection:cleared', finishTransactionalSelection);

    canvas.on('text:editing:entered', ({ target }) => {
      if (!target?.boardObjectId) return;
      textBeforeRef.current.set(target.boardObjectId, getObjectRecords([target]));
      sendLocalLock(target, true);
      // New text objects use a visible placeholder. The first time the user enters
      // editing, remove it so typing can begin immediately without manual deletion.
      clearTextPlaceholderForEditing(target, canvas);
    });

    canvas.on('text:changed', ({ target }) => {
      if (!target || applyingRemoteRef.current || applyingHistoryRef.current) return;
      window.clearTimeout(textChangeTimerRef.current);
      textChangeTimerRef.current = window.setTimeout(() => {
        markObject(target, clientId);
        const [record] = getObjectRecords([target]);
        if (record) realtimeRef.current?.sendObjectLive?.(record);
      }, 120);
    });

    canvas.on('text:editing:exited', ({ target }) => {
      if (!target || applyingRemoteRef.current || applyingHistoryRef.current) return;
      if (String(mobileTextEditorRef.current?.objectId ?? '') === String(target.boardObjectId ?? '')) {
        mobileTextEditorRef.current = null;
        setMobileTextEditor(null);
      }
      if (target.hiddenTextarea) {
        target.hiddenTextarea.readOnly = false;
        target.hiddenTextarea.inputMode = 'text';
        target.hiddenTextarea.setAttribute?.('inputmode', 'text');
        if ('virtualKeyboardPolicy' in target.hiddenTextarea) target.hiddenTextarea.virtualKeyboardPolicy = 'auto';
      }
      window.clearTimeout(textChangeTimerRef.current);
      const before = textBeforeRef.current.get(target.boardObjectId) ?? [];
      textBeforeRef.current.delete(target.boardObjectId);
      const objectId = String(target.boardObjectId ?? '');
      const newTextDraft = newTextDraftIdsRef.current.delete(objectId);
      const emptyText = String(target.text ?? '').trim().length === 0;
      let emptyTextComposedDelete = false;

      if (emptyText) {
        const records = getObjectRecords([target]);
        applyingRemoteRef.current = true;
        emptyTextComposedDelete = Boolean(
          localDeletionCompositorRef.current?.removeObjects?.([target]),
        );
        if (!emptyTextComposedDelete) canvas.remove(target);
        applyingRemoteRef.current = false;
        if (objectId) sendDeletes([objectId]);
        const latestAction = undoStackRef.current.at(-1);
        const latestAddedId = String(latestAction?.records?.[0]?.object?.boardObjectId ?? '');
        if (newTextDraft && latestAction?.type === 'add'
          && latestAction.records?.length === 1 && latestAddedId === objectId) {
          undoStackRef.current.pop();
          updateHistoryButtons();
        } else if (records.length) {
          recordAction({ type: 'delete', records });
        }
      } else {
        markObject(target, clientId);
        const after = getObjectRecords([target]);
        sendRecordPatches(before, after);
        const latestAction = undoStackRef.current.at(-1);
        const latestAddedId = String(latestAction?.records?.[0]?.object?.boardObjectId ?? '');
        if (newTextDraft && latestAction?.type === 'add'
          && latestAction.records?.length === 1 && latestAddedId === objectId) {
          latestAction.records = after;
          updateHistoryButtons();
        } else if (before.length && after.length) {
          recordAction({ type: 'modify', before, after });
        }
      }

      sendLocalLock(target, false);
      selectedShapeRef.current = null;
      activeToolRef.current = 'select';
      setToolState('select');
      configureBrushAndMode();
      canvas.discardActiveObject();
      updateSelectionState();
      updateSelectionStyleState();
      if (!emptyTextComposedDelete) canvas.requestRenderAll();
      schedulePersistence();
      setSaveStatus(emptyText ? 'Пустой текст удалён' : 'Текст сохранён');
    });

    function restoreEyedropperSelection(mode, transactionId, preservedSelectionIds) {
      if (mode !== 'selection') return;
      const transaction = transactionId
        ? localSelectionTransactionRef.current
        : null;
      if (transaction?.transactionId === transactionId
        && transaction.proxy
        && canvas.getObjects().includes(transaction.proxy)) {
        canvas.setActiveObject(transaction.proxy);
        updateSelectionState();
        updateSelectionStyleState();
        return;
      }
      const idSet = new Set((preservedSelectionIds ?? []).map(String));
      const selectionObjects = canvas.getObjects().filter((object) => (
        object.boardObjectId
        && idSet.has(String(object.boardObjectId))
        && !object.isEraserPath
      ));
      if (selectionObjects.length === 1) canvas.setActiveObject(selectionObjects[0]);
      else if (selectionObjects.length > 1) {
        canvas.setActiveObject(createOuterOnlyActiveSelection(selectionObjects, canvas));
      }
      updateSelectionState();
      updateSelectionStyleState();
    }

    function prepareEyedropperSample(scenePoint, viewportPoint) {
      const mode = eyedropperModeRef.current;
      const transactionId = eyedropperSelectionTransactionIdRef.current;
      const preservedSelectionIds = [...eyedropperSelectionIdsRef.current];
      if (mode === 'drawing' && canvas.getActiveObject()) canvas.discardActiveObject();

      // Do every potentially expensive hit/pixel read once on pointerdown. Pointerup
      // then only copies already prepared values and restores the input mode.
      const target = preciseEyedropperTarget(scenePoint, viewportPoint);
      const sourceIsImage = Boolean(target && isImageObject(target));
      const pixelColor = sourceIsImage ? sampleImagePixelColor(target, scenePoint) : null;
      const sampled = !target
        ? null
        : (sourceIsImage
          ? {
            canColor: Boolean(pixelColor),
            color: pixelColor,
            canOpacity: false,
            opacity: null,
            canWidth: false,
            width: null,
          }
          : probeObjectStyle(target));

      let committed = false;
      return {
        commit({ cancelled = false, watchdog = false } = {}) {
          if (committed) return false;
          committed = true;

          if (cancelled) {
            restoreEyedropperSelection(mode, transactionId, preservedSelectionIds);
            applyCanvasInputMode();
            canvas.requestRenderAll();
            if (watchdog) setSaveStatus('Пипетка: контакт Pencil сброшен — попробуйте ещё раз');
            return false;
          }

          if (!target) {
            restoreEyedropperSelection(mode, transactionId, preservedSelectionIds);
            applyCanvasInputMode();
            canvas.requestRenderAll();
            setSaveStatus('Пипетка: нажмите точно на видимую часть объекта');
            return false;
          }

          let success = false;
          let selectionObjects = [];
          if (mode === 'drawing' && ['pencil', 'line', 'shape'].includes(activeToolRef.current)) {
            if (sampled?.canColor && sampled.color) {
              colorRef.current = sampled.color;
              setColorState(sampled.color);
              success = true;
            }
            if (!sourceIsImage && sampled?.canOpacity && Number.isFinite(sampled.opacity)) {
              const nextOpacity = clamp(sampled.opacity, 0.05, 1);
              opacityRef.current = nextOpacity;
              setOpacityState(nextOpacity);
              success = true;
            }
            if (!sourceIsImage && sampled?.canWidth && Number.isFinite(sampled.width)) {
              const nextWidth = clamp(Math.round(sampled.width), 1, 100);
              widthRef.current = nextWidth;
              setWidthState(nextWidth);
              success = true;
            }
            if (success && DRAWING_STYLE_TOOL_IDS.has(activeToolRef.current)) {
              drawingStylesRef.current[activeToolRef.current] = {
                color: colorRef.current,
                opacity: opacityRef.current,
                width: widthRef.current,
              };
            }
          }

          if (mode === 'selection' && sampled) {
            selectionObjects = transactionId
              ? applyEyedropperToSelectionTransaction(
                transactionId,
                sampled,
                { colorOnly: sourceIsImage },
              )
              : applyEyedropperToSelectionIds(
                preservedSelectionIds,
                sampled,
                { colorOnly: sourceIsImage },
              );
            success = selectionObjects.length > 0;
          }

          restoreEyedropperSelection(mode, transactionId, preservedSelectionIds);
          if (!success) {
            applyCanvasInputMode();
            canvas.requestRenderAll();
            if (sourceIsImage && !pixelColor) {
              setSaveStatus('Пипетка: не удалось определить цвет пикселя картинки');
            } else {
              setSaveStatus('Пипетка: у объекта нет подходящих параметров');
            }
            return false;
          }

          // Refs and Fabric are switched synchronously before React paints. The next
          // physical Pencil pointerdown therefore sees a ready drawing brush immediately.
          eyedropperActiveRef.current = false;
          eyedropperModeRef.current = null;
          eyedropperSelectionIdsRef.current = [];
          eyedropperSelectionTransactionIdRef.current = null;
          setEyedropperActive(false);
          applyCanvasInputMode();
          canvas.requestRenderAll();
          setSaveStatus(sourceIsImage
            ? 'Цвет пикселя применён'
            : (mode === 'selection' ? 'Цвет, толщина и прозрачность применены' : 'Параметры скопированы'));
          return true;
        },
      };
    }

    function consumeEyedropperPointerEvent(event) {
      if (event?.cancelable) event.preventDefault();
      event?.stopPropagation?.();
      event?.stopImmediatePropagation?.();
    }

    function releaseEyedropperPointerCapture(pointerId) {
      if (pointerId == null) return;
      try {
        if (touchTarget.hasPointerCapture?.(pointerId)) touchTarget.releasePointerCapture(pointerId);
      } catch {
        // WebKit may release capture automatically before pointercancel.
      }
    }

    function beginEyedropperPenContact(event) {
      if (event.pointerType !== 'pen' || !eyedropperActiveRef.current) return false;
      const existing = eyedropperPenContactRef.current;
      if (existing) {
        consumeEyedropperPointerEvent(event);
        return true;
      }

      const scenePoint = canvas.getScenePoint(event);
      const viewportPoint = canvas.getViewportPoint(event);
      const prepared = prepareEyedropperSample(scenePoint, viewportPoint);
      clearPendingNativeCreationPointer(event);
      rejectedPointerIdsRef.current.delete(event.pointerId);
      penInputRef.current = {
        pointerId: event.pointerId,
        active: true,
        lastSeenAt: Date.now(),
        lastClientX: Number(event.clientX ?? 0),
        lastClientY: Number(event.clientY ?? 0),
        suppressUntil: 0,
      };

      eyedropperCompatibilityGuardUntilRef.current = performance.now() + 2500;
      const session = {
        pointerId: event.pointerId,
        prepared,
        watchdog: null,
      };
      eyedropperPenContactRef.current = session;
      try { touchTarget.setPointerCapture?.(event.pointerId); } catch { /* Optional on WebKit. */ }

      // This never participates in normal timing. It only guarantees that a missing
      // pointerup/pointercancel cannot leave the board blocked forever.
      session.watchdog = window.setTimeout(() => {
        if (eyedropperPenContactRef.current !== session) return;
        eyedropperPenContactRef.current = null;
        releaseEyedropperPointerCapture(session.pointerId);
        if (penInputRef.current.pointerId === session.pointerId) {
          penInputRef.current.active = false;
          penInputRef.current.pointerId = null;
          penInputRef.current.suppressUntil = 0;
        }
        eyedropperCompatibilityGuardUntilRef.current = performance.now() + 220;
        prepared.commit({ cancelled: true, watchdog: true });
      }, 1200);

      consumeEyedropperPointerEvent(event);
      return true;
    }

    function finishEyedropperPenContact(event) {
      const session = eyedropperPenContactRef.current;
      if (event.pointerType !== 'pen' || !session || session.pointerId !== event.pointerId) return false;
      consumeEyedropperPointerEvent(event);
      clearPendingNativeCreationPointer(event);
      eyedropperPenContactRef.current = null;
      window.clearTimeout(session.watchdog);
      releaseEyedropperPointerCapture(session.pointerId);
      rejectedPointerIdsRef.current.delete(event.pointerId);

      const now = Date.now();
      if (penInputRef.current.pointerId === event.pointerId) {
        penInputRef.current.active = false;
        penInputRef.current.pointerId = null;
        penInputRef.current.lastSeenAt = now;
        penInputRef.current.lastClientX = Number(event.clientX ?? penInputRef.current.lastClientX ?? 0);
        penInputRef.current.lastClientY = Number(event.clientY ?? penInputRef.current.lastClientY ?? 0);
        penInputRef.current.suppressUntil = 0;
      }

      eyedropperCompatibilityGuardUntilRef.current = performance.now() + 220;
      session.prepared.commit({ cancelled: event.type === 'pointercancel' });
      return true;
    }

    function hideSelectionMarquee() {
      if (selectionMoveFrameRef.current != null) {
        window.cancelAnimationFrame(selectionMoveFrameRef.current);
        selectionMoveFrameRef.current = null;
      }
      const element = selectionMarqueeElementRef.current;
      if (!element) return;
      element.style.display = 'none';
      element.style.width = '0px';
      element.style.height = '0px';
    }

    function paintSelectionMarquee() {
      selectionMoveFrameRef.current = null;
      const drag = selectionDragRef.current;
      const element = selectionMarqueeElementRef.current;
      if (!drag || !element || !canvas.viewportTransform) return;
      const rect = normalizedSceneRect(drag.start, drag.end);
      const first = util.transformPoint(new Point(rect.left, rect.top), canvas.viewportTransform);
      const second = util.transformPoint(new Point(rect.right, rect.bottom), canvas.viewportTransform);
      const left = Math.min(first.x, second.x);
      const top = Math.min(first.y, second.y);
      const width = Math.abs(second.x - first.x);
      const height = Math.abs(second.y - first.y);
      element.style.display = 'block';
      element.style.transform = `translate3d(${left}px, ${top}px, 0)`;
      element.style.width = `${width}px`;
      element.style.height = `${height}px`;
    }

    function scheduleSelectionMarqueePaint() {
      if (selectionMoveFrameRef.current != null) return;
      selectionMoveFrameRef.current = window.requestAnimationFrame(paintSelectionMarquee);
    }

    function selectionDragOwnsEvent(drag, nativeEvent) {
      if (!drag) return false;
      if (drag.pointerId == null || nativeEvent?.pointerId == null) return true;
      return drag.pointerId === nativeEvent.pointerId;
    }

    function finalizeSelectionMarquee(nativeEvent, { cancelled = false } = {}) {
      const currentSelectionDrag = selectionDragRef.current;
      const selectionDrag = currentSelectionDrag
        && selectionDragOwnsEvent(currentSelectionDrag, nativeEvent)
        ? currentSelectionDrag
        : null;
      if (!selectionDrag) return false;

      // The native Pencil pointerup reaches capture phase before Fabric's mouse:up.
      // Record that final coordinate here so the marquee can finish even when Safari
      // later exposes only a compatibility mouseup which our deduplication suppresses.
      if (!cancelled && nativeEvent) {
        try {
          const finalPoint = canvas.getScenePoint(nativeEvent);
          if (Number.isFinite(finalPoint?.x) && Number.isFinite(finalPoint?.y)) {
            selectionDrag.end = new Point(finalPoint.x, finalPoint.y);
          }
        } catch {
          // Keep the last pointermove coordinate when WebKit cannot map the release event.
        }
      }

      selectionDragRef.current = null;
      hideSelectionMarquee();
      if (cancelled || activeToolRef.current !== 'select') return true;

      const selectionRect = normalizedSceneRect(selectionDrag.start, selectionDrag.end);
      if (selectionRect.width < 3 && selectionRect.height < 3) return true;

      window.requestAnimationFrame(() => {
        if (fabricCanvasRef.current !== canvas || activeToolRef.current !== 'select') return;
        canvas.discardActiveObject();
        const now = Date.now();
        const selected = canvas.getObjects().filter((object) => {
          if (object.isEraserPath || object.transientPreview || object.transientSelectionProxy || !object.selectable) return false;
          const lock = object.boardObjectId ? remoteLocksRef.current.get(object.boardObjectId) : null;
          if (lock && Number(lock.expiresAt ?? 0) > now) return false;
          return objectFastIntersectsRect(object, selectionRect);
        });
        if (selected.length === 1) canvas.setActiveObject(selected[0]);
        else if (selected.length > 1) canvas.setActiveObject(createOuterOnlyActiveSelection(selected, canvas));
        else {
          updateSelectionState();
          updateSelectionStyleState();
        }
        canvas.requestRenderAll();
      });
      return true;
    }

    canvas.on('mouse:down', (event) => {
      const nativeEvent = event.e;
      const pointerId = nativeEvent?.pointerId;
      if (activeToolRef.current === 'select'
        && shouldSuppressSelectionCompatibilityEvent(nativeEvent)) {
        nativeEvent?.preventDefault?.();
        nativeEvent?.stopPropagation?.();
        return;
      }
      if (performance.now() < eyedropperCompatibilityGuardUntilRef.current
        && nativeEvent?.pointerType !== 'pen') {
        nativeEvent?.preventDefault?.();
        nativeEvent?.stopPropagation?.();
        return;
      }
      if (pointerId != null && rejectedPointerIdsRef.current.has(pointerId)) return;
      if (activeToolRef.current === 'pencil') {
        const activeStroke = activePencilRef.current;
        if (activeStroke && !activeStroke.mouseReleased) {
          // One physical pointer owns one stroke from start to finish. A palm or a
          // second finger cannot open another Fabric path while that stroke is active.
          if (pointerId == null || activeStroke.pointerId !== pointerId) {
            nativeEvent.preventDefault?.();
            nativeEvent.stopPropagation?.();
            nativeEvent.stopImmediatePropagation?.();
            return;
          }
          // Safari can occasionally repeat mouse:down for the same Pencil pointer.
          nativeEvent.preventDefault?.();
          return;
        }
      }
      const scenePoint = event.scenePoint ?? canvas.getScenePoint(nativeEvent);
      lastPointerSceneRef.current = scenePoint;
      if (toolbarPasteAwaitingPointRef.current) {
        toolbarPastePointRef.current = new Point(scenePoint.x, scenePoint.y);
        toolbarPasteAwaitingPointRef.current = false;
        setSaveStatus('Точка вставки выбрана — нажмите «Вставить»');
      }

      const editingText = canvas.getActiveObject();
      if (activeToolRef.current === 'text'
        && editingText instanceof IText
        && editingText.isEditing
        && event.target !== editingText) {
        nativeEvent.preventDefault?.();
        nativeEvent.stopPropagation?.();
        editingText.exitEditing?.();
        return;
      }
      if (nativeEvent.button === 1 || nativeEvent.button === 2 || spacePressedRef.current) {
        nativeEvent.preventDefault?.();
        panningRef.current = true;
        lastPanRef.current = event.viewportPoint ?? canvas.getViewportPoint(nativeEvent);
        canvas.isDrawingMode = false;
        canvas.selection = false;
        canvas.defaultCursor = 'grabbing';
        return;
      }
      if (!canEditRef.current) return;

      textTapCandidateRef.current = null;
      if (activeToolRef.current === 'select' && isTextObject(event.target)) {
        textTapCandidateRef.current = {
          target: event.target,
          pointerId,
          startX: Number(nativeEvent?.clientX ?? 0),
          startY: Number(nativeEvent?.clientY ?? 0),
          moved: false,
        };
      }

      if (mobilePasteAwaitingPointRef.current && (nativeEvent.pointerType === 'touch' || nativeEvent.pointerType === 'pen' || (Number(navigator.maxTouchPoints ?? 0) > 0 && nativeEvent.button == null))) {
        nativeEvent.preventDefault?.();
        nativeEvent.stopPropagation?.();
        toolbarPastePointRef.current = new Point(scenePoint.x, scenePoint.y);
        toolbarPasteAwaitingPointRef.current = false;
        mobilePasteAwaitingPointRef.current = false;
        canvas.discardActiveObject();
        updateSelectionVisuals();
        updateSelectionState();
        updateSelectionStyleState();
        canvas.requestRenderAll();
        setSaveStatus('Точка вставки выбрана — нажмите «Вставить»');
        return;
      }

      if (eyedropperActiveRef.current) {
        nativeEvent.preventDefault?.();
        nativeEvent.stopPropagation?.();
        nativeEvent.stopImmediatePropagation?.();
        // Pencil contacts are normally consumed earlier by the native capture route,
        // before Fabric can open a drawing/mouse session. This fallback only protects
        // browsers that expose a pen-like Fabric event without the capture event.
        if (nativeEvent?.pointerType === 'pen' && pointerId != null) {
          beginEyedropperPenContact(nativeEvent);
          return;
        }
        const point = event.scenePoint ?? canvas.getScenePoint(nativeEvent);
        const viewportPoint = event.viewportPoint ?? canvas.getViewportPoint(nativeEvent);
        prepareEyedropperSample(point, viewportPoint).commit();
        return;
      }

      const primarySelectionPointer = nativeEvent.button == null
        || nativeEvent.button === 0
        || nativeEvent.pointerType === 'touch'
        || nativeEvent.pointerType === 'pen';

      const activeCreationDraft = shapeDraftRef.current ?? lineRef.current;
      if (activeCreationDraft && ['shape', 'line'].includes(activeToolRef.current)) {
        if (creationDraftOwnsEvent(activeCreationDraft, nativeEvent)) nativeEvent.preventDefault?.();
        return;
      }

      if (activeToolRef.current === 'shape' && selectedShapeRef.current && primarySelectionPointer) {
        nativeEvent.preventDefault?.();
        const point = scenePoint;
        const object = createShape(selectedShapeRef.current, {
          stroke: hexToRgba(colorRef.current, opacityRef.current),
          strokeWidth: widthRef.current,
        });
        if (!object) return;
        markObject(object, clientId);
        const baseWidth = Math.max(1, Number(object.width ?? 1));
        const baseHeight = Math.max(1, Number(object.height ?? 1));
        object.set({
          left: point.x,
          top: point.y,
          originX: 'center',
          originY: 'center',
          scaleX: 0.01,
          scaleY: 0.01,
          selectable: false,
          evented: false,
          hasControls: false,
          hasBorders: false,
        });
        object.setCoords();
        canvas.discardActiveObject();
        prepareCreationPreviewObject(object);
        const creationPointer = creationPointerForDraft(nativeEvent);
        const shapeDraft = {
          kind: 'shape',
          object,
          start: new Point(point.x, point.y),
          baseWidth,
          baseHeight,
          pointerKey: creationPointer.key,
          pointerId: creationPointer.pointerId,
          pointerType: creationPointer.pointerType,
          startedAt: Date.now(),
          sessionId: null,
          cancelled: false,
          finalized: false,
        };
        shapeDraftRef.current = shapeDraft;
        realtimeRef.current?.sendPreview?.([{
          object: serializeObject(object),
          zIndex: Number(object.creationDraftZIndex ?? canvas.getObjects().length),
        }]);
        shapeDraft.sessionId = beginLiveTransform(object);
        scheduleCreationPreview();
        return;
      }

      if (activeToolRef.current === 'select' && !event.target && primarySelectionPointer) {
        if (canvas.getActiveObject()) {
          // discardActiveObject already emits selection:cleared. The coalesced selection
          // listener updates controls/state once on the next frame; doing it again here
          // caused the second freeze when tapping empty space with Apple Pencil.
          canvas.discardActiveObject();
        }
        const point = event.scenePoint ?? canvas.getScenePoint(nativeEvent);
        selectionDragRef.current = {
          start: new Point(point.x, point.y),
          end: new Point(point.x, point.y),
          pointerId,
          pointerType: nativeEvent?.pointerType ?? 'unknown',
        };
        if (selectionBoxRef.current) {
          canvas.remove(selectionBoxRef.current);
          selectionBoxRef.current = null;
        }
        scheduleSelectionMarqueePaint();
      }

      if (activeToolRef.current === 'pencil') {
        const point = scenePoint;
        const now = Date.now();
        // A stroke that produced no Fabric path must never remain at the front of a
        // FIFO queue and steal the id of the next stroke.
        pendingPencilQueueRef.current = pendingPencilQueueRef.current.filter((pending) => {
          const stale = pending.consumed
            || now - Number(pending.startedAt ?? 0) > 1800
            || (pending.mouseReleased && now - Number(pending.releasedAt ?? now) > 750);
          if (stale) window.clearTimeout(pending.cancelTimer);
          return !stale;
        });
        if (activePencilRef.current?.mouseReleased) activePencilRef.current = null;
        const objectId = randomToken(10);
        const sessionId = beginLiveDraw('pencil', objectId, point, {
          stroke: hexToRgba(colorRef.current, opacityRef.current),
          width: widthRef.current,
        });
        const pendingPencil = {
          objectId,
          sessionId,
          pointerId,
          pointerType: nativeEvent?.pointerType ?? 'unknown',
          cancelTimer: null,
          startedAt: Date.now(),
          mouseReleased: false,
          releasedAt: 0,
          consumed: false,
          cancelled: false,
          firstPoint: { x: Number(point.x), y: Number(point.y) },
        };
        pendingPencilQueueRef.current.push(pendingPencil);
        activePencilRef.current = pendingPencil;
      }

      if (activeToolRef.current === 'text') {
        const targetText = objectAtScenePoint(scenePoint, {
          predicate: (object) => {
            if (!isTextObject(object) || object.transientPreview || object.transientSelectionProxy) return false;
            const remoteLock = object.boardObjectId ? remoteLocksRef.current.get(object.boardObjectId) : null;
            return !remoteLock || Number(remoteLock.expiresAt ?? 0) <= Date.now();
          },
        });
        if (targetText) {
          openTextEditor(targetText);
          updateSelectionState();
          updateSelectionStyleState();
          return;
        }
        const point = scenePoint;
        const textObject = new IText('text', {
          left: point.x,
          top: point.y,
          originX: 'left',
          originY: 'top',
          fill: hexToRgba(colorRef.current, opacityRef.current),
          fontFamily: fontFamilyRef.current,
          fontSize: fontSizeRef.current,
          objectKind: 'text',
          editable: true,
          textPlaceholder: true,
        });
        markObject(textObject, clientId);
        newTextDraftIdsRef.current.add(String(textObject.boardObjectId));
        canvas.add(textObject);
        canvas.setActiveObject(textObject);
        canvas.requestRenderAll();
        commitAddedObject(textObject);
        openTextEditor(textObject);
        updateSelectionState();
        updateSelectionStyleState();
        setSaveStatus('Введите текст');
        return;
      }

      if (activeToolRef.current === 'line') {
        const point = scenePoint;
        const line = new Line([point.x, point.y, point.x, point.y], {
          stroke: hexToRgba(colorRef.current, opacityRef.current),
          strokeWidth: widthRef.current,
          strokeUniform: true,
          fill: hexToRgba(colorRef.current, opacityRef.current),
          strokeLineCap: 'round',
          selectable: false,
          evented: false,
        });
        markObject(line, clientId);
        const sessionId = beginLiveDraw('line', line.boardObjectId, point, {
          stroke: hexToRgba(colorRef.current, opacityRef.current),
          width: widthRef.current,
        });
        line.creationSessionId = sessionId;
        line.creationClientId = clientId;
        const creationPointer = creationPointerForDraft(nativeEvent);
        lineRef.current = {
          kind: 'line',
          object: line,
          start: new Point(point.x, point.y),
          pointerKey: creationPointer.key,
          pointerId: creationPointer.pointerId,
          pointerType: creationPointer.pointerType,
          startedAt: Date.now(),
          sessionId,
          cancelled: false,
          finalized: false,
        };
        lineStartRef.current = point;
        prepareCreationPreviewObject(line);
        scheduleCreationPreview();
        return;
      }

    });

    canvas.on('mouse:move', (event) => {
      const nativeEvent = event.e;
      if (activeToolRef.current === 'select'
        && Number(nativeEvent?.buttons ?? 0) > 0
        && shouldSuppressSelectionCompatibilityEvent(nativeEvent)) return;
      if (nativeEvent?.pointerId != null && rejectedPointerIdsRef.current.has(nativeEvent.pointerId)) return;
      const textTapCandidate = textTapCandidateRef.current;
      if (textTapCandidate
        && (textTapCandidate.pointerId == null || nativeEvent?.pointerId == null || textTapCandidate.pointerId === nativeEvent.pointerId)
        && Math.hypot(
          Number(nativeEvent?.clientX ?? 0) - textTapCandidate.startX,
          Number(nativeEvent?.clientY ?? 0) - textTapCandidate.startY,
        ) >= 6) {
        textTapCandidate.moved = true;
      }
      const cursorScenePoint = event.scenePoint ?? canvas.getScenePoint(nativeEvent);
      lastPointerSceneRef.current = cursorScenePoint;
      if (!liveTransformSendRef.current.sessionId
        && !liveDrawSendRef.current.sessionId
        && !selectionDragRef.current) {
        sendCursorThrottled(cursorScenePoint);
      }
      if (panningRef.current) {
        const point = event.viewportPoint ?? canvas.getViewportPoint(nativeEvent);
        const last = lastPanRef.current;
        if (last && canvas.viewportTransform) {
          canvas.viewportTransform[4] += point.x - last.x;
          canvas.viewportTransform[5] += point.y - last.y;
          updateBackgroundTransform();
          sendTeacherViewThrottled();
          canvas.requestRenderAll();
        }
        lastPanRef.current = point;
        return;
      }

      if (!canEditRef.current) return;
      if (shapeDraftRef.current && activeToolRef.current === 'shape') {
        const draft = shapeDraftRef.current;
        if (draft.cancelled || draft.finalized || !creationDraftOwnsEvent(draft, nativeEvent)) return;
        const dx = cursorScenePoint.x - draft.start.x;
        const dy = cursorScenePoint.y - draft.start.y;
        const drawnWidth = Math.max(2, Math.abs(dx));
        const drawnHeight = Math.max(2, Math.abs(dy));
        draft.object.set({
          left: draft.start.x + dx / 2,
          top: draft.start.y + dy / 2,
          scaleX: drawnWidth / draft.baseWidth,
          scaleY: drawnHeight / draft.baseHeight,
        });
        draft.object.dirty = true;
        draft.object.setCoords();
        sendLiveTransformThrottled(draft.object);
        scheduleCreationPreview();
        return;
      }
      if (selectionDragRef.current
        && activeToolRef.current === 'select'
        && selectionDragOwnsEvent(selectionDragRef.current, nativeEvent)) {
        selectionDragRef.current.end = new Point(cursorScenePoint.x, cursorScenePoint.y);
        scheduleSelectionMarqueePaint();
      }
      const activeStroke = activePencilRef.current;
      const pencilPointerMatches = !activeStroke
        || nativeEvent?.pointerId == null
        || activeStroke.pointerId === nativeEvent.pointerId;
      if (pencilPointerMatches
        && liveDrawSendRef.current.sessionId
        && liveDrawSendRef.current.tool === 'pencil') {
        updateLiveDraw(cursorScenePoint);
      }
      if (activeToolRef.current === 'line' && lineRef.current) {
        const draft = lineRef.current;
        if (draft.cancelled || draft.finalized || !creationDraftOwnsEvent(draft, nativeEvent)) return;
        const point = event.scenePoint ?? canvas.getScenePoint(nativeEvent);
        if (liveDrawSendRef.current.sessionId === draft.sessionId
          && liveDrawSendRef.current.tool === 'line') {
          updateLiveDraw(point);
        }
        draft.object.set({ x2: point.x, y2: point.y });
        draft.object.setCoords();
        scheduleCreationPreview();
      }
    });

    canvas.on('mouse:up', (event) => {
      const nativeEvent = event?.e;
      const pointerId = nativeEvent?.pointerId;
      if (activeToolRef.current === 'select'
        && shouldSuppressSelectionCompatibilityEvent(nativeEvent)) {
        nativeEvent?.preventDefault?.();
        nativeEvent?.stopPropagation?.();
        return;
      }
      if (performance.now() < eyedropperCompatibilityGuardUntilRef.current
        && nativeEvent?.pointerType !== 'pen') {
        nativeEvent?.preventDefault?.();
        nativeEvent?.stopPropagation?.();
        return;
      }
      if (pointerId != null && rejectedPointerIdsRef.current.has(pointerId)) return;
      const textTapCandidate = textTapCandidateRef.current;
      textTapCandidateRef.current = null;
      if (liveTransformSendRef.current.sessionId && !shapeDraftRef.current) {
        // object:modified owns normal transform completion. Keep the cached z-index map
        // alive through that event; only close a session on the next frame if Fabric did
        // not emit object:modified (for example after a cancelled/no-op drag).
        const pendingSessionId = liveTransformSendRef.current.sessionId;
        window.requestAnimationFrame(() => {
          if (liveTransformSendRef.current.sessionId !== pendingSessionId) return;
          finishPenTransformIsolation({ composite: true, scheduleReconcile: true });
          endLiveTransform(liveTransformSendRef.current.pendingTarget ?? canvas.getActiveObject(), pendingSessionId);
          transformGestureRef.current.activeId = null;
          transformGestureRef.current.pointerType = null;
          modifiedBeforeRef.current = [];
        });
      }
      if (localLockIdsRef.current.length) {
        realtimeRef.current?.sendLock(localLockIdsRef.current, false);
        localLockIdsRef.current = [];
      }
      if (panningRef.current) {
        panningRef.current = false;
        lastPanRef.current = null;
        canvas.defaultCursor = 'default';
        configureBrushAndMode();
        return;
      }

      if (shapeDraftRef.current) {
        if (finalizeCreationDraft(nativeEvent)) return;
        return;
      }

      if (activeToolRef.current === 'pencil' && activePencilRef.current) {
        const pending = activePencilRef.current;
        if (pointerId != null && pending.pointerId != null && pointerId !== pending.pointerId) return;
        pending.mouseReleased = true;
        pending.releasedAt = Date.now();
        window.clearTimeout(pending.cancelTimer);
        if (pending.cancelled) {
          finishLiveDraw('cancel', pending.sessionId);
        } else {
          finishLiveDraw('end', pending.sessionId);
        }
        // path:created is normally emitted during this same mouse-up. Keep the exact
        // pending record briefly for Safari, then discard it before another stroke can
        // ever reuse its id.
        pending.cancelTimer = window.setTimeout(() => {
          const index = pendingPencilQueueRef.current.indexOf(pending);
          if (index >= 0) pendingPencilQueueRef.current.splice(index, 1);
          if (activePencilRef.current === pending) activePencilRef.current = null;
          if (!pending.consumed) finishLiveDraw('cancel', pending.sessionId);
        }, pending.cancelled ? 80 : 850);
      }

      finalizeSelectionMarquee(nativeEvent);
      if (selectionBoxRef.current) {
        canvas.remove(selectionBoxRef.current);
        selectionBoxRef.current = null;
      }

      if (activeToolRef.current === 'select'
        && textTapCandidate
        && !textTapCandidate.moved
        && (textTapCandidate.pointerId == null || pointerId == null || textTapCandidate.pointerId === pointerId)
        && textTapCandidate.target?.canvas === canvas) {
        openTextEditor(textTapCandidate.target);
        updateSelectionState();
        updateSelectionStyleState();
        return;
      }

      if (lineRef.current) {
        finalizeCreationDraft(nativeEvent);
      }

    });

    canvas.on('mouse:wheel', (event) => {
      event.e.preventDefault();
      event.e.stopPropagation();
      const nextZoom = clamp(
        canvas.getZoom() * Math.pow(0.999, event.e.deltaY * DESKTOP_WHEEL_ZOOM_SPEED),
        MIN_ZOOM,
        MAX_ZOOM,
      );
      const point = event.viewportPoint ?? canvas.getViewportPoint(event.e);
      canvas.zoomToPoint(point, nextZoom);
      setZoom(nextZoom);
      updateBackgroundTransform();
      sendTeacherViewThrottled();
    });

    const touchTarget = canvas.upperCanvasEl;

    const activeTouchPointers = new Set();
    const handoffTouchPointers = new Map();
    const heldArrowKeys = new Map();
    let arrowPanFrame = null;
    let lastArrowPanAt = 0;
    let objectEraserDelayTimer = null;
    let objectEraserPreviousRenderOnAddRemove = null;
    let objectEraserPendingPatchRects = [];

    function restoreObjectEraserRenderMode() {
      if (objectEraserPreviousRenderOnAddRemove == null) return;
      canvas.renderOnAddRemove = objectEraserPreviousRenderOnAddRemove;
      objectEraserPreviousRenderOnAddRemove = null;
    }

    function flushObjectEraserVisualPatches() {
      const rects = objectEraserPendingPatchRects;
      objectEraserPendingPatchRects = [];
      if (!rects.length) return;
      // Deleted objects have already been removed from the persistent spatial index.
      // Repaint only their visible footprints and objects that overlap those footprints.
      // A full Fabric render is retained solely as a safety fallback if the cropped
      // compositor is unavailable, preserving correctness without penalising normal use.
      if (!renderLocalDeletionPatches(rects)) canvas.requestRenderAll();
    }

    const mobileGameLibrarySequence = [1, 2, 3, 2, 1];
    let mobileGameLibraryGesture = {
      index: 0,
      sequenceStartedAt: 0,
      stageStartedAt: 0,
      trackingStage: false,
      maxTouches: 0,
      moved: false,
      startPoints: new Map(),
    };

    function resetMobileGameLibraryGesture() {
      mobileGameLibraryGesture = {
        index: 0,
        sequenceStartedAt: 0,
        stageStartedAt: 0,
        trackingStage: false,
        maxTouches: 0,
        moved: false,
        startPoints: new Map(),
      };
    }

    function beginMobileGameLibraryTouchStage(event) {
      if (!isOwner) return false;
      const now = performance.now();
      if (mobileGameLibraryGesture.sequenceStartedAt
        && now - mobileGameLibraryGesture.sequenceStartedAt > 6500) {
        resetMobileGameLibraryGesture();
      }
      if (!mobileGameLibraryGesture.trackingStage) {
        mobileGameLibraryGesture.trackingStage = true;
        mobileGameLibraryGesture.stageStartedAt = now;
        mobileGameLibraryGesture.maxTouches = 0;
        mobileGameLibraryGesture.moved = false;
        mobileGameLibraryGesture.startPoints = new Map();
        if (!mobileGameLibraryGesture.sequenceStartedAt) {
          mobileGameLibraryGesture.sequenceStartedAt = now;
        }
      }
      mobileGameLibraryGesture.maxTouches = Math.max(
        mobileGameLibraryGesture.maxTouches,
        event.touches.length,
      );
      for (const touch of Array.from(event.touches)) {
        if (!mobileGameLibraryGesture.startPoints.has(touch.identifier)) {
          mobileGameLibraryGesture.startPoints.set(touch.identifier, {
            x: touch.clientX,
            y: touch.clientY,
          });
        }
      }
      const expectedTouches = mobileGameLibrarySequence[mobileGameLibraryGesture.index];
      return mobileGameLibraryGesture.index > 0
        && event.touches.length >= expectedTouches;
    }

    function moveMobileGameLibraryTouchStage(event) {
      if (!isOwner || !mobileGameLibraryGesture.trackingStage) return false;
      mobileGameLibraryGesture.maxTouches = Math.max(
        mobileGameLibraryGesture.maxTouches,
        event.touches.length,
      );
      for (const touch of Array.from(event.touches)) {
        const start = mobileGameLibraryGesture.startPoints.get(touch.identifier);
        if (!start) continue;
        if (Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > 24) {
          mobileGameLibraryGesture.moved = true;
        }
      }
      const expectedTouches = mobileGameLibrarySequence[mobileGameLibraryGesture.index];
      return mobileGameLibraryGesture.index > 0
        && mobileGameLibraryGesture.maxTouches >= expectedTouches;
    }

    function finishMobileGameLibraryTouchStage(event) {
      if (!isOwner || !mobileGameLibraryGesture.trackingStage) return false;
      const expectedTouches = mobileGameLibrarySequence[mobileGameLibraryGesture.index];
      const wasSecretStage = mobileGameLibraryGesture.index > 0
        && mobileGameLibraryGesture.maxTouches >= expectedTouches;
      if (event.touches.length > 0) return wasSecretStage;

      const now = performance.now();
      const validStage = !mobileGameLibraryGesture.moved
        && now - mobileGameLibraryGesture.stageStartedAt <= 1100
        && mobileGameLibraryGesture.maxTouches === expectedTouches;

      mobileGameLibraryGesture.trackingStage = false;
      mobileGameLibraryGesture.stageStartedAt = 0;
      mobileGameLibraryGesture.maxTouches = 0;
      mobileGameLibraryGesture.moved = false;
      mobileGameLibraryGesture.startPoints = new Map();

      if (!validStage) {
        resetMobileGameLibraryGesture();
        return wasSecretStage;
      }

      const completedStageIndex = mobileGameLibraryGesture.index;
      mobileGameLibraryGesture.index += 1;
      if (mobileGameLibraryGesture.index === mobileGameLibrarySequence.length) {
        resetMobileGameLibraryGesture();
        toggleGameLibraryVisibilityRef.current?.();
        return true;
      }
      return completedStageIndex > 0;
    }

    function stopArrowPan() {
      heldArrowKeys.clear();
      if (arrowPanFrame != null) window.cancelAnimationFrame(arrowPanFrame);
      arrowPanFrame = null;
      lastArrowPanAt = 0;
    }

    function runArrowPan(timestamp) {
      if (!heldArrowKeys.size) {
        stopArrowPan();
        return;
      }
      const elapsed = lastArrowPanAt > 0 ? Math.min(40, timestamp - lastArrowPanAt) : 16;
      lastArrowPanAt = timestamp;
      const fast = [...heldArrowKeys.values()].some((state) => state.shiftKey);
      const distance = (fast ? 1120 : 620) * (elapsed / 1000);
      let deltaX = 0;
      let deltaY = 0;
      if (heldArrowKeys.has('ArrowLeft')) deltaX += distance;
      if (heldArrowKeys.has('ArrowRight')) deltaX -= distance;
      if (heldArrowKeys.has('ArrowUp')) deltaY += distance;
      if (heldArrowKeys.has('ArrowDown')) deltaY -= distance;
      const viewport = [...(canvas.viewportTransform ?? [1, 0, 0, 1, 0, 0])];
      viewport[4] += deltaX;
      viewport[5] += deltaY;
      canvas.setViewportTransform(viewport);
      updateBackgroundTransform();
      sendTeacherViewThrottled();
      canvas.requestRenderAll();
      arrowPanFrame = window.requestAnimationFrame(runArrowPan);
    }

    function startArrowPan() {
      if (arrowPanFrame != null) return;
      lastArrowPanAt = 0;
      arrowPanFrame = window.requestAnimationFrame(runArrowPan);
    }

    function rejectPointerEvent(event) {
      if (event.pointerId != null) rejectedPointerIdsRef.current.add(event.pointerId);
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
    }

    function rememberHandoffTouchPointer(event) {
      if (event.pointerType !== 'touch' || event.pointerId == null) return;
      handoffTouchPointers.set(event.pointerId, {
        id: event.pointerId,
        clientX: Number(event.clientX ?? 0),
        clientY: Number(event.clientY ?? 0),
        radius: Math.max(Number(event.width ?? 0), Number(event.height ?? 0)),
        seenAt: Date.now(),
      });
    }

    function forgetHandoffTouchPointer(event) {
      if (event.pointerType === 'touch' && event.pointerId != null) {
        handoffTouchPointers.delete(event.pointerId);
      }
    }

    function eligibleHandoffPointerPair() {
      const contacts = [...handoffTouchPointers.values()]
        .filter((contact) => Date.now() - Number(contact.seenAt ?? 0) < 500);
      if (contacts.length !== 2) return null;
      if (contacts.some((contact) => Number(contact.radius ?? 0) > PENCIL_HANDOFF_MAX_RADIUS)) return null;
      const separation = Math.hypot(
        contacts[0].clientX - contacts[1].clientX,
        contacts[0].clientY - contacts[1].clientY,
      );
      return separation >= PENCIL_HANDOFF_MIN_SEPARATION ? contacts : null;
    }

    function eligibleHandoffTouchPair(event) {
      if (event?.type !== 'touchstart') return null;
      const fingers = touchArray(event.touches).filter((touch) => !isStylusTouch(touch));
      if (fingers.length !== 2 || fingers.length !== event.touches.length) return null;
      if (fingers.some((touch) => Math.max(
        Number(touch?.radiusX ?? 0),
        Number(touch?.radiusY ?? 0),
      ) > PENCIL_HANDOFF_MAX_RADIUS)) return null;
      const separation = Math.hypot(
        Number(fingers[0]?.clientX ?? 0) - Number(fingers[1]?.clientX ?? 0),
        Number(fingers[0]?.clientY ?? 0) - Number(fingers[1]?.clientY ?? 0),
      );
      return separation >= PENCIL_HANDOFF_MIN_SEPARATION ? fingers : null;
    }

    function makeSyntheticPenUpEvent() {
      const pen = penInputRef.current;
      const init = {
        bubbles: false,
        cancelable: true,
        clientX: Number(pen.lastClientX ?? 0),
        clientY: Number(pen.lastClientY ?? 0),
        button: 0,
        buttons: 0,
        pointerId: Number(pen.pointerId ?? 1),
        pointerType: 'pen',
        isPrimary: true,
        pressure: 0,
      };
      try {
        return new PointerEvent('pointerup', init);
      } catch {
        return {
          type: 'pointerup',
          ...init,
          preventDefault() {},
          stopPropagation() {},
          stopImmediatePropagation() {},
        };
      }
    }

    function finishPenForTwoFingerHandoff() {
      const pen = penInputRef.current;
      if (!pen.active || Date.now() - Number(pen.lastSeenAt ?? 0) < PENCIL_HANDOFF_IDLE_MS) return false;
      const syntheticUp = makeSyntheticPenUpEvent();
      try {
        if (canvas._isCurrentlyDrawing && typeof canvas._onMouseUpInDrawingMode === 'function') {
          canvas._onMouseUpInDrawingMode(syntheticUp);
        }
      } catch {
        return false;
      }
      const now = Date.now();
      penInputRef.current = {
        pointerId: null,
        active: false,
        lastSeenAt: now,
        lastClientX: Number(pen.lastClientX ?? 0),
        lastClientY: Number(pen.lastClientY ?? 0),
        suppressUntil: 0,
      };
      return true;
    }

    function abortFabricDrawingForTouchGesture(event) {
      if (!canvas._isCurrentlyDrawing) return;
      try {
        if (typeof canvas._onMouseUpInDrawingMode === 'function') {
          canvas._onMouseUpInDrawingMode(event);
        } else {
          canvas._isCurrentlyDrawing = false;
        }
      } catch {
        canvas._isCurrentlyDrawing = false;
        try { canvas.clearContext?.(canvas.contextTop); } catch { /* Ignore cleanup fallback. */ }
      }
    }

    function releaseFabricTouchOwnership(event) {
      if (event?.touches?.length !== 0) return;
      try {
        if (typeof canvas._onTouchEnd === 'function') canvas._onTouchEnd(event);
        else canvas.mainTouchId = undefined;
      } catch {
        canvas.mainTouchId = undefined;
      }
    }

    function isLikelyPalmPointer(event) {
      return Math.max(Number(event?.width ?? 0), Number(event?.height ?? 0)) >= PALM_CONTACT_RADIUS;
    }

    function isStylusTouch(touch) {
      return String(touch?.touchType ?? '').toLowerCase() === 'stylus';
    }

    function isStylusFallbackPointerEvent(event) {
      return Boolean(event?.alexStylusTouchFallback);
    }

    function findStylusTouch(event, expectedId = null) {
      const candidates = [
        ...touchArray(event?.changedTouches),
        ...touchArray(event?.touches),
      ];
      return candidates.find((touch) => (
        isStylusTouch(touch)
        && (expectedId == null || touchId(touch) === expectedId)
      )) ?? null;
    }

    function fallbackPointerIdForTouch(identifier) {
      const numeric = Number(identifier);
      const safeIdentifier = Number.isFinite(numeric) ? Math.abs(Math.trunc(numeric)) : 1;
      return 1_500_000_000 + (safeIdentifier % 100_000_000);
    }

    function dispatchStylusFallbackPointer(type, touch) {
      if (!touch) return false;
      const state = stylusTouchFallbackRef.current;
      const ending = type === 'pointerup' || type === 'pointercancel';
      const active = !ending;
      const force = Number(touch.force ?? 0);
      const pressure = ending ? 0 : (force > 0 ? clamp(force, 0.01, 1) : 0.5);
      const init = {
        bubbles: true,
        cancelable: true,
        composed: true,
        pointerId: Number(state.pointerId ?? fallbackPointerIdForTouch(touchId(touch))),
        pointerType: 'pen',
        isPrimary: true,
        button: 0,
        buttons: active ? 1 : 0,
        pressure,
        width: Math.max(1, Number(touch.radiusX ?? 0) * 2 || 1),
        height: Math.max(1, Number(touch.radiusY ?? 0) * 2 || 1),
        clientX: Number(touch.clientX ?? state.lastClientX ?? 0),
        clientY: Number(touch.clientY ?? state.lastClientY ?? 0),
        screenX: Number(touch.screenX ?? 0),
        screenY: Number(touch.screenY ?? 0),
      };
      let synthetic;
      try {
        synthetic = new PointerEvent(type, init);
      } catch {
        synthetic = new MouseEvent(type, init);
        for (const [key, value] of Object.entries({
          pointerId: init.pointerId,
          pointerType: 'pen',
          isPrimary: true,
          pressure: init.pressure,
          width: init.width,
          height: init.height,
        })) {
          try { Object.defineProperty(synthetic, key, { configurable: true, value }); } catch { /* Ignore. */ }
        }
      }
      try {
        Object.defineProperty(synthetic, 'alexStylusTouchFallback', {
          configurable: true,
          value: true,
        });
      } catch {
        synthetic.alexStylusTouchFallback = true;
      }
      state.lastClientX = init.clientX;
      state.lastClientY = init.clientY;
      return touchTarget.dispatchEvent(synthetic);
    }

    function claimStylusTouchEvent(event) {
      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
    }

    function beginStylusTouchFallback(event) {
      const stylus = findStylusTouch(event);
      if (!stylus) return false;
      // Pointer Events remain the preferred path. The TouchEvent route is activated only
      // when WebKit delivered a stylus touch without first delivering pointerdown.
      if (penInputRef.current.active && !stylusTouchFallbackRef.current.active) return false;

      const identifier = touchId(stylus);
      const state = stylusTouchFallbackRef.current;
      if (state.active && state.touchId === identifier) {
        claimStylusTouchEvent(event);
        return true;
      }
      if (state.active) {
        dispatchStylusFallbackPointer('pointercancel', stylus);
      }

      stylusTouchFallbackRef.current = {
        active: true,
        touchId: identifier,
        pointerId: fallbackPointerIdForTouch(identifier),
        lastClientX: Number(stylus.clientX ?? 0),
        lastClientY: Number(stylus.clientY ?? 0),
        guardUntil: performance.now() + 250,
      };
      claimStylusTouchEvent(event);
      dispatchStylusFallbackPointer('pointerdown', stylus);
      return true;
    }

    function moveStylusTouchFallback(event) {
      const state = stylusTouchFallbackRef.current;
      if (!state.active) return false;
      const stylus = findStylusTouch(event, state.touchId);
      if (!stylus) return false;
      claimStylusTouchEvent(event);
      dispatchStylusFallbackPointer('pointermove', stylus);
      return true;
    }

    function finishStylusTouchFallback(event, cancelled = false) {
      const state = stylusTouchFallbackRef.current;
      if (!state.active) return false;
      const stylus = findStylusTouch(event, state.touchId) ?? {
        identifier: state.touchId,
        clientX: state.lastClientX,
        clientY: state.lastClientY,
        force: 0,
        radiusX: 0.5,
        radiusY: 0.5,
        touchType: 'stylus',
      };
      claimStylusTouchEvent(event);
      dispatchStylusFallbackPointer(cancelled ? 'pointercancel' : 'pointerup', stylus);
      stylusTouchFallbackRef.current = {
        active: false,
        touchId: null,
        pointerId: null,
        lastClientX: Number(stylus.clientX ?? state.lastClientX ?? 0),
        lastClientY: Number(stylus.clientY ?? state.lastClientY ?? 0),
        // Reject a late native pointer event generated for the same physical contact.
        // A genuinely new rapid contact still has its own touchstart and will use this
        // fallback route if its pointerdown is caught by the guard.
        guardUntil: performance.now() + 180,
      };
      return true;
    }

    function shouldRejectNativePenAfterTouchFallback(event) {
      if (event.pointerType !== 'pen' || isStylusFallbackPointerEvent(event)) return false;
      const state = stylusTouchFallbackRef.current;
      if (!state.active && performance.now() >= Number(state.guardUntil ?? 0)) return false;
      const distance = Math.hypot(
        Number(event.clientX ?? 0) - Number(state.lastClientX ?? 0),
        Number(event.clientY ?? 0) - Number(state.lastClientY ?? 0),
      );
      return state.active || distance <= 42;
    }

    function isLikelyPalmTouch(touch) {
      return Math.max(Number(touch?.radiusX ?? 0), Number(touch?.radiusY ?? 0)) >= PALM_CONTACT_RADIUS;
    }

    function touchId(touch) {
      return touch?.identifier == null ? null : Number(touch.identifier);
    }

    function touchArray(touches) {
      return Array.from(touches ?? []);
    }

    function suppressTouchContacts(touches) {
      touchArray(touches).forEach((touch) => {
        if (isStylusTouch(touch)) return;
        const identifier = touchId(touch);
        if (identifier != null) suppressedTouchIdsRef.current.add(identifier);
      });
    }

    function releaseEndedSuppressedTouches(event) {
      touchArray(event?.changedTouches).forEach((touch) => {
        const identifier = touchId(touch);
        if (identifier != null) suppressedTouchIdsRef.current.delete(identifier);
      });
    }

    function unsuppressedFingerTouches(touches) {
      return touchArray(touches).filter((touch) => {
        if (isStylusTouch(touch)) return false;
        const identifier = touchId(touch);
        return identifier == null || !suppressedTouchIdsRef.current.has(identifier);
      });
    }

    function touchEventHasSuppressedContact(event) {
      return [...touchArray(event?.touches), ...touchArray(event?.changedTouches)].some((touch) => {
        const identifier = touchId(touch);
        return identifier != null && suppressedTouchIdsRef.current.has(identifier);
      });
    }

    function rejectTouchEvent(event) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
    }

    function suppressSelectionCompatibilityEvent(event) {
      if (event?.cancelable) event.preventDefault();
      event?.stopPropagation?.();
      event?.stopImmediatePropagation?.();
    }

    function shouldSuppressSelectionCompatibilityEvent(event) {
      const session = selectionPenSessionRef.current;
      // Capture phase starts a new native Pencil session before Fabric receives its
      // mouse-like wrapper. While that new contact is active, the wrapper belongs to the
      // current gesture and must pass. Only the short tail after release is a duplicate.
      if (session.active) return false;
      if (performance.now() >= Number(session.compatibilityGuardUntil ?? 0)) return false;
      return event?.pointerType == null || event?.pointerType === 'mouse';
    }

    function restoreSelectionTargetFind() {
      window.clearTimeout(selectionTargetFindResetRef.current);
      selectionTargetFindResetRef.current = null;
      const state = selectionTargetFindRestoreState;
      selectionTargetFindRestoreState = null;
      if (!state) return;
      for (const entry of state.paddedObjects ?? []) {
        if (!entry?.object) continue;
        entry.object.padding = entry.padding;
      }
      if (fabricCanvasRef.current !== canvas) return;
      canvas.perPixelTargetFind = state.perPixelTargetFind;
      if (typeof canvas.setTargetFindTolerance === 'function') {
        canvas.setTargetFindTolerance(Number(state.targetFindTolerance ?? 0));
      } else {
        canvas.targetFindTolerance = state.targetFindTolerance;
      }
    }

    function armExactSelectionTargetFind({ pen = false, event = null } = {}) {
      // Preserve Fabric's normal finger/mouse behaviour. For Pencil only, combine:
      //   1) per-pixel hit testing, so transparent space inside a bounding frame is NOT a hit;
      //   2) a small 9px screen-space proximity halo around nearby real objects.
      // The temporary padding exists only until Fabric caches the pointer target and is
      // restored in mouse:down:before, before selection/transform logic mutates anything.
      if (!selectionTargetFindRestoreState) {
        selectionTargetFindRestoreState = {
          perPixelTargetFind: canvas.perPixelTargetFind,
          targetFindTolerance: canvas.targetFindTolerance,
          paddedObjects: [],
        };
      }
      const state = selectionTargetFindRestoreState;
      window.clearTimeout(selectionTargetFindResetRef.current);
      canvas.perPixelTargetFind = true;
      if (pen) {
        const tolerance = Math.max(Number(canvas.targetFindTolerance ?? 0), 9);
        // Fabric 7 sizes a dedicated pixel-probe canvas in setTargetFindTolerance().
        // Assigning a larger value directly leaves that backing canvas too small.
        if (typeof canvas.setTargetFindTolerance === 'function') canvas.setTargetFindTolerance(tolerance);
        else canvas.targetFindTolerance = tolerance;

        if (event && !(state.paddedObjects?.length)) {
          try {
            const point = canvas.getScenePoint(event);
            const zoom = Math.max(canvas.getZoom?.() ?? 1, MIN_ZOOM);
            const sceneTolerance = tolerance / zoom;
            const nearby = queryTransformSpatialObjects({
              left: point.x - sceneTolerance,
              top: point.y - sceneTolerance,
              right: point.x + sceneTolerance,
              bottom: point.y + sceneTolerance,
              width: sceneTolerance * 2,
              height: sceneTolerance * 2,
            }).filter((object) => (
              object?.canvas === canvas
              && object.selectable !== false
              && object.evented !== false
              && !object.isEraserPath
              && !object.transientPreview
              && !object.transientSelectionProxy
            ));
            state.paddedObjects = nearby.map((object) => ({ object, padding: object.padding }));
            for (const { object } of state.paddedObjects) {
              object.padding = Math.max(Number(object.padding ?? 0), tolerance);
            }
          } catch {
            // Per-pixel target finding still prevents frame-only hits if proximity setup fails.
          }
        }
      }
      // Fallback cleanup for a browser event that never reaches Fabric's down:before.
      selectionTargetFindResetRef.current = window.setTimeout(restoreSelectionTargetFind, 0);
    }

    const restoreSelectionTargetFindBeforeFabricLogic = () => {
      // Canvas._cacheTransformEventData() has already cached the precise target before
      // this event fires. Restore temporary padding/tolerance now so the actual
      // selection and control geometry stay exactly as they were before the Pencil tap.
      restoreSelectionTargetFind();
    };
    canvas.on('mouse:down:before', restoreSelectionTargetFindBeforeFabricLogic);

    function beginSelectionPenSession(event) {
      if (event.pointerType !== 'pen'
        || activeToolRef.current !== 'select'
        || eyedropperActiveRef.current
        || !canEditRef.current
        || event.button > 0) return false;
      // Do not suppress the lower Fabric canvas when this contact can begin an
      // object/group transform. The cropped Pencil compositor takes ownership in
      // before:transform (or in the custom hand-control tick). Starting the top-only
      // guard before that point made small-board Pencil drags invisible and caused the
      // object to appear only at pointerup. Keep the top-only guard only for an empty
      // canvas contact that can create/dismiss a marquee.
      let mayStartObjectTransform = Boolean(canvas.getActiveObject());
      if (!mayStartObjectTransform) {
        try {
          const point = canvas.getScenePoint(event);
          const zoom = Math.max(canvas.getZoom?.() ?? 1, MIN_ZOOM);
          const sceneTolerance = Math.max(3, 10 / zoom);
          const nearby = queryTransformSpatialObjects({
            left: point.x - sceneTolerance,
            top: point.y - sceneTolerance,
            right: point.x + sceneTolerance,
            bottom: point.y + sceneTolerance,
            width: sceneTolerance * 2,
            height: sceneTolerance * 2,
          });
          mayStartObjectTransform = nearby.some((object) => (
            object?.canvas === canvas
            && object.selectable !== false
            && object.evented !== false
            && !object.isEraserPath
            && !object.transientPreview
            && !object.transientSelectionProxy
          ));
        } catch {
          // When target probing is unavailable, prefer normal Fabric rendering over a
          // visually frozen drag. The compositor will still take over if a transform starts.
          mayStartObjectTransform = true;
        }
      }
      if (mayStartObjectTransform) restorePenSelectionRenderGuard();
      else beginPenSelectionRenderGuard();
      const session = selectionPenSessionRef.current;
      if (session.active && session.pointerId === event.pointerId) {
        suppressSelectionCompatibilityEvent(event);
        return true;
      }

      // A new real Pencil contact must immediately cancel the duplicate-event tail from
      // the previous contact. Otherwise Fabric can expose the new contact as a mouse-like
      // event and the old time guard rejects it, restarting the same lock on every retry.
      session.generation += 1;
      session.compatibilityGuardUntil = 0;
      if (session.active && session.pointerId != null && session.pointerId !== event.pointerId) {
        finalizeSelectionMarquee(null, { cancelled: true });
        try {
          if (touchTarget.hasPointerCapture?.(session.pointerId)) {
            touchTarget.releasePointerCapture(session.pointerId);
          }
        } catch {
          // A stale WebKit capture can be replaced by the new contact below.
        }
      }
      session.pointerId = event.pointerId;
      session.active = true;
      session.moveFramePending = false;
      try { touchTarget.setPointerCapture(event.pointerId); } catch { /* Safari may reject capture. */ }
      return false;
    }

    function finishSelectionPenSession(event) {
      const session = selectionPenSessionRef.current;
      if (event.pointerType !== 'pen' || !session.active || session.pointerId !== event.pointerId) return false;
      const cancelled = event.type === 'pointercancel' || event.type === 'lostpointercapture';
      if (cancelled) finishPenTransformIsolation({ composite: true, scheduleReconcile: true });

      // Complete a Pencil marquee directly from the native release. Safari's mirrored
      // mouse tail is suppressed only for a very short period after this exact contact.
      finalizeSelectionMarquee(event, { cancelled });

      const endedAt = performance.now();
      session.lastEndedAt = endedAt;
      session.compatibilityGuardUntil = endedAt + 140;
      session.active = false;
      session.moveFramePending = false;
      if (cancelled) {
        endLiveTransform(liveTransformSendRef.current.pendingTarget ?? canvas.getActiveObject());
        if (localLockIdsRef.current.length) {
          realtimeRef.current?.sendLock(localLockIdsRef.current, false);
          localLockIdsRef.current = [];
        }
      }

      // Release and clear synchronously. The former setTimeout(0) could erase a newly
      // started session when Safari quickly reused the same pointerId.
      try {
        if (touchTarget.hasPointerCapture?.(event.pointerId)) touchTarget.releasePointerCapture(event.pointerId);
      } catch {
        // WebKit may already have released capture before pointerup reaches this listener.
      }
      if (!session.active && session.pointerId === event.pointerId) session.pointerId = null;
      finishPenSelectionRenderGuard();
      return true;
    }

    function handlePalmPointerDown(event) {
      lastBoardInteractionAtRef.current = Date.now();
      // A scheduled whole-board compaction must never begin during the next Pencil
      // gesture. It will be re-armed only after a long genuine idle period.
      window.clearTimeout(snapshotPersistTimerRef.current);
      snapshotPersistTimerRef.current = null;
      if (event.pointerType === 'touch') rememberHandoffTouchPointer(event);

      if (activeToolRef.current === 'select'
        && shouldSuppressSelectionCompatibilityEvent(event)) {
        suppressSelectionCompatibilityEvent(event);
        return;
      }
      if (activeToolRef.current === 'select'
        && !eyedropperActiveRef.current
        && canEditRef.current
        && event.button <= 0) {
        armExactSelectionTargetFind({ pen: event.pointerType === 'pen', event });
      }

      if (shouldRejectNativePenAfterTouchFallback(event)) {
        if (event.pointerId != null) rejectedPointerIdsRef.current.add(event.pointerId);
        rejectPointerEvent(event);
        return;
      }

      // Eyedropper owns its complete Pencil stream in capture phase. Fabric sees
      // neither pointerdown nor pointerup, so no stale pencil/mouse session can survive.
      if (beginEyedropperPenContact(event)) return;
      if (beginSelectionPenSession(event)) return;

      if (event.pointerType === 'pen') {
        // Pointer ids may be reused by Safari. A new Pencil contact must never inherit
        // a rejected palm id from an earlier contact.
        rejectedPointerIdsRef.current.delete(event.pointerId);

        const interruptedGesture = touchGestureRef.current;
        const interruptedTouchGesture = Boolean(interruptedGesture?.active);
        if (interruptedGesture) {
          // Pencil has priority over a pinch that is finishing. Keep the old fingers
          // suppressed until their own touchend so they cannot reopen zoom mid-stroke.
          for (const identifier of interruptedGesture.fingerIds ?? []) {
            if (identifier != null) suppressedTouchIdsRef.current.add(identifier);
          }
          cancelActiveDrawingForTouchGesture();
          abortFabricDrawingForTouchGesture(event);
          touchGestureRef.current = null;
          touchGestureGenerationRef.current += 1;
          lastTouchGestureEndedAtRef.current = performance.now();
        }

        penInputRef.current = {
          pointerId: event.pointerId,
          active: true,
          lastSeenAt: Date.now(),
          lastClientX: Number(event.clientX ?? 0),
          lastClientY: Number(event.clientY ?? 0),
          suppressUntil: 0,
        };

        const justAfterTouchGesture = performance.now()
          - Number(lastTouchGestureEndedAtRef.current ?? 0) < 350;
        const drawingToolNeedsRepair = (activeToolRef.current === 'pencil'
          || (activeToolRef.current === 'eraser' && eraserModeRef.current === 'partial'))
          && !canvas.isDrawingMode;

        // Restore synchronously in capture phase, before this same pointerdown reaches
        // Fabric. This prevents the first Pencil contact after zoom from being lost.
        // The lightweight function never scans the objects on the board.
        if (interruptedTouchGesture || justAfterTouchGesture || drawingToolNeedsRepair) {
          applyCanvasInputMode();
          if (activeToolRef.current === 'select') armExactSelectionTargetFind({ pen: true, event });
        }
        rememberNativeCreationPointer(event);
        return;
      }

      // A touch arriving while the Pencil is down is a palm/hand contact, not a second
      // drawing pointer. During the brief release grace period only a large contact is
      // rejected, so a deliberate small one-finger stroke can still start immediately.
      if (event.pointerType === 'touch') {
        const pair = eligibleHandoffPointerPair();
        const handedOff = Boolean(pair) && finishPenForTwoFingerHandoff();
        const contactRadius = Math.max(Number(event.width ?? 0), Number(event.height ?? 0));
        const likelyPalm = isLikelyPalmPointer(event);
        const additionalContact = event.isPrimary === false;
        const duringPencil = !handedOff
          && penInputRef.current.active
          && (likelyPalm || additionalContact);
        const duringGrace = Date.now() < Number(penInputRef.current.suppressUntil ?? 0)
          && contactRadius > PENCIL_HANDOFF_MAX_RADIUS;
        if (duringPencil || duringGrace) {
          clearPendingNativeCreationPointer(event);
          rejectPointerEvent(event);
          return;
        }
      }
      rememberNativeCreationPointer(event);
    }

    function handlePalmPointerMove(event) {
      const sampledPenContact = eyedropperPenContactRef.current;
      if (event.pointerType === 'pen'
        && sampledPenContact?.pointerId === event.pointerId) {
        penInputRef.current.lastSeenAt = Date.now();
        penInputRef.current.lastClientX = Number(event.clientX ?? penInputRef.current.lastClientX ?? 0);
        penInputRef.current.lastClientY = Number(event.clientY ?? penInputRef.current.lastClientY ?? 0);
        consumeEyedropperPointerEvent(event);
        return;
      }
      if (activeToolRef.current === 'select'
        && Number(event.buttons ?? 0) > 0
        && shouldSuppressSelectionCompatibilityEvent(event)) {
        suppressSelectionCompatibilityEvent(event);
        return;
      }
      if (rejectedPointerIdsRef.current.has(event.pointerId)
        && !isStylusFallbackPointerEvent(event)) {
        rejectPointerEvent(event);
        return;
      }
      if (event.pointerType === 'pen') {
        penInputRef.current.lastSeenAt = Date.now();
        penInputRef.current.lastClientX = Number(event.clientX ?? penInputRef.current.lastClientX ?? 0);
        penInputRef.current.lastClientY = Number(event.clientY ?? penInputRef.current.lastClientY ?? 0);
        const selectionSession = selectionPenSessionRef.current;
        if (activeToolRef.current === 'select') {
          // Apple Pencil hover can emit a continuous pen pointer stream before contact.
          // The cursor tool does not need Fabric target finding until pointerdown.
          if (!selectionSession.active || selectionSession.pointerId !== event.pointerId) {
            suppressSelectionCompatibilityEvent(event);
            return;
          }
          if (selectionSession.moveFramePending) {
            suppressSelectionCompatibilityEvent(event);
            return;
          }
          selectionSession.moveFramePending = true;
          window.requestAnimationFrame(() => {
            selectionPenSessionRef.current.moveFramePending = false;
          });
        }
        updateCreationDraftFromNativeEvent(event);
        return;
      }
      if (event.pointerType === 'touch' && handoffTouchPointers.has(event.pointerId)) {
        rememberHandoffTouchPointer(event);
      }
      if (rejectedPointerIdsRef.current.has(event.pointerId)) rejectPointerEvent(event);
      else updateCreationDraftFromNativeEvent(event);
    }

    function handlePalmPointerEnd(event) {
      if (finishEyedropperPenContact(event)) return;
      if (activeToolRef.current === 'select'
        && shouldSuppressSelectionCompatibilityEvent(event)) {
        suppressSelectionCompatibilityEvent(event);
        return;
      }
      finishSelectionPenSession(event);

      if (rejectedPointerIdsRef.current.has(event.pointerId)
        && !isStylusFallbackPointerEvent(event)) {
        clearPendingNativeCreationPointer(event);
        rejectPointerEvent(event);
        window.setTimeout(() => rejectedPointerIdsRef.current.delete(event.pointerId), 0);
        return;
      }

      if (event.type === 'pointercancel') cancelCreationDraft('pointercancel', event);
      else {
        // Capture the final desktop mouse/Pencil coordinate before the capture-phase
        // pointerup finalizes the draft. Fabric's later mouse:up event may not carry
        // another move, which previously left a zero-length point on desktop.
        updateCreationDraftFromNativeEvent(event);
        finalizeCreationDraft(event);
      }
      clearPendingNativeCreationPointer(event);
      if (event.pointerType === 'pen' && penInputRef.current.pointerId === event.pointerId) {
        const now = Date.now();
        penInputRef.current.active = false;
        penInputRef.current.pointerId = null;
        penInputRef.current.lastSeenAt = now;
        penInputRef.current.lastClientX = Number(event.clientX ?? penInputRef.current.lastClientX ?? 0);
        penInputRef.current.lastClientY = Number(event.clientY ?? penInputRef.current.lastClientY ?? 0);
        penInputRef.current.suppressUntil = now + PENCIL_TOUCH_GRACE_MS;
        if (event.type === 'pointercancel') {
          const pending = activePencilRef.current;
          if (pending?.pointerId === event.pointerId) {
            pending.cancelled = true;
            pending.mouseReleased = true;
            pending.releasedAt = now;
            finishLiveDraw('cancel', pending.sessionId);
          }
        }
        // A normal Pencil-up leaves Fabric in drawing mode. Reconfiguring here used to
        // scan every object after every stroke, so only repair an actually disabled mode.
        if ((activeToolRef.current === 'pencil'
          || (activeToolRef.current === 'eraser' && eraserModeRef.current === 'partial'))
          && !canvas.isDrawingMode) {
          window.requestAnimationFrame(() => {
            if (!touchGestureRef.current?.active && !canvas.isDrawingMode) applyCanvasInputMode();
          });
        }
      }
      if (rejectedPointerIdsRef.current.has(event.pointerId)) {
        rejectPointerEvent(event);
        // Keep the id rejected through Fabric's bubbling mouse-up handler. Removing it
        // synchronously lets the same palm-up event finish or split the Pencil stroke.
        window.setTimeout(() => rejectedPointerIdsRef.current.delete(event.pointerId), 0);
      }
      forgetHandoffTouchPointer(event);
      lastBoardInteractionAtRef.current = Date.now();
      if (snapshotCompactionNeededRef.current) schedulePersistence();
    }


    function activateObjectEraserPointer(event) {
      window.clearTimeout(objectEraserDelayTimer);
      objectEraserDelayTimer = null;
      erasingRef.current = true;
      objectEraserRecordsRef.current = new Map();
      objectEraserPendingPatchRects = [];
      if (objectEraserPreviousRenderOnAddRemove == null) {
        objectEraserPreviousRenderOnAddRemove = canvas.renderOnAddRemove;
      }
      // canvas.remove() normally schedules a whole-board render for every erased object.
      // Keep Fabric's automatic add/remove renderer off only for this eraser contact; the
      // cropped compositor below paints the affected pixels directly into the lower canvas.
      canvas.renderOnAddRemove = false;
      canvas.discardActiveObject();
      canvas.cancelRequestedRender?.();
      hardClearPenTransformTop();
      updateSelectionState();
      updateSelectionStyleState();
      objectEraserPointerRef.current = {
        id: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        active: true,
      };
      try { touchTarget.setPointerCapture(event.pointerId); } catch { /* Safari can reject capture. */ }
      eraseAtClientPoint(event.clientX, event.clientY);
    }

    function handleObjectEraserPointerDown(event) {
      if (!canEditRef.current
        || activeToolRef.current !== 'eraser'
        || eraserModeRef.current !== 'object'
        || event.button > 0) return;

      if (event.pointerType === 'touch') {
        activeTouchPointers.add(event.pointerId);
        if (activeTouchPointers.size >= 2) {
          window.clearTimeout(objectEraserDelayTimer);
          objectEraserDelayTimer = null;
          const activePointerId = objectEraserPointerRef.current?.id;
          if (activePointerId != null) {
            try { touchTarget.releasePointerCapture(activePointerId); } catch { /* Ignore. */ }
          }
          if (erasingRef.current) finishObjectEraser();
          objectEraserPointerRef.current = null;
          return;
        }
        objectEraserPointerRef.current = {
          id: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          active: false,
        };
        objectEraserDelayTimer = window.setTimeout(() => {
          if (activeTouchPointers.size === 1 && objectEraserPointerRef.current?.id === event.pointerId) {
            activateObjectEraserPointer(event);
          }
        }, 85);
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
      activateObjectEraserPointer(event);
    }

    function handleObjectEraserPointerMove(event) {
      const pointer = objectEraserPointerRef.current;
      if (!pointer || pointer.id !== event.pointerId) return;
      if (event.pointerType === 'touch' && activeTouchPointers.size >= 2) return;

      if (!pointer.active) {
        const moved = Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY);
        if (moved < 6) return;
        activateObjectEraserPointer(event);
      }

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
      const samples = typeof event.getCoalescedEvents === 'function'
        ? event.getCoalescedEvents()
        : [event];
      for (const sample of samples.length ? samples : [event]) {
        eraseAtClientPoint(sample.clientX, sample.clientY);
      }
    }

    function handleObjectEraserPointerEnd(event) {
      if (event.pointerType === 'touch') activeTouchPointers.delete(event.pointerId);
      const pointer = objectEraserPointerRef.current;
      if (!pointer || pointer.id !== event.pointerId) return;
      window.clearTimeout(objectEraserDelayTimer);
      objectEraserDelayTimer = null;

      if (!pointer.active && activeTouchPointers.size === 0) {
        activateObjectEraserPointer(event);
      }
      if (!erasingRef.current) {
        objectEraserPointerRef.current = null;
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
      try { touchTarget.releasePointerCapture(event.pointerId); } catch { /* Ignore. */ }
      finishObjectEraser();
    }

    function handleDragOver(event) {
      if (!canEditRef.current || !dataTransferMayContainFiles(event.dataTransfer)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    }

    function handleDrop(event) {
      if (!canEditRef.current) return;
      const droppedFiles = droppedFilesFromDataTransfer(event.dataTransfer);
      if (!droppedFiles.length && !dataTransferMayContainFiles(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();

      const files = droppedFiles.filter(isAcceptedImageFile);
      if (!files.length) {
        setSaveStatus('Поддерживаются JPG, PNG, WebP, GIF, HEIC и HEIF');
        setSyncTone('error');
        return;
      }

      const bounds = host.getBoundingClientRect();
      const hasUsableCoordinates = Number.isFinite(event.clientX)
        && Number.isFinite(event.clientY)
        && event.clientX >= bounds.left
        && event.clientX <= bounds.right
        && event.clientY >= bounds.top
        && event.clientY <= bounds.bottom;
      const dropPoint = hasUsableCoordinates
        ? scenePointFromClient(event.clientX, event.clientY)
        : getViewportSceneCenter();
      void addImageFiles(files, dropPoint);
    }

    touchTarget.addEventListener('pointerdown', handlePalmPointerDown, { passive: false, capture: true });
    touchTarget.addEventListener('pointermove', handlePalmPointerMove, { passive: false, capture: true });
    touchTarget.addEventListener('pointerup', handlePalmPointerEnd, { passive: false, capture: true });
    touchTarget.addEventListener('pointercancel', handlePalmPointerEnd, { passive: false, capture: true });
    touchTarget.addEventListener('pointerdown', handleObjectEraserPointerDown, { passive: false, capture: true });
    touchTarget.addEventListener('pointermove', handleObjectEraserPointerMove, { passive: false, capture: true });
    touchTarget.addEventListener('pointerup', handleObjectEraserPointerEnd, { passive: false, capture: true });
    touchTarget.addEventListener('pointercancel', handleObjectEraserPointerEnd, { passive: false, capture: true });
    host.addEventListener('dragenter', handleDragOver);
    host.addEventListener('dragover', handleDragOver);
    host.addEventListener('drop', handleDrop);

    function cancelActiveDrawingForTouchGesture() {
      cancelCreationDraft('touch-gesture');
      const pending = activePencilRef.current;
      if (pending && !pending.mouseReleased) {
        pending.cancelled = true;
        pending.mouseReleased = true;
        pending.releasedAt = Date.now();
        finishLiveDraw('cancel', pending.sessionId);
      }
      liveDrawSendRef.current.acceptingPoints = false;
    }

    function beginTouchGestureCandidate(fingers) {
      const metrics = touchMetrics(fingers, touchTarget);
      const generation = touchGestureGenerationRef.current + 1;
      touchGestureGenerationRef.current = generation;
      touchGestureRef.current = {
        generation,
        fingerIds: fingers.map((touch) => touchId(touch)).filter((identifier) => identifier != null),
        active: false,
        startedAt: performance.now(),
        startDistance: Math.max(metrics.distance, 1),
        startMidpoint: metrics.midpoint,
        startZoom: canvas.getZoom(),
        scenePoint: null,
      };
    }

    function touchEventBelongsToGesture(event, gesture) {
      if (!gesture) return false;
      const changedIds = touchArray(event?.changedTouches)
        .map((touch) => touchId(touch))
        .filter((identifier) => identifier != null);
      if (!changedIds.length) return true;
      const expectedIds = new Set(gesture.fingerIds ?? []);
      return changedIds.some((identifier) => expectedIds.has(identifier));
    }

    function finishTouchGesture(gesture, { restoreInput = true } = {}) {
      if (!gesture || touchGestureRef.current !== gesture) return false;
      touchGestureRef.current = null;
      touchGestureGenerationRef.current = Math.max(
        touchGestureGenerationRef.current,
        Number(gesture.generation ?? 0),
      ) + 1;
      lastTouchGestureEndedAtRef.current = performance.now();
      if (gesture.active && restoreInput) applyCanvasInputMode();
      return Boolean(gesture.active);
    }

    function activateTouchGesture(gesture, event) {
      if (!gesture || gesture.active) return;
      cancelActiveDrawingForTouchGesture();
      abortFabricDrawingForTouchGesture(event);
      const inverse = util.invertTransform(canvas.viewportTransform ?? [1, 0, 0, 1, 0, 0]);
      gesture.scenePoint = util.transformPoint(gesture.startMidpoint, inverse);
      gesture.active = true;
      canvas.isDrawingMode = false;
      canvas.selection = false;
      const hadSelection = Boolean(canvas.getActiveObject());
      if (hadSelection) {
        canvas.discardActiveObject();
        updateSelectionState();
        updateSelectionStyleState();
        canvas.requestRenderAll();
      }
    }

    function shouldSuppressTouchEvent(event, { ending = false } = {}) {
      const now = Date.now();
      const touchPair = eligibleHandoffTouchPair(event);
      if (penInputRef.current.active && touchPair) finishPenForTwoFingerHandoff();
      if (penInputRef.current.active) {
        // IMPORTANT: do not call preventDefault() for the TouchEvent while Pencil is
        // active. On iPadOS Safari the Pencil can be represented in the same touch
        // stream, so cancelling that event cancels Fabric's Pencil stroke as well.
        // Palm pointer events are already rejected separately by handlePalmPointerDown.
        // Here we only keep the gesture recognizer asleep.
        suppressTouchContacts(event.touches);
        suppressTouchContacts(event.changedTouches);
        if (ending) releaseEndedSuppressedTouches(event);
        return true;
      }

      if (now < Number(penInputRef.current.suppressUntil ?? 0)) {
        const graceContacts = [...touchArray(event.touches), ...touchArray(event.changedTouches)];
        const bypassPair = eligibleHandoffTouchPair(event);
        const bypassIds = new Set((bypassPair ?? []).map((touch) => touchId(touch)));
        const palmContacts = graceContacts.filter((touch) => {
          if (isStylusTouch(touch) || bypassIds.has(touchId(touch))) return false;
          return isLikelyPalmTouch(touch);
        });
        if (palmContacts.length) suppressTouchContacts(palmContacts);
      }

      if (touchEventHasSuppressedContact(event)) {
        // As above, suppress only our own two-finger recognizer. Do not cancel the
        // browser touch stream because it may still contain the Pencil contact.
        if (ending) releaseEndedSuppressedTouches(event);
        return true;
      }
      return false;
    }

    function consumeEyedropperStylusTouch(event) {
      if (!eyedropperPenContactRef.current || !findStylusTouch(event)) return false;
      claimStylusTouchEvent(event);
      return true;
    }

    function handleTouchStart(event) {
      if (consumeEyedropperStylusTouch(event)) return;
      if (beginStylusTouchFallback(event)) return;
      if (shouldSuppressTouchEvent(event)) return;
      const fingers = unsuppressedFingerTouches(event.touches);
      if (fingers.length !== event.touches.length) return;

      if (beginMobileGameLibraryTouchStage(event)) {
        rejectTouchEvent(event);
        return;
      }
      if (fingers.length !== 2) return;

      // Arm a real two-finger gesture, but do not immediately disable drawing. It only
      // becomes active after both fingers have remained briefly and moved intentionally.
      rejectTouchEvent(event);
      beginTouchGestureCandidate(fingers);
    }

    function handleTouchMove(event) {
      if (consumeEyedropperStylusTouch(event)) return;
      if (moveStylusTouchFallback(event)) return;
      if (shouldSuppressTouchEvent(event)) return;
      const fingers = unsuppressedFingerTouches(event.touches);
      if (fingers.length !== event.touches.length) return;

      if (moveMobileGameLibraryTouchStage(event)) {
        rejectTouchEvent(event);
        return;
      }
      const gesture = touchGestureRef.current;
      if (!gesture || fingers.length !== 2) return;
      rejectTouchEvent(event);

      const metrics = touchMetrics(fingers, touchTarget);
      if (!gesture.active) {
        const elapsed = performance.now() - Number(gesture.startedAt ?? 0);
        const midpointMovement = Math.hypot(
          metrics.midpoint.x - gesture.startMidpoint.x,
          metrics.midpoint.y - gesture.startMidpoint.y,
        );
        const distanceMovement = Math.abs(metrics.distance - gesture.startDistance);
        if (elapsed < TOUCH_GESTURE_ARM_MS
          || Math.max(midpointMovement, distanceMovement) < TOUCH_GESTURE_MOVE_THRESHOLD) return;
        activateTouchGesture(gesture, event);
      }

      const nextZoom = clamp(
        gesture.startZoom * (metrics.distance / gesture.startDistance),
        MIN_ZOOM,
        MAX_ZOOM,
      );
      const nextViewport = [
        nextZoom,
        0,
        0,
        nextZoom,
        metrics.midpoint.x - gesture.scenePoint.x * nextZoom,
        metrics.midpoint.y - gesture.scenePoint.y * nextZoom,
      ];
      canvas.setViewportTransform(nextViewport);
      setZoom(nextZoom);
      updateBackgroundTransform();
      sendTeacherViewThrottled();
      canvas.requestRenderAll();
    }

    function handleTouchEnd(event) {
      if (consumeEyedropperStylusTouch(event)) return;
      if (finishStylusTouchFallback(event, false)) return;
      if (shouldSuppressTouchEvent(event, { ending: true })) return;
      const gestureAtEventStart = touchGestureRef.current;
      const belongsToCurrentGesture = !gestureAtEventStart
        || touchEventBelongsToGesture(event, gestureAtEventStart);
      const handledSecretGesture = finishMobileGameLibraryTouchStage(event);
      if (handledSecretGesture) {
        rejectTouchEvent(event);
        if (event.touches.length === 0
          && gestureAtEventStart
          && belongsToCurrentGesture) {
          finishTouchGesture(gestureAtEventStart);
        }
        return;
      }

      const gesture = touchGestureRef.current;
      if (!gesture || gesture !== gestureAtEventStart || !belongsToCurrentGesture) return;
      const fingers = unsuppressedFingerTouches(event.touches);
      if (fingers.length >= 2) return;
      rejectTouchEvent(event);
      finishTouchGesture(gesture);
      releaseFabricTouchOwnership(event);
    }

    function handleTouchCancel(event) {
      if (consumeEyedropperStylusTouch(event)) return;
      resetMobileGameLibraryGesture();
      if (finishStylusTouchFallback(event, true)) return;
      if (shouldSuppressTouchEvent(event, { ending: true })) return;
      const gesture = touchGestureRef.current;
      if (gesture && touchEventBelongsToGesture(event, gesture)) finishTouchGesture(gesture);
      rejectTouchEvent(event);
      releaseFabricTouchOwnership(event);
    }

    touchTarget.addEventListener('touchstart', handleTouchStart, { passive: false, capture: true });
    touchTarget.addEventListener('touchmove', handleTouchMove, { passive: false, capture: true });
    touchTarget.addEventListener('touchend', handleTouchEnd, { passive: false, capture: true });
    touchTarget.addEventListener('touchcancel', handleTouchCancel, { passive: false, capture: true });

    function handleContextMenu(event) {
      event.preventDefault();
    }

    function handleWindowBlur() {
      cancelCreationDraft('window-blur');
      selectionDragRef.current = null;
      hideSelectionMarquee();
      finishPenTransformIsolation({ composite: true, scheduleReconcile: false });
      endLiveTransform(liveTransformSendRef.current.pendingTarget ?? canvas.getActiveObject());
      flushDeferredTransformPersistence({ force: true }).catch(() => undefined);
      if (localLockIdsRef.current.length) {
        realtimeRef.current?.sendLock(localLockIdsRef.current, false);
        localLockIdsRef.current = [];
      }
      internalClipboardArmedRef.current = false;
      spacePressedRef.current = false;
      const activeText = canvas.getActiveObject();
      if (activeText instanceof IText && activeText.isEditing) activeText.exitEditing();
      stopArrowPan();
    }

    function handlePaste(event) {
      const target = event.target;
      const isTextInput = target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || target instanceof HTMLSelectElement
        || Boolean(target?.isContentEditable);
      if (!canEditRef.current || isTextInput) return;
      const plainText = normalizePastedPlainText(event.clipboardData?.getData('text/plain') ?? '');
      const activeObject = canvas.getActiveObject();
      const isCanvasTextEditing = activeObject instanceof IText && activeObject.isEditing;

      if (isCanvasTextEditing && plainText) {
        event.preventDefault();
        const start = Number(activeObject.selectionStart ?? activeObject.text?.length ?? 0);
        const end = Number(activeObject.selectionEnd ?? start);
        if (typeof activeObject.insertChars === 'function') {
          activeObject.insertChars(plainText, undefined, start, end);
        } else {
          const current = String(activeObject.text ?? '');
          activeObject.set('text', `${current.slice(0, start)}${plainText}${current.slice(end)}`);
        }
        const cursor = start + plainText.length;
        activeObject.selectionStart = cursor;
        activeObject.selectionEnd = cursor;
        activeObject.dirty = true;
        activeObject.setCoords();
        canvas.fire('text:changed', { target: activeObject });
        canvas.requestRenderAll();
        return;
      }

      if (internalClipboardArmedRef.current && clipboardRef.current.length) {
        event.preventDefault();
        pasteSelection();
        return;
      }

      if (plainText) {
        event.preventDefault();
        insertPastedText(plainText, lastPointerSceneRef.current);
        return;
      }

      // A board-object clipboard lives in IndexedDB, so it survives navigation to a
      // different board even though the React component and in-memory refs were reset.
      event.preventDefault();
      pasteSelection();
    }

    const gameLibrarySequence = ['ArrowRight', 'ArrowLeft', 'ArrowRight', 'ArrowLeft'];
    let gameLibrarySequenceIndex = 0;
    let gameLibrarySequenceStartedAt = 0;

    function handleKeyDown(event) {
      const isShortcut = event.metaKey || event.ctrlKey;
      const target = event.target;
      const isTextInput = target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || target instanceof HTMLSelectElement
        || Boolean(target?.isContentEditable);
      const activeObject = canvas.getActiveObject();
      const isCanvasTextEditing = activeObject instanceof IText && activeObject.isEditing;

      if (isCanvasTextEditing && event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        activeObject.exitEditing?.();
        return;
      }

      if (isOwner && !isTextInput && !isCanvasTextEditing && !event.repeat
        && !isShortcut && !event.altKey && !event.shiftKey) {
        const now = performance.now();
        const isSequenceArrow = event.key === 'ArrowRight' || event.key === 'ArrowLeft';

        if (!isSequenceArrow) {
          gameLibrarySequenceIndex = 0;
          gameLibrarySequenceStartedAt = 0;
        } else {
          if (!gameLibrarySequenceStartedAt || now - gameLibrarySequenceStartedAt > 3000) {
            gameLibrarySequenceIndex = 0;
            gameLibrarySequenceStartedAt = now;
          }

          const expectedKey = gameLibrarySequence[gameLibrarySequenceIndex];
          if (event.key === expectedKey) {
            gameLibrarySequenceIndex += 1;
          } else {
            gameLibrarySequenceIndex = event.key === gameLibrarySequence[0] ? 1 : 0;
            gameLibrarySequenceStartedAt = gameLibrarySequenceIndex ? now : 0;
          }

          if (gameLibrarySequenceIndex === gameLibrarySequence.length) {
            gameLibrarySequenceIndex = 0;
            gameLibrarySequenceStartedAt = 0;
            event.preventDefault();
            event.stopPropagation();
            toggleGameLibraryVisibilityRef.current?.();
            return;
          }
        }
      }

      if (event.code === 'Space' && !event.repeat && !isTextInput && !isCanvasTextEditing) {
        spacePressedRef.current = true;
        event.preventDefault();
      }
      if (!isTextInput && !isCanvasTextEditing
        && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
        event.preventDefault();
        heldArrowKeys.set(event.key, { shiftKey: event.shiftKey });
        startArrowPan();
        return;
      }
      if (!canEditRef.current || isTextInput || isCanvasTextEditing) return;

      if (isShortcut && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (isShortcut && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        redo();
        return;
      }
      if (isShortcut && event.key.toLowerCase() === 'c') {
        event.preventDefault();
        copySelection();
        return;
      }
      if (isShortcut && event.key.toLowerCase() === 'v') {
        // The native paste event carries browser clipboard text. It also falls back
        // to the board's internal object clipboard when Ctrl/Command+C was used here.
        return;
      }
      if (['Delete', 'Backspace'].includes(event.key)
        || ['Delete', 'Backspace'].includes(event.code)) {
        event.preventDefault();
        event.stopPropagation();
        deleteSelection();
        return;
      }
    }

    function handleKeyUp(event) {
      if (event.code === 'Space') spacePressedRef.current = false;
      if (heldArrowKeys.has(event.key)) {
        heldArrowKeys.delete(event.key);
        if (!heldArrowKeys.size) stopArrowPan();
      }
    }

    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('paste', handlePaste);
    window.addEventListener('blur', handleWindowBlur);
    touchTarget.addEventListener('contextmenu', handleContextMenu);

    return () => {
      disposed = true;
      cancelCreationDraft('unmount');
      clearCreationPreview();
      canvas.off('after:render', redrawCreationPreviewAfterCanvasRender);
      cancelCreationDraftRef.current = null;
      window.clearTimeout(textChangeTimerRef.current);
      window.clearTimeout(objectEraserDelayTimer);
      window.clearTimeout(objectEraserRealtimeTimerRef.current);
      objectEraserRealtimeTimerRef.current = null;
      objectEraserRealtimeDeleteIdsRef.current.clear();
      window.clearTimeout(viewSendRef.current.timer);
      if (autopilotAnimationRef.current.frame) {
        window.cancelAnimationFrame(autopilotAnimationRef.current.frame);
        autopilotAnimationRef.current.frame = null;
      }
      autopilotAnimationRef.current.target = null;
      window.clearTimeout(remotePreviewPendingRef.current.timer);
      remotePreviewPendingRef.current.timer = null;
      remotePreviewPendingRef.current.draining = false;
      remotePreviewPendingRef.current.records.clear();
      remotePreviewChunksRef.current.clear();
      stopArrowPan();
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('paste', handlePaste);
      window.removeEventListener('blur', handleWindowBlur);
      touchTarget.removeEventListener('contextmenu', handleContextMenu);
      touchTarget.removeEventListener('pointerdown', handlePalmPointerDown, true);
      touchTarget.removeEventListener('pointermove', handlePalmPointerMove, true);
      touchTarget.removeEventListener('pointerup', handlePalmPointerEnd, true);
      touchTarget.removeEventListener('pointercancel', handlePalmPointerEnd, true);
      touchTarget.removeEventListener('pointerdown', handleObjectEraserPointerDown, true);
      touchTarget.removeEventListener('pointermove', handleObjectEraserPointerMove, true);
      touchTarget.removeEventListener('pointerup', handleObjectEraserPointerEnd, true);
      touchTarget.removeEventListener('pointercancel', handleObjectEraserPointerEnd, true);
      touchTarget.removeEventListener('touchstart', handleTouchStart, true);
      touchTarget.removeEventListener('touchmove', handleTouchMove, true);
      touchTarget.removeEventListener('touchend', handleTouchEnd, true);
      touchTarget.removeEventListener('touchcancel', handleTouchCancel, true);
      host.removeEventListener('dragenter', handleDragOver);
      host.removeEventListener('dragover', handleDragOver);
      host.removeEventListener('drop', handleDrop);
      window.clearInterval(syncInterval);
      window.clearInterval(localLockRefreshInterval);
      window.clearInterval(pendingImageRetryInterval);
      window.clearInterval(lockCleanupInterval);
      window.clearTimeout(cursorSendRef.current.timer);
      window.clearTimeout(liveTransformSendRef.current.timer);
      window.clearTimeout(liveDrawSendRef.current.timer);
      canvas.off('mouse:down:before', restoreSelectionTargetFindBeforeFabricLogic);
      restoreSelectionTargetFind();
      window.clearTimeout(deferredTransformTimer);
      deferredTransformTimer = null;
      deferredTransformEntries.clear();
      deferredTransformFlushRef.current = null;
      finishPenTransformIsolation({ composite: false });
      restorePenTransformRenderMethods();
      restorePenSelectionRenderGuard();
      if (canvas.__alexSelectionMoveTick === broadcastLiveTransform) {
        delete canvas.__alexSelectionMoveTick;
      }
      canvas.off('object:drag', broadcastLiveTransform);
      finishPenTransformIsolationRef.current = null;
      penTransformSpatialApiRef.current = null;
      transformSpatialIndex.cells.clear();
      transformSpatialIndex.globals.clear();
      transformSpatialIndex.entries.clear();
      if (originalCanvasMoveObjectTo) canvas.moveObjectTo = originalCanvasMoveObjectTo;
      window.clearTimeout(selectionStyleRefreshTimerRef.current);
      selectionStyleRefreshTimerRef.current = null;
      if (penTransformTopRefreshFrameRef.current != null) {
        window.cancelAnimationFrame(penTransformTopRefreshFrameRef.current);
        penTransformTopRefreshFrameRef.current = null;
      }
      if (penTransformPendingControlsOverlayRef.current) {
        disposeCroppedRasterLayer(penTransformPendingControlsOverlayRef.current);
        penTransformPendingControlsOverlayRef.current = null;
      }
      if (selectionUiRefreshFrameRef.current != null) {
        window.cancelAnimationFrame(selectionUiRefreshFrameRef.current);
        selectionUiRefreshFrameRef.current = null;
      }
      hideSelectionMarquee();
      pendingPencilQueueRef.current.forEach((pending) => window.clearTimeout(pending.cancelTimer));
      pendingPencilQueueRef.current = [];
      activePencilRef.current = null;
      window.clearTimeout(eyedropperPenContactRef.current?.watchdog);
      eyedropperPenContactRef.current = null;
      eyedropperCompatibilityGuardUntilRef.current = 0;
      stylusTouchFallbackRef.current = {
        active: false,
        touchId: null,
        pointerId: null,
        lastClientX: 0,
        lastClientY: 0,
        guardUntil: 0,
      };
      rejectedPointerIdsRef.current.clear();
      suppressedTouchIdsRef.current.clear();
      handoffTouchPointers.clear();
      touchGestureRef.current = null;
      touchGestureGenerationRef.current = 0;
      lastTouchGestureEndedAtRef.current = 0;
      liveTransformSendRef.current.sessionId = null;
      liveTransformSendRef.current.lastSignature = '';
      liveTransformSendRef.current.pendingTarget = null;
      liveTransformSendRef.current.zIndexMap = null;
      selectionPenSessionRef.current = {
        pointerId: null,
        active: false,
        moveFramePending: false,
        compatibilityGuardUntil: 0,
        generation: 0,
        lastEndedAt: 0,
      };
      transformGestureRef.current = {
        activeId: null,
        lastCommittedId: null,
        signature: '',
        committedAt: 0,
        pointerType: null,
      };
      liveDrawSendRef.current.sessionId = null;
      liveDrawSendRef.current.lastSentPointIndex = 0;
      liveDrawSendRef.current.points = [];
      liveDrawSendRef.current.acceptingPoints = false;
      remoteTransformSessionsRef.current.clear();
      remoteTransformClientOrderRef.current.clear();
      authoritativeObjectStatesRef.current.clear();
      authoritativeSelectionTransactionsRef.current.clear();
      authoritativeBackgroundStateRef.current = { revision: 0, background: 'grid' };
      window.clearTimeout(targetedReconcileStateRef.current.timer);
      targetedReconcileStateRef.current = { pending: new Map(), timer: null, running: false };
      targetedReconcileRunnerRef.current = null;
      remoteDrawSessionsRef.current.clear();
      remoteDeletedObjectIdsRef.current.clear();
      remotePreviewTokensRef.current.clear();
      remoteSelectionTransactionsRef.current.clear();
      const localSelectionTransaction = localSelectionTransactionRef.current;
      if (localSelectionTransaction) {
        realtimeRef.current?.sendSelectionTransaction?.({
          phase: 'cancel',
          transactionId: localSelectionTransaction.transactionId,
          proxyId: localSelectionTransaction.proxyId,
          sourceIds: localSelectionTransaction.sourceIds,
          baseRevision: localSelectionTransaction.baseRevision,
        });
      }
      localSelectionTransactionRef.current = null;
      window.clearTimeout(transientStatusTimerRef.current);
      window.clearTimeout(snapshotPersistTimerRef.current);
      snapshotPersistTimerRef.current = null;
      snapshotPersistRunnerRef.current = null;
      window.removeEventListener('focus', syncOnFocus);
      window.removeEventListener('pageshow', syncOnPageShow);
      window.removeEventListener('pagehide', syncOnPageHide);
      window.removeEventListener('online', syncOnOnline);
      document.removeEventListener('visibilitychange', syncOnVisibility);
      boardReadyRef.current = false;
      pendingGroupTransformCommitRef.current = null;
      if (selectionBoxRef.current) {
        canvas.remove(selectionBoxRef.current);
        selectionBoxRef.current = null;
      }
      restoreSelectionMemberControls();
      if (objectEraserRenderFrameRef.current) {
        window.cancelAnimationFrame(objectEraserRenderFrameRef.current);
        objectEraserRenderFrameRef.current = null;
      }
      objectEraserPendingPatchRects = [];
      restoreObjectEraserRenderMode();
      canvas.off('object:added', handleRegistryObjectAdded);
      canvas.off('object:removed', handleRegistryObjectRemoved);
      canvas.off('before:render', drawBoardBackgroundOnCanvas);
      localDeletionCompositorRef.current = null;
      objectRegistryRef.current.clear();
      creationSessionRegistryRef.current.clear();
      selectionTransactionRegistryRef.current.clear();
      serializedObjectCacheRef.current = new WeakMap();
      selectionVisualSignatureRef.current = '';
      selectionVisualActiveRef.current = null;
      selectionUiTouchedRef.current.clear();
      resizeObserver.disconnect();
      realtimeRef.current?.disconnect();
      realtimeRef.current = null;
      canvas.dispose();
      fabricCanvasRef.current = null;
    };
    // The canvas is intentionally created once for this board session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!isOwner) return undefined;
    const localClientId = String(clientIdRef.current ?? '');
    const hasRemoteParticipant = users.some(
      (user) => String(user?.clientId ?? '') !== localClientId,
    );
    if (!hasRemoteParticipant) return undefined;
    sendTeacherViewNow('view');
    // A low-frequency heartbeat repairs missed viewport packets after a mobile reconnect.
    // Actual panning and zooming are still sent immediately through the throttled path.
    const timer = window.setInterval(() => sendTeacherViewNow('view'), 2500);
    return () => window.clearInterval(timer);
  }, [isOwner, sendTeacherViewNow, users]);

  useEffect(() => {
    if (isOwner || !autopilot) return undefined;
    realtimeRef.current?.requestView?.();
    return undefined;
  }, [autopilot, isOwner, users]);

  useEffect(() => {
    canEditRef.current = canEdit;
    if (!canEdit) {
      cancelCreationDraftRef.current?.('permission-change');
      eyedropperActiveRef.current = false;
      eyedropperModeRef.current = null;
      eyedropperSelectionIdsRef.current = [];
      eyedropperSelectionTransactionIdRef.current = null;
      window.clearTimeout(eyedropperPenContactRef.current?.watchdog);
      eyedropperPenContactRef.current = null;
      eyedropperCompatibilityGuardUntilRef.current = 0;
      setEyedropperActive(false);
      activeToolRef.current = 'select';
      setToolState('select');
    }
    applyObjectInteractivity();
    configureBrushAndMode();
  }, [applyObjectInteractivity, canEdit, configureBrushAndMode]);

  const projectScenePoint = (x, y) => {
    const canvas = fabricCanvasRef.current;
    if (!canvas) return null;
    const point = util.transformPoint(new Point(Number(x), Number(y)), canvas.viewportTransform ?? [1, 0, 0, 1, 0, 0]);
    return { left: point.x, top: point.y };
  };
  // viewportVersion intentionally makes overlays recalculate after zoom and pan.
  void viewportVersion;
  const cursorOverlays = remoteCursors
    .map((cursor) => ({ ...cursor, position: projectScenePoint(cursor.x, cursor.y) }))
    .filter((cursor) => cursor.position);
  const latestLockByClient = new Map();
  remoteLocks.forEach((lock) => {
    const clientKey = String(lock?.clientId ?? '');
    if (!clientKey || Number(lock?.expiresAt ?? 0) <= Date.now()) return;
    const current = latestLockByClient.get(clientKey);
    if (!current || Number(lock.expiresAt ?? 0) >= Number(current.expiresAt ?? 0)) {
      latestLockByClient.set(clientKey, lock);
    }
  });
  const lockOverlays = [...latestLockByClient.values()]
    .map((lock) => {
      const canvas = fabricCanvasRef.current;
      if (!canvas) return null;
      const ids = new Set([
        ...(Array.isArray(lock.objectIds) ? lock.objectIds : []),
        lock.objectId,
      ].filter(Boolean).map(String));

      // A multi-selection is represented remotely by one temporary Fabric group.
      // Anchor one label to that group instead of rendering a label for every child.
      const proxy = canvas.getObjects().find((object) => (
        object.transientSelectionProxy
        && (
          String(object.creationClientId ?? '') === String(lock.clientId ?? '')
          || (Array.isArray(object.selectionSourceIds)
            && object.selectionSourceIds.some((id) => ids.has(String(id))))
        )
      ));
      const objects = proxy
        ? [proxy]
        : canvas.getObjects().filter((object) => ids.has(String(object.boardObjectId ?? '')));
      if (!objects.length) return null;

      const bounds = objects.map((object) => object.getBoundingRect());
      const left = Math.min(...bounds.map((rect) => Number(rect.left ?? 0)));
      const top = Math.min(...bounds.map((rect) => Number(rect.top ?? 0)));
      const right = Math.max(...bounds.map((rect) => Number(rect.left ?? 0) + Number(rect.width ?? 0)));
      const bottom = Math.max(...bounds.map((rect) => Number(rect.top ?? 0) + Number(rect.height ?? 0)));
      return {
        ...lock,
        overlayKey: String(lock.clientId),
        position: projectScenePoint((left + right) / 2, (top + bottom) / 2),
      };
    })
    .filter((lock) => lock?.position);
  const compactKeyboardRows = mobileTextEditor
    ? COMPACT_KEYBOARD_ROWS[mobileTextEditor.layout] ?? COMPACT_KEYBOARD_ROWS.en
    : COMPACT_KEYBOARD_ROWS.en;

  if (fatalError) {
    return <AccessMessage title="Ошибка доски">{fatalError}</AccessMessage>;
  }

  return (
    <main className="board-page">
      <Toolbar
        canEdit={canEdit}
        tool={tool}
        setTool={setTool}
        color={color}
        setColor={setColor}
        opacity={opacity}
        setOpacity={setOpacity}
        width={width}
        setWidth={setWidth}
        eraserMode={eraserMode}
        setEraserMode={setEraserMode}
        eraserWidth={eraserWidth}
        setEraserWidth={setEraserWidth}
        fontFamily={fontFamily}
        setFontFamily={setFontFamily}
        fontSize={fontSize}
        setFontSize={setFontSize}
        background={background}
        setBackground={changeBackground}
        onUndo={undo}
        onRedo={redo}
        canUndo={canUndo}
        canRedo={canRedo}
        onCopy={copySelectionFromToolbar}
        onPaste={() => pasteSelection(toolbarPastePointRef.current)}
        onDelete={deleteSelection}
        onClear={clearBoard}
        onAddShape={chooseShapeTool}
        onAddImages={addImageFiles}
        selectedCount={selectedCount}
        onMoveForward={moveSelectionForward}
        onMoveBackward={moveSelectionBackward}
        onRotateLeft={() => rotateSelection(-90)}
        onRotateRight={() => rotateSelection(90)}
        onFlipHorizontal={() => flipSelection('horizontal')}
        onFlipVertical={() => flipSelection('vertical')}
        zoom={zoom}
        onZoomIn={() => changeZoom(1.2)}
        onZoomOut={() => changeZoom(1 / 1.2)}
        onResetZoom={resetZoom}
        onBringStudents={bringStudentsToTeacher}
        autopilot={autopilot}
        onToggleAutopilot={toggleAutopilot}
        onOpenGames={openGameLibrary}
        gameLibraryVisible={gameLibraryVisible}
        saveStatus={saveStatus}
        syncTone={syncTone}
        pendingCount={pendingCount}
        users={users}
        onExportCurrentPng={exportCurrentPng}
        onExportPng={exportPng}
        onExportPdf={exportPdf}
        onCopyImage={copyBoardImage}
        onShareImage={shareBoardImage}
        onShare={() => setShareOpen(true)}
        isOwner={isOwner}
        selectionStyle={selectionStyle}
        onSelectionColorChange={applySelectionColor}
        onSelectionOpacityChange={applySelectionOpacity}
        onSelectionWidthChange={applySelectionWidth}
        eyedropperActive={eyedropperActive}
        onToggleEyedropper={toggleEyedropper}
      />

      {!isSupabaseConfigured && (
        <div className="local-mode-badge">Локальный тест: синхронизация только между вкладками</div>
      )}

      <section
        className={`canvas-host background-${background}`}
        ref={canvasHostRef}
        aria-label="Онлайн-доска"
      >
        <canvas ref={canvasElementRef} />
        <div
          ref={selectionMarqueeElementRef}
          className="selection-marquee-overlay"
          aria-hidden="true"
        />
        <div className="collaboration-overlay" aria-hidden="true">
          {cursorOverlays.map((cursor) => (
            <div
              className="remote-cursor"
              key={cursor.clientId}
              style={{ left: cursor.position.left, top: cursor.position.top, '--participant-color': cursor.color }}
            >
              <span className="remote-cursor-arrow">➤</span>
              <span className="remote-cursor-name">{cursor.name || 'Участник'}</span>
            </div>
          ))}
          {lockOverlays.map((lock) => (
            <div
              className="remote-lock-label"
              key={lock.overlayKey}
              style={{ left: lock.position.left, top: lock.position.top, '--participant-color': lock.color }}
            >
              Редактирует {lock.name || 'участник'}
            </div>
          ))}
        </div>
      </section>

      {mobileTextEditor && compactKeyboardEnabled && (
        <div
          className="compact-board-keyboard"
          role="application"
          aria-label="Компактная клавиатура доски"
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onContextMenu={(event) => event.preventDefault()}
        >
          <div className="compact-board-keyboard-row compact-board-keyboard-number-row">
            {'1234567890'.split('').map((key) => (
              <button key={key} type="button" onPointerDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                applyCompactKeyboardAction(key);
              }}>{key}</button>
            ))}
            <button type="button" className="keyboard-wide-key" aria-label="Удалить символ" onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              applyCompactKeyboardAction('backspace');
            }}>⌫</button>
          </div>

          {compactKeyboardRows.map((row, rowIndex) => (
            <div className={`compact-board-keyboard-row keyboard-letter-row keyboard-letter-row-${rowIndex + 1}`} key={`${mobileTextEditor.layout}-${rowIndex}`}>
              {row.split('').map((key) => {
                const label = mobileTextEditor.shift
                  ? key.toLocaleUpperCase(mobileTextEditor.layout === 'ru' ? 'ru-RU' : 'en-US')
                  : key;
                return (
                  <button key={key} type="button" onPointerDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    applyCompactKeyboardAction(key);
                  }}>{label}</button>
                );
              })}
            </div>
          ))}

          <div className="compact-board-keyboard-row compact-board-keyboard-symbol-row">
            {COMPACT_KEYBOARD_SYMBOLS.map((key) => (
              <button key={key} type="button" onPointerDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                applyCompactKeyboardAction(key);
              }}>{key}</button>
            ))}
          </div>

          <div className="compact-board-keyboard-row compact-board-keyboard-control-row">
            <button type="button" className="keyboard-control-key" onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              applyCompactKeyboardAction('layout');
            }}>{mobileTextEditor.layout === 'ru' ? 'EN' : 'RU'}</button>
            <button type="button" className={mobileTextEditor.shift ? 'keyboard-control-key selected' : 'keyboard-control-key'} onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              applyCompactKeyboardAction('shift');
            }}>⇧</button>
            <button type="button" className="keyboard-control-key" onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              applyCompactKeyboardAction('left');
            }}>←</button>
            <button type="button" className="keyboard-space-key" onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              applyCompactKeyboardAction('space');
            }}>Пробел</button>
            <button type="button" className="keyboard-control-key" onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              applyCompactKeyboardAction('right');
            }}>→</button>
            <button type="button" className="keyboard-control-key" onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              applyCompactKeyboardAction('enter');
            }}>↵</button>
            <button type="button" className="keyboard-done-key" onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              applyCompactKeyboardAction('close');
            }}>Готово</button>
          </div>
        </div>
      )}

      {shareOpen && isOwner && (
        <ShareDialog
          boardId={boardId}
          ownerKey={boardKey}
          guestMode={guestMode}
          onChangeMode={changeGuestMode}
          onClose={() => setShareOpen(false)}
        />
      )}
    </main>
  );
}
