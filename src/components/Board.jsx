import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActiveSelection,
  Canvas,
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
  applyOpsToSnapshot,
  getBoardAccess,
  getBoardChanges,
  getBoardRecovery,
  getBoardSyncState,
  isSupabaseConfigured,
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
import { randomToken, sha256 } from '../lib/ids.js';
import { rememberOwnedBoard } from '../lib/boardLibrary.js';
import { createShape } from '../lib/shapes.js';
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
const HISTORY_LIMIT = 100;
const LIVE_TRANSFORM_INTERVAL = 50;
const LIVE_TRANSFORM_LOCK_TTL = 7000;
const DESKTOP_WHEEL_ZOOM_SPEED = 6.25;
const VIEW_BROADCAST_INTERVAL = 80;
const INSURANCE_SYNC_INTERVAL = 30_000;
const INSURANCE_SYNC_PAGE_SIZE = 500;
const INTEGRITY_CHECK_INTERVAL = 5 * 60_000;
const LOCAL_LOCK_REFRESH_INTERVAL = 2_500;
const IMAGE_RETRY_INTERVAL = 5_000;
const PENCIL_TOUCH_GRACE_MS = 240;
const TOUCH_GESTURE_ARM_MS = 80;
const TOUCH_GESTURE_MOVE_THRESHOLD = 6;
const PALM_CONTACT_RADIUS = 22;
const PENCIL_GRACE_GESTURE_MAX_RADIUS = 36;
const PENCIL_GRACE_GESTURE_MIN_SEPARATION = 18;

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
];

function getKeyFromUrl() {
  return new URLSearchParams(window.location.search).get('key') ?? '';
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
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
      target.set('strokeWidth', clamp(Math.round(sampled.width), 1, 24));
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

function serializeObject(object) {
  return object.toObject([
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
}

function flattenTarget(target) {
  if (!target) return [];
  if (target.type === 'activeSelection' && typeof target.getObjects === 'function') {
    return target.getObjects();
  }
  return [target];
}

function selectionUiObjects(canvas) {
  if (!canvas) return [];
  const active = canvas.getActiveObject();
  if (active?.transientSelectionProxy && typeof active.getObjects === 'function') {
    return active.getObjects().filter((object) => !object.isEraserPath);
  }
  return canvas.getActiveObjects().filter((object) => !object.isEraserPath);
}

function canvasCanonicalString(canvas, background = 'grid') {
  const objects = canvas?.getObjects?.().filter((object) => (
    !object?.transientPreview && !object?.transientTransformFallback && !object?.transientSelectionProxy
  )) ?? [];
  return `${background}|${objects.map((object, index) => [
    index,
    object?.boardObjectId ?? '',
    object?.updatedAt ?? '',
    object?.type ?? '',
  ].join(':')).join('|')}`;
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

function affectedOperationIds(ops) {
  return new Set((Array.isArray(ops) ? ops : []).map((op) => {
    if (op?.type === 'delete') return String(op.id ?? '');
    if (op?.type === 'upsert') return String(op.object?.boardObjectId ?? '');
    return '';
  }).filter(Boolean));
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

function objectVisuallyIntersectsRect(object, selectionRect) {
  if (!object || object.isEraserPath || object.visible === false || Number(object.opacity ?? 1) <= 0.001) return false;
  const bounds = object.getBoundingRect();
  const intersection = {
    left: Math.max(bounds.left, selectionRect.left),
    top: Math.max(bounds.top, selectionRect.top),
    right: Math.min(bounds.left + bounds.width, selectionRect.right),
    bottom: Math.min(bounds.top + bounds.height, selectionRect.bottom),
  };
  if (intersection.right < intersection.left || intersection.bottom < intersection.top) return false;

  const fullyCovered = selectionRect.left <= bounds.left
    && selectionRect.top <= bounds.top
    && selectionRect.right >= bounds.left + bounds.width
    && selectionRect.bottom >= bounds.top + bounds.height;
  if (fullyCovered && !isImageObject(object)) return true;

  try {
    const longestSide = Math.max(1, bounds.width, bounds.height);
    const multiplier = Math.min(1, 720 / longestSide);
    const rendered = object.toCanvasElement({
      multiplier,
      enableRetinaScaling: false,
      withoutTransform: false,
      withoutShadow: false,
    });
    const context = rendered.getContext('2d', { willReadFrequently: true });
    if (!context || rendered.width < 1 || rendered.height < 1) return false;

    const mapX = (value) => ((value - bounds.left) / Math.max(bounds.width, 0.0001)) * rendered.width;
    const mapY = (value) => ((value - bounds.top) / Math.max(bounds.height, 0.0001)) * rendered.height;
    const x0 = Math.max(0, Math.floor(mapX(intersection.left)) - 1);
    const y0 = Math.max(0, Math.floor(mapY(intersection.top)) - 1);
    const x1 = Math.min(rendered.width, Math.ceil(mapX(intersection.right)) + 1);
    const y1 = Math.min(rendered.height, Math.ceil(mapY(intersection.bottom)) + 1);
    const width = Math.max(1, x1 - x0);
    const height = Math.max(1, y1 - y0);
    const pixels = context.getImageData(x0, y0, width, height).data;
    const stride = pixels.length > 900_000 ? 12 : pixels.length > 300_000 ? 8 : 4;
    for (let index = 3; index < pixels.length; index += stride) {
      if (pixels[index] > 10) return true;
    }
    return false;
  } catch (error) {
    console.warn('Точная проверка рамочного выделения недоступна', error);
    try {
      return object.intersectsWithRect(
        new Point(selectionRect.left, selectionRect.top),
        new Point(selectionRect.right, selectionRect.bottom),
      );
    } catch {
      return false;
    }
  }
}


export default function Board({ boardId }) {
  const boardKey = useMemo(getKeyFromUrl, []);
  const [workspaceMode, setWorkspaceMode] = useState('board');
  const participantClientIdRef = useRef(randomToken(10));
  const [access, setAccess] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [guestName, setGuestName] = useState('');

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!boardKey) {
        setError('В ссылке отсутствует ключ доступа.');
        setLoading(false);
        return;
      }
      try {
        const result = await getBoardAccess(boardId, boardKey);
        if (result?.permission === 'owner') {
          rememberOwnedBoard({
            boardId,
            ownerKey: boardKey,
            title: result.title,
            studentName: result.studentName ?? '',
          });
        }
        if (!cancelled) {
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
  }, [boardId, boardKey]);

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
  const erasingRef = useRef(false);
  const objectEraserRecordsRef = useRef(new Map());
  const objectEraserRealtimeDeleteIdsRef = useRef(new Set());
  const objectEraserRealtimeTimerRef = useRef(null);
  const modifiedBeforeRef = useRef([]);
  const clipboardRef = useRef([]);
  const clipboardCenterRef = useRef(null);
  const clipboardSourceBoardIdRef = useRef(null);
  const mobilePasteAwaitingPointRef = useRef(false);
  const revisionRef = useRef(Number(initialAccess.snapshotRevision ?? initialAccess.revision ?? 0));
  const pendingServerWritesRef = useRef(0);
  const syncRequestedRef = useRef(false);
  const syncForceRef = useRef(false);
  const syncInFlightRef = useRef(false);
  const authoritativeApplyQueueRef = useRef(Promise.resolve());
  const applyRemoteOpsRef = useRef(null);
  const lastIntegrityCheckRef = useRef(0);
  const pendingImageRetryInFlightRef = useRef(false);
  const remoteTransformApplyQueueRef = useRef(Promise.resolve());
  const selectionMemberControlsRef = useRef(new Map());
  const boardReadyRef = useRef(false);
  const activeToolRef = useRef('pencil');
  const canEditRef = useRef(initialAccess.permission === 'owner' || initialAccess.permission === 'edit');
  const colorRef = useRef('#111827');
  const opacityRef = useRef(1);
  const widthRef = useRef(3);
  const eyedropperActiveRef = useRef(false);
  const eyedropperModeRef = useRef(null);
  const eyedropperSelectionIdsRef = useRef([]);
  const eyedropperSelectionTransactionIdRef = useRef(null);
  const eraserModeRef = useRef('partial');
  const eraserWidthRef = useRef(28);
  const fontFamilyRef = useRef('Arial');
  const fontSizeRef = useRef(34);
  const textBeforeRef = useRef(new Map());
  const textChangeTimerRef = useRef(null);
  const objectEraserPointerRef = useRef(null);
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
  });
  const remoteTransformSessionsRef = useRef(new Map());
  const remoteTransformClientOrderRef = useRef(new Map());
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
    suppressUntil: 0,
  });
  const rejectedPointerIdsRef = useRef(new Set());
  const suppressedTouchIdsRef = useRef(new Set());
  const pencilGraceGestureTouchIdsRef = useRef(new Set());
  const viewSendRef = useRef({ lastSentAt: 0, timer: null, pending: false });
  const lastTeacherViewRef = useRef(null);
  const autopilotRef = useRef(false);

  const [permission, setPermission] = useState(initialAccess.permission);
  const [guestMode, setGuestModeState] = useState(initialAccess.guestMode);
  const [tool, setToolState] = useState(initialAccess.permission === 'view' ? 'select' : 'pencil');
  const [color, setColorState] = useState('#111827');
  const [opacity, setOpacityState] = useState(1);
  const [width, setWidthState] = useState(3);
  const [eyedropperActive, setEyedropperActive] = useState(false);
  const [eraserMode, setEraserModeState] = useState('partial');
  const [eraserWidth, setEraserWidthState] = useState(28);
  const [fontFamily, setFontFamilyState] = useState('Arial');
  const [fontSize, setFontSizeState] = useState(34);
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
    if (!object.boardObjectId) object.boardObjectId = randomToken(10);
    object.updatedAt = Date.now();
    object.updatedBy = clientId;
    object.setCoords();
    return object;
  }, []);

  const getObjectRecords = useCallback((objects) => {
    const canvas = fabricCanvasRef.current;
    if (!canvas) return [];
    return objects.map((object) => ({
      object: serializeObject(object),
      zIndex: canvas.getObjects().indexOf(object),
    }));
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

  // 0.9.7: every completed edit is already persisted as one durable operation by
  // realtime.sendOps/sendSettings. This compatibility callback intentionally does
  // nothing, so ordinary tools never call canvas.toJSON() or rewrite a full local board.
  const schedulePersistence = useCallback(() => {}, []);

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

  const applyObjectInteractivity = useCallback(() => {
    const canvas = fabricCanvasRef.current;
    if (!canvas) return;
    const selectionEyedropper = eyedropperActiveRef.current
      && eyedropperModeRef.current === 'selection';
    const selectable = canEditRef.current
      && activeToolRef.current === 'select'
      && !eyedropperActiveRef.current;
    const textToolActive = canEditRef.current
      && activeToolRef.current === 'text'
      && !eyedropperActiveRef.current;
    const objectEraser = canEditRef.current
      && activeToolRef.current === 'eraser'
      && eraserModeRef.current === 'object';

    // Marquee selection is implemented by our own geometry-aware selector below.
    // Keeping Fabric's native marquee enabled creates a second ActiveSelection at the
    // same time, which was the source of the first-transform duplication bug.
    canvas.selection = false;
    const drawingToolActive = canEditRef.current
      && (['pencil', 'line', 'shape'].includes(activeToolRef.current)
        || (activeToolRef.current === 'eraser' && eraserModeRef.current === 'partial'))
      && !eyedropperActiveRef.current;
    // Pixel-perfect target testing is expensive on a lesson made of thousands of
    // handwritten paths. Enable it only for the object eraser; normal selection and
    // text use Fabric bounds while drawing skips hit-testing completely.
    canvas.perPixelTargetFind = objectEraser;
    canvas.skipTargetFind = eyedropperActiveRef.current || drawingToolActive;
    const now = Date.now();
    for (const [objectId, lock] of remoteLocksRef.current) {
      if (Number(lock.expiresAt ?? 0) <= now) remoteLocksRef.current.delete(objectId);
    }
    const activeSelection = canvas.getActiveObject();
    const activeSelectionMembers = activeSelection?.type === 'activeSelection'
      && typeof activeSelection.getObjects === 'function'
      ? new Set(activeSelection.getObjects())
      : new Set();
    for (const object of canvas.getObjects()) {
      const remoteLock = object.boardObjectId ? remoteLocksRef.current.get(object.boardObjectId) : null;
      const lockedByOther = Boolean(remoteLock && Number(remoteLock.expiresAt ?? 0) > now);
      const isLocalSelectionProxy = Boolean(
        object.transientSelectionProxy
        && object.creationClientId === clientIdRef.current
        && localSelectionTransactionRef.current?.proxy === object
      );
      const canSelectObject = isLocalSelectionProxy
        || (selectable && !object.isEraserPath && !object.transientPreview && !object.transientSelectionProxy && !lockedByOther);
      const isActiveSelectionMember = activeSelectionMembers.has(object);
      const canEditTextHere = textToolActive
        && isTextObject(object)
        && !object.transientPreview
        && !object.transientSelectionProxy
        && !lockedByOther;
      object.selectable = canSelectObject || canEditTextHere;
      object.evented = canSelectObject
        || canEditTextHere
        || (objectEraser && !object.isEraserPath && !object.transientPreview && !object.transientSelectionProxy && !lockedByOther);
      object.hasControls = canSelectObject && !isActiveSelectionMember;
      object.hasBorders = canSelectObject && !isActiveSelectionMember;
      object.hoverCursor = lockedByOther ? 'not-allowed' : (canEditTextHere ? 'text' : 'move');
    }
    if (!selectable && !selectionEyedropper && !textToolActive) canvas.discardActiveObject();
    canvas.requestRenderAll();
  }, []);

  const restoreSelectionMemberControls = useCallback((keep = new Set()) => {
    for (const [object, state] of selectionMemberControlsRef.current) {
      if (keep.has(object)) continue;
      if (state.hadOwnRenderControls) object._renderControls = state.renderControls;
      else delete object._renderControls;
      if (state.hadOwnDrawBorders) object.drawBorders = state.drawBorders;
      else delete object.drawBorders;
      if (state.hadOwnDrawControls) object.drawControls = state.drawControls;
      else delete object.drawControls;
      selectionMemberControlsRef.current.delete(object);
    }
  }, []);

  const updateSelectionVisuals = useCallback(() => {
    const canvas = fabricCanvasRef.current;
    if (!canvas) return;
    const active = canvas.getActiveObject();
    const members = active?.type === 'activeSelection' && typeof active.getObjects === 'function'
      ? active.getObjects()
      : [];
    const memberSet = new Set(members);
    restoreSelectionMemberControls(memberSet);

    if (members.length > 1) {
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
      // Fabric's ActiveSelection renders controls for every child. Bypass that
      // implementation and call the base object renderer once for the outer frame.
      const outerRenderer = FabricObject.prototype._renderControls;
      if (typeof outerRenderer === 'function') {
        active._renderControls = function renderOnlyOuterSelection(ctx, styleOverride) {
          return outerRenderer.call(this, ctx, styleOverride);
        };
      }
      active.set({
        hasControls: true,
        hasBorders: true,
        subTargetCheck: false,
        objectCaching: false,
      });
      active.setCoords();
    }
    canvas.requestRenderAll();
  }, [restoreSelectionMemberControls]);

  const applyCanvasInputMode = useCallback(() => {
    const canvas = fabricCanvasRef.current;
    if (!canvas) return;
    const partialEraser = activeToolRef.current === 'eraser' && eraserModeRef.current === 'partial';
    const objectEraser = activeToolRef.current === 'eraser' && eraserModeRef.current === 'object';
    const shouldDraw = canEditRef.current
      && !eyedropperActiveRef.current
      && (activeToolRef.current === 'pencil' || partialEraser);
    const drawingToolActive = canEditRef.current
      && (['pencil', 'line', 'shape'].includes(activeToolRef.current) || partialEraser)
      && !eyedropperActiveRef.current;

    // This is the lightweight input-mode restoration used after pinch/pan. It must
    // stay O(1): no object enumeration, no selection rebuild and no render request.
    canvas.isDrawingMode = shouldDraw;
    canvas.selection = false;
    canvas.perPixelTargetFind = objectEraser;
    canvas.skipTargetFind = eyedropperActiveRef.current || drawingToolActive;

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
    applyObjectInteractivity();
  }, [applyCanvasInputMode, applyObjectInteractivity]);

  const setTool = useCallback((nextTool) => {
    if (!canEditRef.current) return;
    if (eyedropperActiveRef.current && nextTool !== activeToolRef.current) {
      eyedropperActiveRef.current = false;
      eyedropperModeRef.current = null;
      eyedropperSelectionIdsRef.current = [];
      eyedropperSelectionTransactionIdRef.current = null;
      setEyedropperActive(false);
    }
    if (nextTool !== 'shape') selectedShapeRef.current = null;
    activeToolRef.current = nextTool;
    setToolState(nextTool);
    configureBrushAndMode();
  }, [configureBrushAndMode]);

  const setColor = useCallback((nextColor) => {
    colorRef.current = nextColor;
    setColorState(nextColor);
    configureBrushAndMode();
  }, [configureBrushAndMode]);

  const setOpacity = useCallback((nextOpacity) => {
    opacityRef.current = nextOpacity;
    setOpacityState(nextOpacity);
    configureBrushAndMode();
  }, [configureBrushAndMode]);

  const setWidth = useCallback((nextWidth) => {
    widthRef.current = nextWidth;
    setWidthState(nextWidth);
    configureBrushAndMode();
  }, [configureBrushAndMode]);

  const toggleEyedropper = useCallback(() => {
    if (!canEditRef.current) return;
    const canvas = fabricCanvasRef.current;
    const drawingMode = ['pencil', 'line'].includes(activeToolRef.current);
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

  const sendRecordUpserts = useCallback((records, { restore = false, reorder = false } = {}) => {
    if (!records.length || !realtimeRef.current) return Promise.resolve(null);
    return realtimeRef.current.sendOps(records.map((record) => ({
      type: 'upsert',
      object: record.object,
      zIndex: record.zIndex,
      restore,
      reorder,
    })));
  }, []);

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

  const sendDeletes = useCallback((ids, { announce = true } = {}) => {
    const safeIds = [...new Set((Array.isArray(ids) ? ids : []).filter(Boolean).map(String))];
    const realtime = realtimeRef.current;
    if (!safeIds.length || !realtime) return Promise.resolve(null);
    if (announce) realtime.sendDeletePreview?.(safeIds).catch?.(() => undefined);
    return realtime.sendOps(safeIds.map((id) => ({ type: 'delete', id })));
  }, []);


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
      };
      localSelectionTransactionRef.current = transaction;
      canvas.setActiveObject(proxy);
      applyingRemoteRef.current = false;
      applyObjectInteractivity();
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
    applyObjectInteractivity,
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
      });
      const ops = finalRecords.map((record) => ({
        type: 'upsert',
        object: record.object,
        zIndex: record.zIndex,
      }));
      const commitResult = await realtimeRef.current?.sendOps?.(ops);
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
      applyObjectInteractivity();
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
    getObjectRecords,
    recordAction,
    schedulePersistence,
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
      force: kind === 'jump',
      jumpId: kind === 'jump' ? randomToken(8) : undefined,
    };
    if (kind === 'jump') realtime.sendViewJump?.(payload);
    else realtime.sendView?.(payload);
  }, [getViewportSceneCenter, isOwner]);

  const sendTeacherViewThrottled = useCallback(() => {
    if (!isOwner || !autopilotRef.current) return;
    const state = viewSendRef.current;
    state.pending = true;
    const elapsed = Date.now() - state.lastSentAt;
    const send = () => {
      state.timer = null;
      if (!state.pending || !autopilotRef.current) return;
      state.pending = false;
      state.lastSentAt = Date.now();
      sendTeacherViewNow('view');
    };
    if (elapsed >= VIEW_BROADCAST_INTERVAL) send();
    else if (!state.timer) state.timer = window.setTimeout(send, VIEW_BROADCAST_INTERVAL - elapsed);
  }, [isOwner, sendTeacherViewNow]);

  const handleRemoteView = useCallback((message) => {
    if (isOwner || message?.permission !== 'owner') return;
    if (!Number.isFinite(Number(message?.centerX)) || !Number.isFinite(Number(message?.centerY))) return;
    lastTeacherViewRef.current = message;
    if (autopilotRef.current) centerViewportAt(message.centerX, message.centerY, message.zoom);
  }, [centerViewportAt, isOwner]);

  const handleRemoteViewJump = useCallback((message) => {
    if (isOwner) return;
    if (!Number.isFinite(Number(message?.centerX)) || !Number.isFinite(Number(message?.centerY))) return;
    // `force` is set only by the owner-facing “Ко мне” action. Accept it even if an
    // older connection reported the owner role as edit/view, which previously made
    // the button silently do nothing for every student.
    if (message?.permission !== 'owner' && message?.force !== true) return;
    lastTeacherViewRef.current = message;
    centerViewportAt(message.centerX, message.centerY, message.zoom);
  }, [centerViewportAt, isOwner]);

  const handleRemoteViewRequest = useCallback(() => {
    if (isOwner) sendTeacherViewNow('view');
  }, [isOwner, sendTeacherViewNow]);

  const toggleAutopilot = useCallback(() => {
    const next = !autopilotRef.current;
    autopilotRef.current = next;
    setAutopilot(next);
    if (!next) {
      window.clearTimeout(viewSendRef.current.timer);
      viewSendRef.current.timer = null;
      viewSendRef.current.pending = false;
    }
    if (next) {
      if (isOwner) sendTeacherViewNow('view');
      else if (lastTeacherViewRef.current) {
        centerViewportAt(lastTeacherViewRef.current.centerX, lastTeacherViewRef.current.centerY, lastTeacherViewRef.current.zoom);
      }
      realtimeRef.current?.requestView?.();
    }
  }, [centerViewportAt, isOwner, sendTeacherViewNow]);

  const bringStudentsToTeacher = useCallback(() => {
    if (isOwner) sendTeacherViewNow('jump');
  }, [isOwner, sendTeacherViewNow]);

  const chooseShapeTool = useCallback((shapeId) => {
    if (!shapeId || !canEditRef.current) return;
    selectedShapeRef.current = shapeId;
    activeToolRef.current = 'shape';
    setToolState('shape');
    setSaveStatus('Фигура выбрана — протяните её мышкой или пальцем');
    configureBrushAndMode();
  }, [configureBrushAndMode]);


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
      // Publish a lightweight placeholder first. Other devices see that the
      // image is being prepared instead of an unexplained empty area.
      // eslint-disable-next-line no-await-in-loop
      await sendRecordUpserts(placeholderRecord);

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
        // eslint-disable-next-line no-await-in-loop
        await sendDeletes([placeholder.boardObjectId]);
        failedMessages.push(caught instanceof Error ? caught.message : `Не удалось добавить ${file.name}`);
      }
    }

    activeToolRef.current = 'select';
    setToolState('select');
    configureBrushAndMode();
    canvas.discardActiveObject();
    if (completed.length === 1) canvas.setActiveObject(completed[0]);
    else if (completed.length > 1) canvas.setActiveObject(createOuterOnlyActiveSelection(completed, canvas));
    updateSelectionState();
    updateSelectionStyleState();
    canvas.requestRenderAll();

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
    const before = getObjectRecords(objects);
    mutator(objects, canvas);
    objects.forEach((object) => markObject(object, clientIdRef.current));
    const after = getObjectRecords(objects);
    // Discrete toolbar transforms are shown through Ably immediately. The same final
    // state is still persisted through Supabase, but the observer no longer waits for
    // the server commit or for the selection to be cleared.
    publishOperation(objects);
    const reorder = realtimeOperation?.operation === 'layer';
    sendRecordUpserts(after, { reorder });
    recordAction({ type: 'modify', before, after, reorder });
    schedulePersistence();
    canvas.requestRenderAll();
    updateSelectionState();
    updateSelectionStyleState();
  }, [getObjectRecords, markObject, recordAction, schedulePersistence, sendRecordUpserts, updateSelectionState, updateSelectionStyleState]);

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
    const idSet = new Set(ids);
    const objects = canvas.getObjects().filter((object) => idSet.has(object.boardObjectId) && !object.isEraserPath);
    if (!objects.length) return [];

    const beforeRecords = getObjectRecords(objects);
    const beforeById = new Map(beforeRecords.map((record) => [record.object?.boardObjectId, record]));
    const changedObjects = objects.filter((object) => applySampledStyleToObject(object, sampled, { colorOnly }));
    if (!changedObjects.length) return [];

    const before = changedObjects
      .map((object) => beforeById.get(object.boardObjectId))
      .filter(Boolean);
    changedObjects.forEach((object) => markObject(object, clientIdRef.current));
    const after = getObjectRecords(changedObjects);
    sendRecordUpserts(after);
    recordAction({ type: 'modify', before, after });
    schedulePersistence();
    canvas.requestRenderAll();
    return objects;
  }, [getObjectRecords, markObject, recordAction, schedulePersistence, sendRecordUpserts]);

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
    if (!canvas || !records.length) return;
    for (const record of records) {
      const id = record.object?.boardObjectId;
      if (!id) continue;
      removeBoardObjectsById(canvas, id);
      await preloadSerializedImages(record.object);
      const [revived] = await util.enlivenObjects([record.object]);
      if (!revived) continue;
      revived.selectable = false;
      revived.evented = false;
      revived.hasControls = false;
      canvas.add(revived);
      if (Number.isInteger(record.zIndex) && typeof canvas.moveObjectTo === 'function') {
        canvas.moveObjectTo(revived, clamp(record.zIndex, 0, canvas.getObjects().length - 1));
      }
    }
    applyObjectInteractivity();
    canvas.requestRenderAll();
    updateSelectionState();
    updateSelectionStyleState();
  }, [applyObjectInteractivity, updateSelectionState, updateSelectionStyleState]);

  const removeIdsLocally = useCallback((ids) => {
    const canvas = fabricCanvasRef.current;
    if (!canvas) return;
    for (const id of ids) removeBoardObjectsById(canvas, id);
    canvas.discardActiveObject();
    canvas.requestRenderAll();
    updateSelectionState();
    updateSelectionStyleState();
  }, [updateSelectionState, updateSelectionStyleState]);

  const applyBackground = useCallback((nextBackground, { broadcast = false, persist = false } = {}) => {
    if (!BACKGROUNDS.has(nextBackground)) return;
    backgroundRef.current = nextBackground;
    setBackgroundState(nextBackground);
    updateBackgroundTransform();
    if (broadcast) realtimeRef.current?.sendSettings({ background: nextBackground });
    if (persist) schedulePersistence();
  }, [schedulePersistence, updateBackgroundTransform]);

  const changeBackground = useCallback((nextBackground) => {
    if (!isOwner || !BACKGROUNDS.has(nextBackground) || nextBackground === backgroundRef.current) return;
    const before = backgroundRef.current;
    applyBackground(nextBackground, { broadcast: true, persist: true });
    recordAction({ type: 'background', before, after: nextBackground });
  }, [applyBackground, isOwner, recordAction]);

  const getLocalMutationIds = useCallback(() => {
    const ids = new Set((localLockIdsRef.current ?? []).filter(Boolean).map(String));
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
    try {
      for (const placeholder of pending) {
        const serialized = placeholder.pendingImageSerialized;
        const objectId = String(placeholder.boardObjectId ?? '');
        if (!serialized || !objectId || getLocalMutationIds().has(objectId)) continue;
        try {
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
        const effectiveSnapshot = protectedDeletedIds.size
          ? {
            ...snapshot,
            canvas: {
              ...snapshot.canvas,
              objects: (snapshot.canvas.objects ?? []).filter((object) => (
                !protectedDeletedIds.has(String(object?.boardObjectId ?? ''))
              )),
            },
          }
          : snapshot;

        applyingRemoteRef.current = true;
        try {
          await preloadSerializedImages(effectiveSnapshot.canvas);
          await canvas.loadFromJSON(effectiveSnapshot.canvas);
          deduplicateBoardObjects(canvas);
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
        } finally {
          applyingRemoteRef.current = false;
        }
      });

    authoritativeApplyQueueRef.current = task;
    return task;
  }, [
    applyBackground,
    applyObjectInteractivity,
    boardId,
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

    const recoverFromSnapshot = async (reason) => {
      if (pendingServerWritesRef.current > 0 || getLocalMutationIds().size > 0) {
        // Do not spin synchronously while the user is holding or editing an object.
        // A delayed retry preserves the local gesture and keeps later revisions ordered.
        syncRequestedRef.current = false;
        syncForceRef.current = false;
        window.setTimeout(() => syncFromServer(true), 600);
        return false;
      }
      console.warn('Operation sync fallback to snapshot:', reason);
      const recovery = await getBoardRecovery(boardId, boardKey);
      if (!recovery?.snapshot) return false;
      await applyAuthoritativeSnapshot(recovery.snapshot, Number(recovery.revision ?? 0));
      lastIntegrityCheckRef.current = Date.now();
      return true;
    };

    try {
      let serverState = await getBoardSyncState(boardId, boardKey);
      if (!serverState) return;
      let serverRevision = Number(serverState.revision ?? 0);
      let currentRevision = Number(revisionRef.current ?? 0);

      if (serverRevision < currentRevision) {
        const recovered = await recoverFromSnapshot('server revision is behind local revision');
        if (!recovered) return;
        currentRevision = Number(revisionRef.current ?? 0);
        serverState = await getBoardSyncState(boardId, boardKey);
        serverRevision = Number(serverState?.revision ?? currentRevision);
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
          // The 0.9.5 SQL was not installed. Older servers can only recover by snapshot.
          // eslint-disable-next-line no-await-in-loop
          if (!await recoverFromSnapshot('operation journal RPC is unavailable')) return;
          currentRevision = Number(revisionRef.current ?? 0);
          break;
        }
        if (!changes.length) {
          // eslint-disable-next-line no-await-in-loop
          if (!await recoverFromSnapshot('journal has a revision gap')) return;
          currentRevision = Number(revisionRef.current ?? 0);
          break;
        }

        let progressed = false;
        for (const action of changes) {
          const actionRevision = Number(action?.revision ?? 0);
          if (actionRevision <= currentRevision) continue;
          if (actionRevision !== currentRevision + 1) {
            // eslint-disable-next-line no-await-in-loop
            if (!await recoverFromSnapshot(`expected revision ${currentRevision + 1}, received ${actionRevision}`)) return;
            currentRevision = Number(revisionRef.current ?? 0);
            progressed = true;
            break;
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
          // eslint-disable-next-line no-await-in-loop
          if (!await recoverFromSnapshot('journal page made no progress')) return;
          currentRevision = Number(revisionRef.current ?? 0);
          break;
        }

        // A concurrent participant can append revisions while this page is applying.
        // Refresh the target after every short/final page instead of guessing its end.
        if (changes.length < INSURANCE_SYNC_PAGE_SIZE || currentRevision >= serverRevision) {
          // eslint-disable-next-line no-await-in-loop
          serverState = await getBoardSyncState(boardId, boardKey);
          serverRevision = Number(serverState?.revision ?? currentRevision);
        }
      }

      const hasPendingServerImage = fabricCanvasRef.current?.getObjects()
        .some((object) => Boolean(object.pendingImageSerialized));
      const integrityDue = !hasPendingServerImage
        && Date.now() - Number(lastIntegrityCheckRef.current ?? 0) >= INTEGRITY_CHECK_INTERVAL;
      if (serverRevision === Number(revisionRef.current ?? 0) && integrityDue) {
        lastIntegrityCheckRef.current = Date.now();
        const canvas = fabricCanvasRef.current;
        const localObjects = canvas?.getObjects?.().filter((object) => (
          !object?.transientPreview && !object?.transientTransformFallback && !object?.transientSelectionProxy
        )) ?? [];
        const localCount = localObjects.length;
        const localHash = serverState?.stateHash
          ? await sha256(canvasCanonicalString(canvas, backgroundRef.current))
          : null;
        const stateMismatch = serverState?.objectCount !== null
          && (Number(serverState.objectCount) !== Number(localCount)
            || (serverState.stateHash && localHash !== serverState.stateHash));
        if (stateMismatch && !await recoverFromSnapshot('integrity hash mismatch')) return;
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
  ]);

  const recoverRejectedServerAction = useCallback(async () => {
    const realtime = realtimeRef.current;
    realtime?.pauseWrites?.();
    setSaveStatus('Сервер отклонил конфликтующее действие — восстанавливаю доску…');
    setSyncTone('recovering');
    try {
      // Do not replace an object underneath an active local gesture. Remaining pending
      // actions stay paused and are rebased after the gesture is released.
      while (getLocalMutationIds().size > 0) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => window.setTimeout(resolve, 250));
      }
      const recovery = await getBoardRecovery(boardId, boardKey);
      if (!recovery?.snapshot) throw new Error('Серверный снимок недоступен');
      const pendingActions = await realtime?.getPendingActions?.();
      let rebasedSnapshot = recovery.snapshot;
      for (const pendingAction of Array.isArray(pendingActions) ? pendingActions : []) {
        rebasedSnapshot = applyOpsToSnapshot(
          rebasedSnapshot,
          pendingAction?.ops ?? [],
          pendingAction?.background ?? null,
        );
      }
      await applyAuthoritativeSnapshot(
        rebasedSnapshot,
        Number(recovery.revision ?? 0),
      );
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
      realtime?.resumeWrites?.();
    }
  }, [applyAuthoritativeSnapshot, boardId, boardKey, getLocalMutationIds]);

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
        if (existingState?.phase === 'authoritative') return;
        if (['commit', 'awaiting-authoritative', 'commit-ready'].includes(existingState?.phase) && phase === 'start') return;
        applyingRemoteRef.current = true;
        const previousRenderOnAddRemove = canvas.renderOnAddRemove;
        canvas.renderOnAddRemove = false;
        try {
          if (phase === 'start') {
            const proxyId = String(message?.proxyId ?? `selection-proxy:${transactionId}`);
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
                .map((id) => canvas.getObjects().find((object) => String(object.boardObjectId ?? '') === id))
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
            removeSelectionTransactionObjects(canvas, transactionId);
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
              removeSelectionTransactionObjects(canvas, transactionId);
              remoteSelectionTransactionsRef.current.delete(transactionId);
              window.setTimeout(() => syncFromServer(true), 40);
            }
          }
        } finally {
          applyingRemoteRef.current = false;
          canvas.renderOnAddRemove = previousRenderOnAddRemove;
          applyObjectInteractivity();
          canvas.requestRenderAll();
        }
      });
    authoritativeApplyQueueRef.current = task.catch((error) => {
      console.warn('Не удалось обработать временное групповое выделение', error);
      window.setTimeout(() => syncFromServer(true), 120);
    });
  }, [applyObjectInteractivity, syncFromServer]);

  const applyHistoryAction = useCallback(async (action, direction) => {
    if (!action) return;
    applyingHistoryRef.current = true;
    applyingRemoteRef.current = true;
    try {
      if (action.type === 'add') {
        if (direction === 'undo') {
          const ids = action.records.map((record) => record.object.boardObjectId).filter(Boolean);
          removeIdsLocally(ids);
          sendDeletes(ids);
        } else {
          await applyRecordsLocally(action.records);
          sendRecordUpserts(action.records, { restore: true, reorder: true });
        }
      }

      if (action.type === 'delete') {
        if (direction === 'undo') {
          await applyRecordsLocally(action.records);
          sendRecordUpserts(action.records, { restore: true, reorder: true });
        } else {
          const ids = action.records.map((record) => record.object.boardObjectId).filter(Boolean);
          removeIdsLocally(ids);
          sendDeletes(ids);
        }
      }

      if (action.type === 'modify') {
        const records = direction === 'undo' ? action.before : action.after;
        await applyRecordsLocally(records);
        sendRecordUpserts(records, { reorder: Boolean(action.reorder) });
      }

      if (action.type === 'replace') {
        const removeRecords = direction === 'undo' ? action.after : action.before;
        const restoreRecords = direction === 'undo' ? action.before : action.after;
        const removeIds = removeRecords
          .map((record) => record.object?.boardObjectId)
          .filter(Boolean);
        removeIdsLocally(removeIds);
        await applyRecordsLocally(restoreRecords);
        realtimeRef.current?.sendOps?.([
          ...removeIds.map((id) => ({ type: 'delete', id })),
          ...restoreRecords.map((record) => ({
            type: 'upsert',
            object: record.object,
            zIndex: record.zIndex,
            restore: true,
            reorder: true,
          })),
        ]);
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
      applyObjectInteractivity();
      schedulePersistence();
    }
  }, [
    applyBackground,
    applyObjectInteractivity,
    applyRecordsLocally,
    removeIdsLocally,
    schedulePersistence,
    sendDeletes,
    sendRecordUpserts,
  ]);

  const undo = useCallback(async () => {
    if (!canEditRef.current || !undoStackRef.current.length) return;
    const action = undoStackRef.current.pop();
    redoStackRef.current.push(action);
    updateHistoryButtons();
    await applyHistoryAction(action, 'undo');
  }, [applyHistoryAction, updateHistoryButtons]);

  const redo = useCallback(async () => {
    if (!canEditRef.current || !redoStackRef.current.length) return;
    const action = redoStackRef.current.pop();
    undoStackRef.current.push(action);
    updateHistoryButtons();
    await applyHistoryAction(action, 'redo');
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
        .filter((op) => op?.type === 'upsert' && op.object?.selectionTransactionId)
        .map((op) => String(op.object.selectionTransactionId)))]
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
    const selectionTransactionIds = [...new Set(ops
      .filter((op) => op?.type === 'upsert' && op.object?.selectionTransactionId)
      .map((op) => String(op.object.selectionTransactionId)))];
    const receivedAt = Date.now();
    const matchingTransformSessions = [...remoteTransformSessionsRef.current.values()].filter((session) => (
      receivedAt - Number(session?.receivedAt ?? 0) < 10000
      && Array.isArray(session?.objectIds)
      && session.objectIds.some((id) => upsertIds.includes(String(id)))
    ));
    if (upsertIds.length) {
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

        // Do not remove live previews before the authoritative objects are revived.
        // The replacement below is performed atomically with rendering paused, so the
        // receiving device never shows a white gap between realtime and saved state.

        // Revive the whole authoritative batch in one pass. Sequential enlivening made
        // a 40-object paste spend a long time in the apply queue even though rendering was
        // paused. Tombstones also stop an older queued upsert from reviving a deleted line.
        const preparedOps = ops.map((op) => ({ op, revived: null, skipDeleted: false }));
        const reviveEntries = [];
        preparedOps.forEach((entry, index) => {
          const op = entry.op;
          const id = String(op?.object?.boardObjectId ?? '');
          if (op?.type !== 'upsert' || !id) return;
          const tombstone = remoteDeletedObjectIdsRef.current.get(id);
          const updatedAt = Number(op.object?.updatedAt ?? 0);
          const deletedAt = Number(tombstone?.timestamp ?? 0);
          if (tombstone && !op.restore && (!updatedAt || updatedAt <= deletedAt)) {
            entry.skipDeleted = true;
            return;
          }
          if (tombstone) remoteDeletedObjectIdsRef.current.delete(id);
          reviveEntries.push({ index, serialized: op.object });
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

        const incompleteSelectionBatch = selectionTransactionIds.length > 0
          && preparedOps.some(({ op, revived, skipDeleted }) => (
            op?.type === 'upsert'
            && op.object?.selectionTransactionId
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
        applyingRemoteRef.current = true;
        canvas.discardActiveObject();
        const previousRenderOnAddRemove = canvas.renderOnAddRemove;
        canvas.renderOnAddRemove = false;
        try {
          creationSessionsToReplace.forEach(({ clientId, sessionId }) => {
            removeBoardObjectsByCreationSession(canvas, clientId, sessionId);
            remoteDrawSessionsRef.current.delete(`${clientId}:${sessionId}`);
          });
          [...new Set([...selectionTransactionIds, ...deleteMatchedTransactionIds])].forEach((transactionId) => {
            removeSelectionTransactionObjects(canvas, transactionId);
            remoteSelectionTransactionsRef.current.set(transactionId, {
              phase: 'authoritative',
              receivedAt: Date.now(),
            });
          });
          const atomicReorderIds = new Set(preparedOps
            .filter(({ op, skipDeleted }) => (
              !skipDeleted
              && op?.type === 'upsert'
              && Boolean(op.reorder || op.restore)
              && op.object?.boardObjectId
            ))
            .map(({ op }) => String(op.object.boardObjectId)));
          atomicReorderIds.forEach((objectId) => removeBoardObjectsById(canvas, objectId));

          for (const { op, revived, skipDeleted } of preparedOps) {
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
            if (skipDeleted || op?.type !== 'upsert' || !op.object?.boardObjectId || !revived) continue;
            if (op.restore) remoteDeletedObjectIdsRef.current.delete(String(op.object.boardObjectId));
            remotePreviewTokensRef.current.delete(String(op.object.boardObjectId));
            const existingIndex = atomicReorderIds.has(String(op.object.boardObjectId))
              ? -1
              : canvas.getObjects().findIndex(
                (object) => object.boardObjectId === op.object.boardObjectId,
              );
            removeBoardObjectsById(canvas, op.object.boardObjectId);
            revived.transientPreview = false;
            revived.transientLiveDraw = false;
            revived.transientAwaitingCommit = false;
            canvas.add(revived);
            const requestedIndex = op.preserveOrder && existingIndex >= 0
              ? existingIndex
              : op.zIndex;
            if (Number.isInteger(requestedIndex) && typeof canvas.moveObjectTo === 'function') {
              canvas.moveObjectTo(revived, clamp(requestedIndex, 0, canvas.getObjects().length - 1));
            }
          }

          deduplicateBoardObjects(canvas);
          if (BACKGROUNDS.has(incomingBackground)) applyBackground(incomingBackground);
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
          revisionRef.current = incomingRevision;
          updateSelectionState();
          updateSelectionStyleState();
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
    applyObjectInteractivity,
    getLocalMutationIds,
    syncFromServer,
    updateSelectionState,
    updateSelectionStyleState,
  ]);

  applyRemoteOpsRef.current = applyRemoteOps;

  const handleRemoteSettings = useCallback((settings, revision, needsSync = false) => {
    // Legacy settings packets still pass through the same strict authoritative queue.
    applyRemoteOps([], revision, needsSync, settings?.background ?? null);
  }, [applyRemoteOps]);


  const handleRemoteBackgroundLive = useCallback((background) => {
    if (!BACKGROUNDS.has(background)) return;
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
    canEditRef.current = mode === 'edit';
    activeToolRef.current = mode === 'edit' ? 'pencil' : 'select';
    setToolState(activeToolRef.current);
    configureBrushAndMode();
  }, [configureBrushAndMode, initialAccess, isOwner, onAccessChange]);

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

  const copySelectionFromToolbar = useCallback(() => {
    const mobile = Number(navigator.maxTouchPoints ?? 0) > 0
      && (window.matchMedia?.('(pointer: coarse)')?.matches || window.innerWidth <= 1024);
    copySelection({ deselect: mobile });
  }, [copySelection]);

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
    addObjectsToBoard([textObject]);
    return true;
  }, [addObjectsToBoard, getViewportSceneCenter]);

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
    const point = requestedPoint
      && Number.isFinite(Number(requestedPoint.x))
      && Number.isFinite(Number(requestedPoint.y))
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

      // Capture one authoritative absolute-coordinate batch before any selection can
      // convert members into group-local coordinates. Pasted groups intentionally
      // remain unselected so a selection transaction cannot race the paste commit.
      const records = getObjectRecords(added);
      canvas.discardActiveObject();
      canvas.requestRenderAll();
      const previewPromise = sendPreviewBatches(records);
      sendRecordUpserts(records).catch?.(() => undefined);
      await Promise.allSettled([previewPromise]);
      recordAction({ type: 'add', records });
      schedulePersistence();
      updateSelectionVisuals();
      updateSelectionState();
      updateSelectionStyleState();
      mobilePasteAwaitingPointRef.current = false;
      setSaveStatus(added.length > 1 ? `Вставлено: ${added.length}` : 'Объект вставлен');
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
      canvas.discardActiveObject();
      canvas.remove(transaction.proxy);
      applyingRemoteRef.current = false;
      realtimeRef.current?.sendSelectionTransaction?.({
        phase: 'commit',
        transactionId: transaction.transactionId,
        proxyId: transaction.proxyId,
        sourceIds: transaction.sourceIds,
        finalRecords: [],
      });
      sendDeletes(transaction.sourceIds);
      recordAction({ type: 'delete', records: transaction.sourceRecords });
      realtimeRef.current?.sendLock?.(transaction.sourceIds, false);
      localLockIdsRef.current = [];
      localSelectionTransactionRef.current = null;
      selectionTransactionTransitionRef.current = false;
      applyObjectInteractivity();
      canvas.requestRenderAll();
      updateSelectionState();
      updateSelectionStyleState();
      schedulePersistence();
      return;
    }
    const objects = canvas.getActiveObjects().filter((object) => !object.isEraserPath);
    if (!objects.length) return;
    const records = getObjectRecords(objects);
    const ids = records.map((record) => record.object.boardObjectId).filter(Boolean);
    applyingRemoteRef.current = true;
    objects.forEach((object) => canvas.remove(object));
    applyingRemoteRef.current = false;
    canvas.discardActiveObject();
    canvas.requestRenderAll();
    updateSelectionState();
    updateSelectionStyleState();
    sendDeletes(ids);
    recordAction({ type: 'delete', records });
    schedulePersistence();
  }, [applyObjectInteractivity, getObjectRecords, recordAction, schedulePersistence, sendDeletes, updateSelectionState, updateSelectionStyleState]);

  const clearBoard = useCallback(() => {
    const canvas = fabricCanvasRef.current;
    if (!canvas || !canEditRef.current) return;
    if (!window.confirm('Удалить все линии и штрихи с доски?')) return;
    const objects = canvas.getObjects();
    if (!objects.length) return;
    const records = getObjectRecords(objects);
    const ids = records.map((record) => record.object.boardObjectId).filter(Boolean);
    applyingRemoteRef.current = true;
    objects.forEach((object) => canvas.remove(object));
    applyingRemoteRef.current = false;
    canvas.discardActiveObject();
    canvas.requestRenderAll();
    updateSelectionState();
    updateSelectionStyleState();
    sendDeletes(ids);
    recordAction({ type: 'delete', records });
    schedulePersistence();
  }, [getObjectRecords, recordAction, schedulePersistence, sendDeletes, updateSelectionState]);

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
    canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
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
    applyObjectInteractivity();
  }, [applyObjectInteractivity]);

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
    else localLockIdsRef.current = localLockIdsRef.current.filter((id) => !ids.includes(id));
    realtimeRef.current.sendLock(ids, locked);
  }, []);


  const getLiveTransformObjects = useCallback((target) => {
    const canvas = fabricCanvasRef.current;
    return flattenTarget(target)
      .map((object) => {
        if (!object?.boardObjectId || typeof object.calcTransformMatrix !== 'function') return null;
        const matrix = compactTransformMatrix(object.calcTransformMatrix());
        if (!matrix) return null;
        return {
          id: String(object.boardObjectId),
          matrix,
          creationSessionId: object.creationSessionId ?? null,
          creationClientId: object.creationClientId ?? object.updatedBy ?? null,
          objectKind: object.objectKind ?? object.type ?? null,
          objectType: object.type ?? null,
          zIndex: canvas ? canvas.getObjects().indexOf(object) : -1,
        };
      })
      .filter(Boolean);
  }, []);

  const sendLiveTransformNow = useCallback((target, phase = 'update') => {
    const realtime = realtimeRef.current;
    const state = liveTransformSendRef.current;
    if (!realtime?.sendTransform || !target) return;
    if (!state.sessionId) state.sessionId = randomToken(12);
    const objects = getLiveTransformObjects(target);
    if (!objects.length) return;
    const signature = JSON.stringify(objects.map((frame) => [frame.id, frame.matrix]));
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
      objects,
      cursor: pointer && Number.isFinite(Number(pointer.x)) && Number.isFinite(Number(pointer.y))
        ? [Number(Number(pointer.x).toFixed(2)), Number(Number(pointer.y).toFixed(2))]
        : null,
    });
  }, [getLiveTransformObjects]);

  const beginLiveTransform = useCallback((target) => {
    const state = liveTransformSendRef.current;
    window.clearTimeout(state.timer);
    state.timer = null;
    state.pendingTarget = target;
    state.sessionId = randomToken(12);
    state.sessionOrder += 1;
    state.sequence = 0;
    state.lastSentAt = 0;
    state.lastSignature = '';

    // Every member must keep one stable identity before the first frame is sent.
    // Live transform messages never create objects on another device; they only move
    // the already existing object with this id/session.
    flattenTarget(target).forEach((object) => markObject(object, clientIdRef.current));
    sendLiveTransformNow(target, 'start');
  }, [markObject, sendLiveTransformNow]);

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

  const endLiveTransform = useCallback((target) => {
    const state = liveTransformSendRef.current;
    if (!state.sessionId) return;
    window.clearTimeout(state.timer);
    state.timer = null;
    state.pendingTarget = target ?? state.pendingTarget;
    if (state.pendingTarget) sendLiveTransformNow(state.pendingTarget, 'end');
    state.sessionId = null;
    state.sequence = 0;
    state.lastSentAt = 0;
    state.lastSignature = '';
    state.pendingTarget = null;
  }, [sendLiveTransformNow]);

  const processRemoteTransform = useCallback((message) => {
    const canvas = fabricCanvasRef.current;
    const remoteClientId = String(message?.clientId ?? '');
    const sessionId = String(message?.sessionId ?? '');
    const sessionOrder = Number(message?.sessionOrder ?? 0);
    const sequence = Number(message?.sequence ?? 0);
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
    if (affectedIds.some((id) => localLockIdsRef.current.includes(id))) return;

    deduplicateBoardObjects(canvas);

    const usedObjects = new Set();
    const previewCandidates = canvas.getObjects().filter((object) => (
      object.transientPreview
      && (!object.creationClientId || object.creationClientId === remoteClientId)
    ));

    const resolveExistingObject = (frame) => {
      const creationClientId = frame.creationClientId ?? remoteClientId;
      const sameId = boardObjectsById(canvas, frame.id);
      const sameSession = frame.creationSessionId
        ? boardObjectsByCreationSession(canvas, creationClientId, frame.creationSessionId)
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
        const expectedKind = frame.objectKind ?? frame.objectType ?? null;
        const expectedIndex = Number(frame.zIndex ?? -1);
        let best = null;
        let bestScore = Number.POSITIVE_INFINITY;
        previewCandidates.forEach((candidate) => {
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
      missing: false,
    });

    const affectedSet = new Set(affectedIds);
    const activeIds = canvas.getActiveObjects().map((object) => object.boardObjectId).filter(Boolean);
    if (activeIds.some((id) => affectedSet.has(id))) canvas.discardActiveObject();

    applyingRemoteRef.current = true;
    try {
      resolved.forEach(({ frame, object }) => {
        util.applyTransformToObject(object, frame.matrix.map(Number));
        object.previewReceivedAt = Date.now();
        if (object.selectionTransactionId) {
          const transaction = remoteSelectionTransactionsRef.current.get(object.selectionTransactionId);
          if (transaction) transaction.receivedAt = Date.now();
        }
        object.dirty = true;
        object.setCoords();
      });
      canvas.requestRenderAll();
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
      applyObjectInteractivity();
    }
  }, [applyObjectInteractivity, handleRemoteCursor, syncFromServer]);

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
        removeTransientDrawPreviewsBySession(canvas, remoteClientId, sessionId);
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
      removeTransientDrawPreviewsBySession(canvas, remoteClientId, sessionId);
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

    const sessionPreviews = canvas.getObjects().filter((object) => (
      object.transientPreview
      && object.creationSessionId === sessionId
      && (!object.creationClientId || object.creationClientId === remoteClientId)
    ));
    const existingObjects = boardObjectsById(canvas, objectId);
    const authoritativeExisting = existingObjects.find((object) => !object.transientPreview);
    const existing = authoritativeExisting ?? existingObjects[0] ?? sessionPreviews[0] ?? null;
    if (authoritativeExisting) {
      removeTransientDrawPreviewsBySession(canvas, remoteClientId, sessionId);
      canvas.requestRenderAll();
      return;
    }
    if (existing?.transientPreview && !existing.transientLiveDraw && !ended) return;

    const style = message?.style ?? previous?.style ?? {};
    const common = {
      stroke: typeof style.stroke === 'string' ? style.stroke : '#111827',
      strokeWidth: clamp(Number(style.width ?? 3), 1, 80),
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
  }, [handleRemoteCursor, syncFromServer]);

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
              const existingObjects = boardObjectsById(canvas, id);
              const authoritativeExisting = existingObjects.find((object) => !object.transientPreview);
              const existing = authoritativeExisting ?? existingObjects[0] ?? null;
              const existingIndex = existing ? canvas.getObjects().indexOf(existing) : canvas.getObjects().length;
              if (authoritativeExisting) {
                if (creationSessionId) {
                  removeTransientDrawPreviewsBySession(canvas, creationClientId, creationSessionId);
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
                  ? boardObjectsByCreationSession(canvas, creationClientId, creationSessionId)
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
  }, [syncFromServer]);

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
        await preloadSerializedImages(record.object);
        const [revived] = await util.enlivenObjects([record.object]);
        if (!revived || getLocalMutationIds().has(objectId)) return;

        const existing = boardObjectsById(canvas, objectId);
        const incomingUpdatedAt = Number(record?.object?.updatedAt ?? 0);
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
          applyObjectInteractivity();
          canvas.requestRenderAll();
        }
      });

    authoritativeApplyQueueRef.current = task;
  }, [applyObjectInteractivity, getLocalMutationIds]);

  const handleRemoteDeletePreview = useCallback((message) => {
    const canvas = fabricCanvasRef.current;
    const ids = [...new Set((Array.isArray(message?.ids) ? message.ids : []).filter(Boolean).map(String))];
    if (!canvas || !ids.length) return;
    const timestamp = Date.now();
    const idSet = new Set(ids);
    const activeIds = canvas.getActiveObjects().map((object) => String(object.boardObjectId ?? ''));

    applyingRemoteRef.current = true;
    const previousRenderOnAddRemove = canvas.renderOnAddRemove;
    canvas.renderOnAddRemove = false;
    try {
      if (activeIds.some((id) => idSet.has(id))) canvas.discardActiveObject();
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
        removeTransientDrawPreviewsBySession(canvas, remoteClientId, sessionParts.join(':'));
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
      applyObjectInteractivity();
      updateSelectionState();
      updateSelectionStyleState();
      canvas.requestRenderAll();
    }
  }, [applyObjectInteractivity, updateSelectionState, updateSelectionStyleState]);

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
      enableRetinaScaling: false,
      perPixelTargetFind: false,
      skipOffscreen: true,
      targetFindTolerance: 8,
      fireRightClick: true,
      stopContextMenu: true,
    });
    fabricCanvasRef.current = canvas;
    canvas.freeDrawingBrush = new PencilBrush(canvas);
    configureBrushAndMode();

    const resize = () => {
      canvas.setDimensions({ width: host.clientWidth, height: host.clientHeight });
      updateBackgroundTransform();
      canvas.requestRenderAll();
    };
    resize();
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(host);

    let disposed = false;
    async function loadInitialData() {
      const savedClipboard = await getCrossBoardClipboard();
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

      const cached = await getCachedSnapshot(boardId);
      let baseSnapshot = initialAccess.snapshot ?? {
        version: 2,
        background: 'grid',
        canvas: { objects: [] },
      };
      let baseRevision = Number(initialAccess.snapshotRevision ?? initialAccess.revision ?? 0);
      let authoritativeBase = Boolean(initialAccess.snapshot);

      if (!isSupabaseConfigured && cached?.snapshot) {
        baseSnapshot = cached.snapshot;
        baseRevision = Number(cached.revision ?? baseRevision);
      }

      if (isSupabaseConfigured) {
        try {
          const recovery = await getBoardRecovery(boardId, boardKey);
          if (recovery?.snapshot) {
            baseSnapshot = recovery.snapshot;
            baseRevision = Number(recovery.revision ?? baseRevision);
            authoritativeBase = true;
          }
        } catch (recoveryError) {
          console.warn('Snapshot recovery fallback', recoveryError);
        }
      }

      // Rebuild without reading Fabric Canvas: base snapshot + locally confirmed
      // operations after it + still-pending operations. Server-only missing revisions
      // are appended by syncFromServer immediately after the Canvas becomes ready.
      let snapshot = baseSnapshot;
      let confirmedRevision = baseRevision;
      let confirmedRevisionGap = false;
      const confirmedActions = await getConfirmedActionsAfter(boardId, baseRevision);
      for (const action of confirmedActions) {
        snapshot = applyOpsToSnapshot(snapshot, action.ops ?? [], action.background ?? null);
        const actionRevision = Number(action.revision ?? 0);
        if (!confirmedRevisionGap && actionRevision === confirmedRevision + 1) {
          confirmedRevision = actionRevision;
        } else if (actionRevision > confirmedRevision) {
          // Keep the local visual result, but never jump over a missing server revision.
          // syncFromServer will fetch the gap and then idempotently reapply this action.
          confirmedRevisionGap = true;
        }
      }
      const confirmedSnapshot = snapshot;
      const pendingActions = await getPendingActions(boardId);
      for (const action of pendingActions) {
        snapshot = applyOpsToSnapshot(snapshot, action.ops ?? [], action.background ?? null);
      }

      const initialBackground = BACKGROUNDS.has(snapshot?.background) ? snapshot.background : 'grid';
      applyBackground(initialBackground);
      if (snapshot?.canvas && !disposed) {
        applyingRemoteRef.current = true;
        try {
          await preloadSerializedImages(snapshot.canvas);
          await canvas.loadFromJSON(snapshot.canvas);
          revisionRef.current = Math.max(Number(revisionRef.current ?? 0), confirmedRevision);
          configureBrushAndMode();
          updateBackgroundTransform();
          canvas.requestRenderAll();
        } finally {
          applyingRemoteRef.current = false;
        }
      }

      // Cache only an authoritative/base JSON received from storage or Supabase.
      // Pending operations remain separate, so a reload can replay them exactly once.
      if (authoritativeBase && baseSnapshot?.canvas) {
        await setCachedSnapshot(boardId, {
          snapshot: baseSnapshot,
          revision: baseRevision,
          savedAt: Date.now(),
        });
        await pruneConfirmedActionsThrough(boardId, baseRevision);
      }
      if (!isSupabaseConfigured && !confirmedRevisionGap
        && confirmedActions.length && confirmedSnapshot?.canvas) {
        await setCachedSnapshot(boardId, {
          snapshot: confirmedSnapshot,
          revision: confirmedRevision,
          savedAt: Date.now(),
        });
        await pruneConfirmedActionsThrough(boardId, confirmedRevision);
      }

      boardReadyRef.current = true;
      syncFromServer(false);
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
      onCommit(result) {
        const currentRevision = Number(revisionRef.current ?? 0);
        const committedRevision = Number(result?.revision ?? currentRevision);
        const rejected = Array.isArray(result?.rejectedObjectIds)
          ? result.rejectedObjectIds
          : [];
        if (rejected.length > 0) {
          // The complete logical action was rejected atomically. Pause later writes,
          // restore the durable snapshot, then reapply still-pending local actions.
          realtimeRef.current?.pauseWrites?.();
          recoverRejectedServerAction();
          return;
        }
        const sequentialCommit = result?.changed === false
          ? committedRevision === currentRevision
          : committedRevision === currentRevision + 1;
        if (!result?.needsSync && sequentialCommit) {
          // The local Canvas already contains this action. Advance only across the one
          // server revision that was just confirmed; never Math.max over missed actions.
          revisionRef.current = committedRevision;
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
        if (count === 0 && syncRequestedRef.current) {
          const force = syncForceRef.current;
          syncRequestedRef.current = false;
          syncForceRef.current = false;
          window.setTimeout(() => syncFromServer(force), 0);
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
      let changed = false;
      for (const [objectId, lock] of remoteLocksRef.current) {
        if (Number(lock.expiresAt ?? 0) <= now) {
          remoteLocksRef.current.delete(objectId);
          changed = true;
        }
      }
      if (changed) {
        setRemoteLocks([...remoteLocksRef.current.entries()].map(([objectId, lock]) => ({ objectId, ...lock })));
        applyObjectInteractivity();
      }
      setRemoteCursors((current) => current.filter((cursor) => now - Number(cursor.receivedAt ?? 0) < 12000));
      for (const [sessionKey, session] of remoteTransformSessionsRef.current) {
        if (now - Number(session.receivedAt ?? 0) > 15000) {
          remoteTransformSessionsRef.current.delete(sessionKey);
        }
      }
      let removedTransient = false;
      for (const [transactionId, transaction] of remoteSelectionTransactionsRef.current) {
        if (now - Number(transaction.receivedAt ?? 0) <= 45000) continue;
        if (removeSelectionTransactionObjects(canvas, transactionId).length) removedTransient = true;
        remoteSelectionTransactionsRef.current.delete(transactionId);
      }
      for (const [objectId, tombstone] of remoteDeletedObjectIdsRef.current) {
        if (now - Number(tombstone?.timestamp ?? 0) > 120000) {
          remoteDeletedObjectIdsRef.current.delete(objectId);
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
    };
    const syncOnPageShow = () => syncOnFocus();
    const syncOnOnline = () => syncOnFocus();
    window.addEventListener('focus', syncOnFocus);
    window.addEventListener('pageshow', syncOnPageShow);
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

    function scenePointFromClient(clientX, clientY) {
      const rect = canvas.upperCanvasEl.getBoundingClientRect();
      const viewportPoint = new Point(clientX - rect.left, clientY - rect.top);
      const inverse = util.invertTransform(canvas.viewportTransform ?? [1, 0, 0, 1, 0, 0]);
      return util.transformPoint(viewportPoint, inverse);
    }

    function objectAtScenePoint(scenePoint, { strictImageBounds = false } = {}) {
      const tolerance = Math.max(7, 18 / Math.max(canvas.getZoom(), MIN_ZOOM));
      const objects = [...canvas.getObjects()].reverse();
      return objects.find((object) => {
        if (object.isEraserPath || objectEraserRecordsRef.current.has(object.boardObjectId)) return false;
        const bounds = object.getBoundingRect();
        const insideExpandedBounds = scenePoint.x >= bounds.left - tolerance
          && scenePoint.x <= bounds.left + bounds.width + tolerance
          && scenePoint.y >= bounds.top - tolerance
          && scenePoint.y <= bounds.top + bounds.height + tolerance;
        if (!insideExpandedBounds) return false;
        try {
          if (typeof object.containsPoint === 'function') {
            const contains = object.containsPoint(scenePoint);
            if (contains) return true;
            if (strictImageBounds && isImageObject(object)) return false;
          }
        } catch {
          // Thin paths and grouped shapes are handled by their expanded bounding box.
        }
        return true;
      });
    }

    function preciseEyedropperTarget(scenePoint, viewportPoint) {
      if (!scenePoint || !viewportPoint) return null;
      const objects = [...canvas.getObjects()].reverse();
      for (const object of objects) {
        if (object.isEraserPath || objectEraserRecordsRef.current.has(object.boardObjectId)) continue;

        const bounds = object.getBoundingRect();
        const insideBounds = scenePoint.x >= bounds.left
          && scenePoint.x <= bounds.left + bounds.width
          && scenePoint.y >= bounds.top
          && scenePoint.y <= bounds.top + bounds.height;
        if (!insideBounds) continue;

        try {
          if (typeof canvas.isTargetTransparent === 'function') {
            const transparent = canvas.isTargetTransparent(
              object,
              viewportPoint.x,
              viewportPoint.y,
            );
            if (transparent) continue;
            return object;
          }
        } catch (error) {
          console.warn('Точная проверка попадания пипетки недоступна', error);
        }

        try {
          if (typeof object.containsPoint === 'function' && object.containsPoint(scenePoint)) {
            return object;
          }
        } catch {
          // Безопасный запасной вариант ниже.
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

    function eraseAtClientPoint(clientX, clientY) {
      const pointer = objectEraserPointerRef.current;
      if (pointer?.active && pointer.lastX != null
        && Math.hypot(clientX - pointer.lastX, clientY - pointer.lastY) < 3) return;
      if (pointer) {
        pointer.lastX = clientX;
        pointer.lastY = clientY;
      }
      const target = objectAtScenePoint(scenePointFromClient(clientX, clientY));
      if (!target) return;
      const [record] = getObjectRecords([target]);
      const id = record?.object?.boardObjectId;
      if (!id || objectEraserRecordsRef.current.has(id)) return;
      objectEraserRecordsRef.current.set(id, record);
      queueObjectEraserDeletePreview(id);
      applyingRemoteRef.current = true;
      canvas.remove(target);
      applyingRemoteRef.current = false;
      canvas.discardActiveObject();
      updateSelectionState();
      updateSelectionStyleState();
      canvas.requestRenderAll();
    }

    function finishObjectEraser() {
      if (!erasingRef.current) return;
      erasingRef.current = false;
      objectEraserPointerRef.current = null;
      const records = [...objectEraserRecordsRef.current.values()];
      objectEraserRecordsRef.current = new Map();
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
          removeBoardObjectsByCreationSession(canvas, clientId, pendingPencil.sessionId);
          applyingRemoteRef.current = true;
          canvas.remove(path);
          applyingRemoteRef.current = false;
          return;
        }
        finishLiveDraw('end', pendingPencil.sessionId);
        // The authoritative Fabric path owns the session. Remove every temporary or
        // interrupted sibling carrying the same session, even when a buggy browser
        // assigned it a different boardObjectId.
        removeBoardObjectsByCreationSession(canvas, clientId, pendingPencil.sessionId, path);
      }
      if (isPartialEraserPath) {
        path.set({
          globalCompositeOperation: 'destination-out',
          isEraserPath: true,
          selectable: false,
          evented: false,
          hasControls: false,
        });
        path.dirty = true;
        canvas.requestRenderAll();
      }
      commitAddedObject(path);
    });

    canvas.on('before:transform', ({ transform }) => {
      if (applyingRemoteRef.current || applyingHistoryRef.current || !transform?.target) return;
      if (transform.target.transientSelectionProxy) {
        modifiedBeforeRef.current = [];
        beginLiveTransform(transform.target);
        lastLockBroadcastRef.current = Date.now();
        return;
      }
      modifiedBeforeRef.current = getObjectRecords(flattenTarget(transform.target));
      sendLocalLock(transform.target, true);
      beginLiveTransform(transform.target);
      lastLockBroadcastRef.current = Date.now();
    });

    const broadcastLiveTransform = ({ target }) => {
      if (!target || applyingRemoteRef.current || applyingHistoryRef.current) return;
      sendLiveTransformThrottled(target);
      if (Date.now() - lastLockBroadcastRef.current < 1200) return;
      lastLockBroadcastRef.current = Date.now();
      sendLocalLock(target, true);
    };
    canvas.on('object:moving', broadcastLiveTransform);
    canvas.on('object:scaling', broadcastLiveTransform);
    canvas.on('object:rotating', broadcastLiveTransform);
    canvas.on('object:skewing', broadcastLiveTransform);

    canvas.on('object:modified', ({ target }) => {
      if (applyingRemoteRef.current || applyingHistoryRef.current || !target) return;
      if (target.transientSelectionProxy) {
        endLiveTransform(target);
        target.previewReceivedAt = Date.now();
        target.setCoords();
        modifiedBeforeRef.current = [];
        canvas.requestRenderAll();
        return;
      }
      const restoreGroupSelection = target.type === 'activeSelection';
      const selectedObjects = flattenTarget(target).filter(Boolean);
      endLiveTransform(target);

      // Fabric keeps members of ActiveSelection in group-local coordinates until the
      // selection is discarded. Persisting them before this step makes the remote
      // device revive extra-looking copies in incorrect positions.
      if (restoreGroupSelection) {
        canvas.discardActiveObject();
        selectedObjects.forEach((object) => object.setCoords());
      }

      const objects = selectedObjects.map((object) => markObject(object, clientId));
      const after = getObjectRecords(objects);
      const before = modifiedBeforeRef.current;
      modifiedBeforeRef.current = [];
      sendRecordUpserts(after);
      sendLocalLock(objects, false);
      if (before.length && after.length) recordAction({ type: 'modify', before, after });
      schedulePersistence();

      if (restoreGroupSelection && activeToolRef.current === 'select' && objects.length > 1) {
        canvas.setActiveObject(createOuterOnlyActiveSelection(objects, canvas));
      }
      deduplicateBoardObjects(canvas);
      updateSelectionState();
      updateSelectionStyleState();
      canvas.requestRenderAll();
    });

    const refreshSelectionUi = () => {
      applyObjectInteractivity();
      updateSelectionVisuals();
      window.requestAnimationFrame(updateSelectionVisuals);
      updateSelectionState();
      updateSelectionStyleState();
    };
    const startTransactionalSelection = () => {
      refreshSelectionUi();
      const active = canvas.getActiveObject();
      if (active?.type !== 'activeSelection'
        || localSelectionTransactionRef.current
        || selectionTransactionTransitionRef.current
        || applyingRemoteRef.current
        || applyingHistoryRef.current) return;
      const members = active.getObjects?.() ?? [];
      if (members.length < 2) return;
      window.setTimeout(() => beginLocalSelectionTransaction(members), 0);
    };
    const finishTransactionalSelection = () => {
      refreshSelectionUi();
      if (localSelectionTransactionRef.current
        && !selectionTransactionTransitionRef.current
        && !applyingRemoteRef.current
        && !applyingHistoryRef.current) {
        window.setTimeout(() => commitLocalSelectionTransaction(), 0);
      }
    };
    canvas.on('selection:created', startTransactionalSelection);
    canvas.on('selection:updated', startTransactionalSelection);
    canvas.on('selection:cleared', finishTransactionalSelection);

    canvas.on('text:editing:entered', ({ target }) => {
      if (!target?.boardObjectId) return;
      textBeforeRef.current.set(target.boardObjectId, getObjectRecords([target]));
      sendLocalLock(target, true);
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
      window.clearTimeout(textChangeTimerRef.current);
      const before = textBeforeRef.current.get(target.boardObjectId) ?? [];
      textBeforeRef.current.delete(target.boardObjectId);
      markObject(target, clientId);
      const after = getObjectRecords([target]);
      sendRecordUpserts(after);
      sendLocalLock(target, false);
      if (before.length && after.length) recordAction({ type: 'modify', before, after });
      schedulePersistence();
    });

    canvas.on('mouse:down', (event) => {
      const nativeEvent = event.e;
      const pointerId = nativeEvent?.pointerId;
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

      if (mobilePasteAwaitingPointRef.current && (nativeEvent.pointerType === 'touch' || nativeEvent.pointerType === 'pen' || (Number(navigator.maxTouchPoints ?? 0) > 0 && nativeEvent.button == null))) {
        nativeEvent.preventDefault?.();
        nativeEvent.stopPropagation?.();
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
        const point = event.scenePoint ?? canvas.getScenePoint(nativeEvent);
        const viewportPoint = event.viewportPoint ?? canvas.getViewportPoint(nativeEvent);
        const target = preciseEyedropperTarget(point, viewportPoint);
        const mode = eyedropperModeRef.current;
        const transactionId = eyedropperSelectionTransactionIdRef.current;
        const preservedSelectionIds = [...eyedropperSelectionIdsRef.current];

        const restoreSelection = () => {
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
            canvas.requestRenderAll();
            return;
          }
          const idSet = new Set(preservedSelectionIds.map(String));
          const selectionObjects = canvas.getObjects().filter((object) => (
            object.boardObjectId
            && idSet.has(String(object.boardObjectId))
            && !object.isEraserPath
          ));
          if (selectionObjects.length === 1) canvas.setActiveObject(selectionObjects[0]);
          else if (selectionObjects.length > 1) canvas.setActiveObject(createOuterOnlyActiveSelection(selectionObjects, canvas));
          updateSelectionState();
          updateSelectionStyleState();
          canvas.requestRenderAll();
        };

        if (!target) {
          restoreSelection();
          setSaveStatus('Пипетка: нажмите точно на видимую часть объекта');
          return;
        }

        const sourceIsImage = isImageObject(target);
        const pixelColor = sourceIsImage ? sampleImagePixelColor(target, point) : null;
        const sampled = sourceIsImage
          ? {
            canColor: Boolean(pixelColor),
            color: pixelColor,
            canOpacity: false,
            opacity: null,
            canWidth: false,
            width: null,
          }
          : probeObjectStyle(target);
        let success = false;
        let selectionObjects = [];

        if (mode === 'drawing' && ['pencil', 'line'].includes(activeToolRef.current)) {
          if (sampled.canColor && sampled.color) {
            colorRef.current = sampled.color;
            setColorState(sampled.color);
            success = true;
          }
          if (!sourceIsImage && sampled.canOpacity && Number.isFinite(sampled.opacity)) {
            const nextOpacity = clamp(sampled.opacity, 0.05, 1);
            opacityRef.current = nextOpacity;
            setOpacityState(nextOpacity);
            success = true;
          }
          if (!sourceIsImage && sampled.canWidth && Number.isFinite(sampled.width)) {
            const nextWidth = clamp(Math.round(sampled.width), 1, 24);
            widthRef.current = nextWidth;
            setWidthState(nextWidth);
            success = true;
          }
        }

        if (mode === 'selection') {
          selectionObjects = transactionId
            ? applyEyedropperToSelectionTransaction(
              transactionId,
              sampled,
              { colorOnly: sourceIsImage },
            )
            : applyEyedropperToSelectionIds(
              eyedropperSelectionIdsRef.current,
              sampled,
              { colorOnly: sourceIsImage },
            );
          success = selectionObjects.length > 0;
        }

        restoreSelection();

        if (!success) {
          if (sourceIsImage && !pixelColor) {
            setSaveStatus('Пипетка: не удалось определить цвет пикселя картинки');
          } else {
            setSaveStatus('Пипетка: у объекта нет подходящих параметров');
          }
          return;
        }

        eyedropperActiveRef.current = false;
        eyedropperModeRef.current = null;
        eyedropperSelectionIdsRef.current = [];
        eyedropperSelectionTransactionIdRef.current = null;
        setEyedropperActive(false);
        configureBrushAndMode();
        restoreSelection();
        window.requestAnimationFrame(restoreSelection);

        setSaveStatus(sourceIsImage
          ? 'Цвет пикселя применён'
          : (mode === 'selection' ? 'Цвет, толщина и прозрачность применены' : 'Параметры скопированы'));
        return;
      }

      const primarySelectionPointer = nativeEvent.button == null
        || nativeEvent.button === 0
        || nativeEvent.pointerType === 'touch'
        || nativeEvent.pointerType === 'pen';

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
        canvas.add(object);
        shapeDraftRef.current = {
          object,
          start: new Point(point.x, point.y),
          baseWidth,
          baseHeight,
        };
        const records = getObjectRecords([object]);
        realtimeRef.current?.sendPreview?.(records);
        beginLiveTransform(object);
        canvas.requestRenderAll();
        return;
      }

      if (activeToolRef.current === 'select' && !event.target && primarySelectionPointer) {
        const point = event.scenePoint ?? canvas.getScenePoint(nativeEvent);
        selectionDragRef.current = { start: point, end: point };
        if (selectionBoxRef.current) canvas.remove(selectionBoxRef.current);
        const selectionBox = new Rect({
          left: point.x,
          top: point.y,
          width: 0,
          height: 0,
          originX: 'left',
          originY: 'top',
          fill: 'rgba(37, 99, 235, 0.08)',
          stroke: '#2563eb',
          strokeWidth: Math.max(1, 1.2 / Math.max(canvas.getZoom(), MIN_ZOOM)),
          strokeDashArray: [7, 5],
          selectable: false,
          evented: false,
          excludeFromExport: true,
          objectCaching: false,
        });
        selectionBoxRef.current = selectionBox;
        canvas.add(selectionBox);
        if (typeof canvas.bringObjectToFront === 'function') canvas.bringObjectToFront(selectionBox);
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
        const targetText = isTextObject(event.target) ? event.target : null;
        if (targetText) {
          canvas.setActiveObject(targetText);
          targetText.enterEditing?.();
          const end = String(targetText.text ?? '').length;
          targetText.selectionStart = end;
          targetText.selectionEnd = end;
          targetText.hiddenTextarea?.focus?.();
          updateSelectionState();
          updateSelectionStyleState();
          canvas.requestRenderAll();
          return;
        }
        if (event.target) return;
        const point = scenePoint;
        const textObject = new IText('Текст', {
          left: point.x,
          top: point.y,
          originX: 'left',
          originY: 'top',
          fill: hexToRgba(colorRef.current, opacityRef.current),
          fontFamily: fontFamilyRef.current,
          fontSize: fontSizeRef.current,
          objectKind: 'text',
          editable: true,
        });
        markObject(textObject, clientId);
        canvas.add(textObject);
        canvas.setActiveObject(textObject);
        canvas.requestRenderAll();
        commitAddedObject(textObject);
        updateSelectionState();
        updateSelectionStyleState();
        setSaveStatus('Текст создан — нажмите внутри рамки, чтобы печатать');
        return;
      }

      if (activeToolRef.current === 'line') {
        const point = scenePoint;
        const line = new Line([point.x, point.y, point.x, point.y], {
          stroke: hexToRgba(colorRef.current, opacityRef.current),
          strokeWidth: widthRef.current,
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
        lineRef.current = line;
        lineStartRef.current = point;
        canvas.add(line);
        return;
      }

    });

    canvas.on('mouse:move', (event) => {
      const nativeEvent = event.e;
      if (nativeEvent?.pointerId != null && rejectedPointerIdsRef.current.has(nativeEvent.pointerId)) return;
      const cursorScenePoint = event.scenePoint ?? canvas.getScenePoint(nativeEvent);
      lastPointerSceneRef.current = cursorScenePoint;
      if (!liveTransformSendRef.current.sessionId && !liveDrawSendRef.current.sessionId) {
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
        canvas.requestRenderAll();
        return;
      }
      if (selectionDragRef.current && activeToolRef.current === 'select') {
        selectionDragRef.current.end = cursorScenePoint;
        const selectionBox = selectionBoxRef.current;
        if (selectionBox) {
          const rect = normalizedSceneRect(selectionDragRef.current.start, cursorScenePoint);
          selectionBox.set({
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
            strokeWidth: Math.max(1, 1.2 / Math.max(canvas.getZoom(), MIN_ZOOM)),
          });
          selectionBox.setCoords();
          canvas.requestRenderAll();
        }
      }
      const activeStroke = activePencilRef.current;
      const drawingPointerMatches = !activeStroke
        || nativeEvent?.pointerId == null
        || activeStroke.pointerId === nativeEvent.pointerId;
      if (drawingPointerMatches
        && liveDrawSendRef.current.sessionId
        && ['pencil', 'line'].includes(liveDrawSendRef.current.tool)) {
        updateLiveDraw(cursorScenePoint);
      }
      if (activeToolRef.current === 'line' && lineRef.current) {
        const point = event.scenePoint ?? canvas.getScenePoint(nativeEvent);
        lineRef.current.set({ x2: point.x, y2: point.y });
        lineRef.current.setCoords();
        canvas.requestRenderAll();
      }
    });

    canvas.on('mouse:up', (event) => {
      const nativeEvent = event?.e;
      const pointerId = nativeEvent?.pointerId;
      if (pointerId != null && rejectedPointerIdsRef.current.has(pointerId)) return;
      if (liveTransformSendRef.current.sessionId) {
        endLiveTransform(liveTransformSendRef.current.pendingTarget ?? canvas.getActiveObject());
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

      if (liveDrawSendRef.current.sessionId) {
        liveDrawSendRef.current.acceptingPoints = false;
      }

      if (shapeDraftRef.current) {
        const draft = shapeDraftRef.current;
        shapeDraftRef.current = null;
        const bounds = draft.object.getBoundingRect();
        if (bounds.width < 4 || bounds.height < 4) {
          applyingRemoteRef.current = true;
          canvas.remove(draft.object);
          applyingRemoteRef.current = false;
          sendDeletes([draft.object.boardObjectId]);
          canvas.requestRenderAll();
          setSaveStatus('Фигура слишком маленькая');
          return;
        }
        draft.object.set({
          selectable: true,
          evented: true,
          hasControls: true,
          hasBorders: true,
        });
        draft.object.setCoords();
        commitAddedObject(draft.object);
        applyObjectInteractivity();
        canvas.requestRenderAll();
        setSaveStatus('Фигура создана — можно нарисовать следующую');
        return;
      }

      if (activeToolRef.current === 'pencil' && activePencilRef.current) {
        const pending = activePencilRef.current;
        if (pointerId != null && pending.pointerId != null && pointerId !== pending.pointerId) return;
        pending.mouseReleased = true;
        pending.releasedAt = Date.now();
        window.clearTimeout(pending.cancelTimer);
        finishLiveDraw('end', pending.sessionId);
        // path:created is normally emitted during this same mouse-up. Keep the exact
        // pending record briefly for Safari, then discard it before another stroke can
        // ever reuse its id.
        pending.cancelTimer = window.setTimeout(() => {
          const index = pendingPencilQueueRef.current.indexOf(pending);
          if (index >= 0) pendingPencilQueueRef.current.splice(index, 1);
          if (activePencilRef.current === pending) activePencilRef.current = null;
          if (!pending.consumed) finishLiveDraw('cancel', pending.sessionId);
        }, 850);
      }

      const selectionDrag = selectionDragRef.current;
      selectionDragRef.current = null;
      if (selectionBoxRef.current) {
        canvas.remove(selectionBoxRef.current);
        selectionBoxRef.current = null;
      }
      if (selectionDrag && activeToolRef.current === 'select') {
        const selectionRect = normalizedSceneRect(selectionDrag.start, selectionDrag.end);
        if (selectionRect.width >= 3 || selectionRect.height >= 3) {
          window.setTimeout(() => {
            canvas.discardActiveObject();
            const selected = canvas.getObjects().filter((object) => {
              if (object.isEraserPath || object.transientPreview || object.transientSelectionProxy || !object.selectable) return false;
              const lock = object.boardObjectId ? remoteLocksRef.current.get(object.boardObjectId) : null;
              if (lock && Number(lock.expiresAt ?? 0) > Date.now()) return false;
              return objectVisuallyIntersectsRect(object, selectionRect);
            });
            if (selected.length === 1) canvas.setActiveObject(selected[0]);
            else if (selected.length > 1) beginLocalSelectionTransaction(selected);
            updateSelectionVisuals();
            updateSelectionState();
            updateSelectionStyleState();
            canvas.requestRenderAll();
          }, 0);
        }
      }

      if (lineRef.current) {
        const line = lineRef.current;
        const start = lineStartRef.current;
        const length = Math.hypot(Number(line.x2) - start.x, Number(line.y2) - start.y);
        lineRef.current = null;
        lineStartRef.current = null;
        const lineSessionId = line.creationSessionId ?? liveDrawSendRef.current.sessionId;
        if (length < 3) {
          finishLiveDraw('cancel', lineSessionId);
          applyingRemoteRef.current = true;
          canvas.remove(line);
          applyingRemoteRef.current = false;
          return;
        }
        finishLiveDraw('end', lineSessionId);
        commitAddedObject(line);
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
    const heldArrowKeys = new Map();
    let arrowPanFrame = null;
    let lastArrowPanAt = 0;
    let objectEraserDelayTimer = null;

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

    function isLikelyPalmPointer(event) {
      return Math.max(Number(event?.width ?? 0), Number(event?.height ?? 0)) >= PALM_CONTACT_RADIUS;
    }

    function isStylusTouch(touch) {
      return String(touch?.touchType ?? '').toLowerCase() === 'stylus';
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

    function releaseEndedPencilGraceGestureTouches(event) {
      touchArray(event?.changedTouches).forEach((touch) => {
        const identifier = touchId(touch);
        if (identifier != null) pencilGraceGestureTouchIdsRef.current.delete(identifier);
      });
      if (!event?.touches?.length) pencilGraceGestureTouchIdsRef.current.clear();
    }

    function isPencilGraceGestureTouch(touch) {
      const identifier = touchId(touch);
      return identifier != null && pencilGraceGestureTouchIdsRef.current.has(identifier);
    }

    function unsuppressedFingerTouches(touches) {
      return touchArray(touches).filter((touch) => {
        if (isStylusTouch(touch)) return false;
        const identifier = touchId(touch);
        return identifier == null
          || pencilGraceGestureTouchIdsRef.current.has(identifier)
          || !suppressedTouchIdsRef.current.has(identifier);
      });
    }

    function touchEventHasSuppressedContact(event) {
      return [...touchArray(event?.touches), ...touchArray(event?.changedTouches)].some((touch) => {
        const identifier = touchId(touch);
        return identifier != null
          && !pencilGraceGestureTouchIdsRef.current.has(identifier)
          && suppressedTouchIdsRef.current.has(identifier);
      });
    }

    function armPencilGraceTwoFingerGesture(event) {
      if (event?.type !== 'touchstart'
        || penInputRef.current.active
        || Date.now() >= Number(penInputRef.current.suppressUntil ?? 0)) return false;

      const fingers = touchArray(event.touches).filter((touch) => !isStylusTouch(touch));
      if (fingers.length !== 2 || fingers.length !== event.touches.length) return false;

      const identifiers = fingers.map((touch) => touchId(touch));
      if (identifiers.some((identifier) => identifier == null)
        || identifiers[0] === identifiers[1]) return false;

      const maxRadius = Math.max(...fingers.map((touch) => (
        Math.max(Number(touch?.radiusX ?? 0), Number(touch?.radiusY ?? 0))
      )));
      if (maxRadius > PENCIL_GRACE_GESTURE_MAX_RADIUS) return false;

      const separation = Math.hypot(
        Number(fingers[0]?.clientX ?? 0) - Number(fingers[1]?.clientX ?? 0),
        Number(fingers[0]?.clientY ?? 0) - Number(fingers[1]?.clientY ?? 0),
      );
      if (separation < PENCIL_GRACE_GESTURE_MIN_SEPARATION) return false;

      identifiers.forEach((identifier) => {
        suppressedTouchIdsRef.current.delete(identifier);
        pencilGraceGestureTouchIdsRef.current.add(identifier);
      });
      return true;
    }

    function rejectTouchEvent(event) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
    }

    function handlePalmPointerDown(event) {
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
            if (identifier != null) {
              pencilGraceGestureTouchIdsRef.current.delete(identifier);
              suppressedTouchIdsRef.current.add(identifier);
            }
          }
          touchGestureRef.current = null;
          touchGestureGenerationRef.current += 1;
          lastTouchGestureEndedAtRef.current = performance.now();
        }

        penInputRef.current = {
          pointerId: event.pointerId,
          active: true,
          lastSeenAt: Date.now(),
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
        }
        return;
      }

      // A touch arriving while the Pencil is down is a palm/hand contact, not a second
      // drawing pointer. During the brief release grace period only a large contact is
      // rejected, so a deliberate small one-finger stroke can still start immediately.
      if (event.pointerType === 'touch') {
        const contactRadius = Math.max(Number(event?.width ?? 0), Number(event?.height ?? 0));
        const likelyPalm = isLikelyPalmPointer(event);
        const additionalContact = event.isPrimary === false;
        const duringPencil = penInputRef.current.active && (likelyPalm || additionalContact);
        // During the 240 ms post-Pencil grace, reject the first large contact as a
        // possible palm. A normal second contact is left for the touch recognizer,
        // while an exceptionally broad second contact remains blocked as a palm.
        const duringGrace = Date.now() < Number(penInputRef.current.suppressUntil ?? 0)
          && likelyPalm
          && (event.isPrimary !== false || contactRadius > PENCIL_GRACE_GESTURE_MAX_RADIUS);
        if (duringPencil || duringGrace) rejectPointerEvent(event);
      }
    }

    function handlePalmPointerMove(event) {
      if (event.pointerType === 'pen') {
        penInputRef.current.lastSeenAt = Date.now();
        return;
      }
      if (rejectedPointerIdsRef.current.has(event.pointerId)) rejectPointerEvent(event);
    }

    function handlePalmPointerEnd(event) {
      if (event.pointerType === 'pen' && penInputRef.current.pointerId === event.pointerId) {
        const now = Date.now();
        penInputRef.current.active = false;
        penInputRef.current.pointerId = null;
        penInputRef.current.lastSeenAt = now;
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
    }


    function activateObjectEraserPointer(event) {
      window.clearTimeout(objectEraserDelayTimer);
      objectEraserDelayTimer = null;
      erasingRef.current = true;
      objectEraserRecordsRef.current = new Map();
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
      if (!canEditRef.current || ![...event.dataTransfer.items].some((item) => item.kind === 'file')) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    }

    function handleDrop(event) {
      if (!canEditRef.current) return;
      const files = [...(event.dataTransfer?.files ?? [])].filter(isAcceptedImageFile);
      if (!files.length) return;
      event.preventDefault();
      event.stopPropagation();
      addImageFiles(files, scenePointFromClient(event.clientX, event.clientY));
    }

    touchTarget.addEventListener('pointerdown', handlePalmPointerDown, { passive: false, capture: true });
    touchTarget.addEventListener('pointermove', handlePalmPointerMove, { passive: false, capture: true });
    touchTarget.addEventListener('pointerup', handlePalmPointerEnd, { passive: false, capture: true });
    touchTarget.addEventListener('pointercancel', handlePalmPointerEnd, { passive: false, capture: true });
    touchTarget.addEventListener('pointerdown', handleObjectEraserPointerDown, { passive: false, capture: true });
    touchTarget.addEventListener('pointermove', handleObjectEraserPointerMove, { passive: false, capture: true });
    touchTarget.addEventListener('pointerup', handleObjectEraserPointerEnd, { passive: false, capture: true });
    touchTarget.addEventListener('pointercancel', handleObjectEraserPointerEnd, { passive: false, capture: true });
    host.addEventListener('dragover', handleDragOver);
    host.addEventListener('drop', handleDrop);

    function cancelActiveDrawingForTouchGesture() {
      if (lineRef.current) {
        const line = lineRef.current;
        lineRef.current = null;
        lineStartRef.current = null;
        finishLiveDraw('cancel', line.creationSessionId ?? liveDrawSendRef.current.sessionId);
        applyingRemoteRef.current = true;
        canvas.remove(line);
        applyingRemoteRef.current = false;
      }
      if (shapeDraftRef.current) {
        const draft = shapeDraftRef.current;
        shapeDraftRef.current = null;
        endLiveTransform(draft.object);
        applyingRemoteRef.current = true;
        canvas.remove(draft.object);
        applyingRemoteRef.current = false;
        sendDeletes([draft.object.boardObjectId]);
      }
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
      const fingerIds = fingers.map((touch) => touchId(touch)).filter((identifier) => identifier != null);
      touchGestureRef.current = {
        generation,
        fingerIds,
        pencilGraceBypass: fingerIds.length === 2
          && fingerIds.every((identifier) => pencilGraceGestureTouchIdsRef.current.has(identifier)),
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

    function finishTouchGesture(gesture, { restoreInput = true, remainingTouches = [] } = {}) {
      if (!gesture || touchGestureRef.current !== gesture) return false;
      if (gesture.pencilGraceBypass) {
        const remainingIds = new Set(
          touchArray(remainingTouches)
            .filter((touch) => !isStylusTouch(touch))
            .map((touch) => touchId(touch))
            .filter((identifier) => identifier != null),
        );
        for (const identifier of gesture.fingerIds ?? []) {
          pencilGraceGestureTouchIdsRef.current.delete(identifier);
          // If one finger remains after the pinch ends, keep it suppressed until its
          // own touchend so it cannot turn into an accidental one-finger stroke.
          if (remainingIds.has(identifier)) suppressedTouchIdsRef.current.add(identifier);
        }
      }
      touchGestureRef.current = null;
      touchGestureGenerationRef.current = Math.max(
        touchGestureGenerationRef.current,
        Number(gesture.generation ?? 0),
      ) + 1;
      lastTouchGestureEndedAtRef.current = performance.now();
      if (gesture.active && restoreInput) applyCanvasInputMode();
      return Boolean(gesture.active);
    }

    function activateTouchGesture(gesture) {
      if (!gesture || gesture.active) return;
      cancelActiveDrawingForTouchGesture();
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
      // Two distinct normal contacts may intentionally start pan/zoom immediately
      // after Pencil-up. They bypass only the post-Pencil grace filter; the existing
      // 80 ms + 6 px arming thresholds still have to confirm the gesture.
      armPencilGraceTwoFingerGesture(event);
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
        const palmContacts = graceContacts.filter((touch) => (
          !isStylusTouch(touch)
          && !isPencilGraceGestureTouch(touch)
          && isLikelyPalmTouch(touch)
        ));
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

    function handleTouchStart(event) {
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
        activateTouchGesture(gesture);
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
      if (shouldSuppressTouchEvent(event, { ending: true })) {
        releaseEndedPencilGraceGestureTouches(event);
        return;
      }
      try {
        const gestureAtEventStart = touchGestureRef.current;
        const belongsToCurrentGesture = !gestureAtEventStart
          || touchEventBelongsToGesture(event, gestureAtEventStart);
        const handledSecretGesture = finishMobileGameLibraryTouchStage(event);
        if (handledSecretGesture) {
          rejectTouchEvent(event);
          if (event.touches.length === 0
            && gestureAtEventStart
            && belongsToCurrentGesture) {
            finishTouchGesture(gestureAtEventStart, { remainingTouches: event.touches });
          }
          return;
        }

        const gesture = touchGestureRef.current;
        if (!gesture || gesture !== gestureAtEventStart || !belongsToCurrentGesture) return;
        const fingers = unsuppressedFingerTouches(event.touches);
        if (fingers.length >= 2) return;
        rejectTouchEvent(event);
        finishTouchGesture(gesture, { remainingTouches: event.touches });
      } finally {
        releaseEndedPencilGraceGestureTouches(event);
      }
    }

    function handleTouchCancel(event) {
      resetMobileGameLibraryGesture();
      if (shouldSuppressTouchEvent(event, { ending: true })) {
        releaseEndedPencilGraceGestureTouches(event);
        return;
      }
      try {
        const gesture = touchGestureRef.current;
        if (gesture && touchEventBelongsToGesture(event, gesture)) {
          finishTouchGesture(gesture, { remainingTouches: event.touches });
        }
        rejectTouchEvent(event);
      } finally {
        releaseEndedPencilGraceGestureTouches(event);
      }
    }

    touchTarget.addEventListener('touchstart', handleTouchStart, { passive: false, capture: true });
    touchTarget.addEventListener('touchmove', handleTouchMove, { passive: false, capture: true });
    touchTarget.addEventListener('touchend', handleTouchEnd, { passive: false, capture: true });
    touchTarget.addEventListener('touchcancel', handleTouchCancel, { passive: false, capture: true });

    function handleContextMenu(event) {
      event.preventDefault();
    }

    function handleWindowBlur() {
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

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('paste', handlePaste);
    window.addEventListener('blur', handleWindowBlur);
    touchTarget.addEventListener('contextmenu', handleContextMenu);

    return () => {
      disposed = true;
      window.clearTimeout(textChangeTimerRef.current);
      window.clearTimeout(objectEraserDelayTimer);
      window.clearTimeout(objectEraserRealtimeTimerRef.current);
      objectEraserRealtimeTimerRef.current = null;
      objectEraserRealtimeDeleteIdsRef.current.clear();
      window.clearTimeout(viewSendRef.current.timer);
      window.clearTimeout(remotePreviewPendingRef.current.timer);
      remotePreviewPendingRef.current.timer = null;
      remotePreviewPendingRef.current.draining = false;
      remotePreviewPendingRef.current.records.clear();
      remotePreviewChunksRef.current.clear();
      stopArrowPan();
      window.removeEventListener('keydown', handleKeyDown);
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
      host.removeEventListener('dragover', handleDragOver);
      host.removeEventListener('drop', handleDrop);
      window.clearInterval(syncInterval);
      window.clearInterval(localLockRefreshInterval);
      window.clearInterval(pendingImageRetryInterval);
      window.clearInterval(lockCleanupInterval);
      window.clearTimeout(cursorSendRef.current.timer);
      window.clearTimeout(liveTransformSendRef.current.timer);
      window.clearTimeout(liveDrawSendRef.current.timer);
      pendingPencilQueueRef.current.forEach((pending) => window.clearTimeout(pending.cancelTimer));
      pendingPencilQueueRef.current = [];
      activePencilRef.current = null;
      rejectedPointerIdsRef.current.clear();
      suppressedTouchIdsRef.current.clear();
      pencilGraceGestureTouchIdsRef.current.clear();
      touchGestureRef.current = null;
      touchGestureGenerationRef.current = 0;
      lastTouchGestureEndedAtRef.current = 0;
      liveTransformSendRef.current.sessionId = null;
      liveTransformSendRef.current.lastSignature = '';
      liveTransformSendRef.current.pendingTarget = null;
      liveDrawSendRef.current.sessionId = null;
      liveDrawSendRef.current.lastSentPointIndex = 0;
      liveDrawSendRef.current.points = [];
      liveDrawSendRef.current.acceptingPoints = false;
      remoteTransformSessionsRef.current.clear();
      remoteTransformClientOrderRef.current.clear();
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
        });
      }
      localSelectionTransactionRef.current = null;
      window.clearTimeout(transientStatusTimerRef.current);
      window.removeEventListener('focus', syncOnFocus);
      window.removeEventListener('pageshow', syncOnPageShow);
      window.removeEventListener('online', syncOnOnline);
      document.removeEventListener('visibilitychange', syncOnVisibility);
      boardReadyRef.current = false;
      if (selectionBoxRef.current) {
        canvas.remove(selectionBoxRef.current);
        selectionBoxRef.current = null;
      }
      restoreSelectionMemberControls();
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
    if (!isOwner || !autopilot) return undefined;
    sendTeacherViewNow('view');
    const timer = window.setInterval(() => sendTeacherViewNow('view'), 500);
    return () => window.clearInterval(timer);
  }, [autopilot, isOwner, sendTeacherViewNow]);

  useEffect(() => {
    canEditRef.current = canEdit;
    if (!canEdit) {
      eyedropperActiveRef.current = false;
      eyedropperModeRef.current = null;
      eyedropperSelectionIdsRef.current = [];
      eyedropperSelectionTransactionIdRef.current = null;
      setEyedropperActive(false);
      activeToolRef.current = 'select';
      setToolState('select');
    }
    configureBrushAndMode();
  }, [canEdit, configureBrushAndMode]);

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
        onPaste={() => pasteSelection()}
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
