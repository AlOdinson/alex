import { Canvas } from 'fabric';

const PATCH_MARKER = Symbol.for('alex-board.fabric-stylus-touchstart-compatibility');

function isStylusTouch(touch) {
  return String(touch?.touchType ?? '').toLowerCase() === 'stylus';
}

function startsStylusContact(event) {
  try {
    return Array.from(event?.changedTouches ?? []).some(isStylusTouch);
  } catch {
    return false;
  }
}

function stylusSafeTouchEvent(event) {
  // Fabric 7.4 needs the real TouchEvent for its free-drawing bookkeeping, but its
  // drawing-mode _onTouchStart also calls preventDefault(). On iPad WebKit, repeated
  // Pencil contacts can leave the whole page input pipeline temporarily unavailable
  // while JS and requestAnimationFrame continue normally. The board canvas already has
  // touch-action:none, so browser panning/zooming is disabled declaratively; suppressing
  // this one imperative preventDefault keeps Fabric's drawing lifecycle intact without
  // changing finger-only touch handling or enabling Fabric Pointer Events globally.
  return new Proxy(event, {
    get(target, property) {
      if (property === 'preventDefault') return () => {};
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function installFabricStylusTouchCompatibility() {
  const prototype = Canvas?.prototype;
  if (!prototype || prototype[PATCH_MARKER]) return false;
  const originalOnTouchStart = prototype._onTouchStart;
  if (typeof originalOnTouchStart !== 'function') return false;

  Object.defineProperty(prototype, PATCH_MARKER, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: originalOnTouchStart,
  });

  prototype._onTouchStart = function alexStylusTouchStart(event) {
    if (!startsStylusContact(event)) {
      return originalOnTouchStart.call(this, event);
    }
    return originalOnTouchStart.call(this, stylusSafeTouchEvent(event));
  };
  return true;
}

installFabricStylusTouchCompatibility();

export {
  installFabricStylusTouchCompatibility,
  startsStylusContact,
  stylusSafeTouchEvent,
};
