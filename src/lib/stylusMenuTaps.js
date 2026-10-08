// Safari may omit one of the stylus TouchEvent callbacks for a rapid second
// tap. Use the matching pen PointerEvents as a fallback instead of locking
// a button for 900ms after its last activation.
const PAIR_WINDOW_MS = 160;
const GHOST_CLICK_WINDOW_MS = 750;

export function changedStylusTouch(event) {
  return Array.from(event?.changedTouches ?? []).find(
    touch => String(touch?.touchType ?? '').toLowerCase() === 'stylus',
  ) ?? null;
}

export function createStylusMenuTapController({
  activate,
  isDisabled = () => false,
  actionPhase = () => 'end',
  now = () => performance.now(),
}) {
  let contact = null;
  let pendingGhostClicks = 0;
  let lastPenActionAt = -Infinity;
  let serial = 0;

  function begin(source, id) {
    const at = now();
    const same = contact && !contact.handled && !contact.finished
      && at >= contact.at && at - contact.at <= PAIR_WINDOW_MS
      && (source === 'pointer'
        ? contact.pointerId == null && contact.touchId != null
        : contact.touchId == null && contact.pointerId != null);
    if (!same) contact = { id: ++serial, at, pointerId: null, touchId: null,
      handled: false, finished: false, cancelled: false };
    if (source === 'pointer') contact.pointerId = id;
    else contact.touchId = id;
    return contact;
  }

  function fire(event, inputType) {
    if (isDisabled() || !contact || contact.handled || contact.cancelled) return false;
    contact.handled = true;
    lastPenActionAt = now();
    pendingGhostClicks = Math.min(8, pendingGhostClicks + 1);
    activate({ inputType, nativeEvent: event });
    return true;
  }

  function onTouchStart(event) {
    const touch = changedStylusTouch(event);
    if (!touch) {
      if (Array.from(event?.changedTouches ?? []).some(t => (
        String(t.touchType ?? '').toLowerCase() === 'direct'
      ))) pendingGhostClicks = 0;
      return false;
    }
    if (isDisabled()) return false;
    begin('touch', touch.identifier);
    event.stopPropagation?.();
    if (actionPhase() === 'start') fire(event, 'stylus-touchstart');
    return true;
  }

  function onTouchEnd(event) {
    const touch = changedStylusTouch(event);
    if (!touch || isDisabled()) return false;
    if (contact?.touchId != null && contact.touchId !== touch.identifier) {
      // A distinct touchend can arrive without the corresponding touchstart.
      if (!contact.handled || !contact.finished) return false;
      begin('touch', touch.identifier);
    }
    if (!contact) begin('touch', touch.identifier);
    if (!contact.handled && !contact.cancelled && actionPhase() === 'end') {
      fire(event, 'stylus-touchend');
    }
    contact.finished = true;
    event.stopPropagation?.();
    return true;
  }

  function onPointerDown(event) {
    if (event?.pointerType === 'pen' && !isDisabled()) {
      begin('pointer', event.pointerId);
      return true;
    }
    if (event?.pointerType === 'touch' || event?.pointerType === 'mouse') {
      // A NEW real finger/mouse press is never a ghost from the old pen press.
      pendingGhostClicks = 0;
    }
    return false;
  }

  function onPointerUp(event) {
    if (event?.pointerType !== 'pen' || isDisabled()) return false;
    if (contact?.pointerId != null && contact.pointerId !== event.pointerId) return false;
    if (!contact) begin('pointer', event.pointerId);
    if (!contact.handled && !contact.cancelled && actionPhase() === 'end') {
      fire(event, 'stylus-pointerup');
    }
    contact.finished = true;
    return true;
  }

  function onCancel(event) {
    if (!contact) return;
    if (event?.pointerType === 'pen') {
      if (contact.pointerId == null || contact.pointerId === event.pointerId) {
        contact.cancelled = true;
        contact.finished = true;
      }
    } else if (Array.from(event?.changedTouches ?? []).some(t => t.identifier === contact.touchId)) {
      contact.cancelled = true;
      contact.finished = true;
    }
  }

  function onClick(event) {
    const source = event?.nativeEvent ?? event;
    const secondDoubleTap = Number(source?.detail ?? event?.detail ?? 0) >= 2
      && pendingGhostClicks === 1;
    if (pendingGhostClicks > 0 && now() - lastPenActionAt >= 0
      && now() - lastPenActionAt < GHOST_CLICK_WINDOW_MS && !secondDoubleTap) {
      pendingGhostClicks--;
      event.preventDefault?.();
      event.stopPropagation?.();
      return false;
    }
    // Safari may omit all pen contact events for the second double-tap.
    // A second click (detail>=2) is an independent activation, not a ghost.
    pendingGhostClicks = 0;
    if (!isDisabled()) activate(event);
    return true;
  }

  return { onTouchStart, onTouchEnd, onPointerDown, onPointerUp, onCancel, onClick,
    getState: () => ({ contact: contact && { ...contact }, pendingGhostClicks }) };
}
