// Navigation is view-only chrome. Never serialize, clip, or edit page contents
// here: the three opaque DOM islands protect controls without destroying ink.
const isNotebook = object => String(object?.type).toLowerCase() === 'boardnotebook';

export function notebookNavigationLayout(notebook, canvas) {
  if (!isNotebook(notebook) || !notebook.boardObjectId || notebook.visible === false) return null;
  const width = Number(notebook.width), height = Number(notebook.height);
  if (!(width > 0 && height > 0)) return null;
  const [a, b, c, d, e, f] = notebook.calcTransformMatrix();
  const [va, vb, vc, vd, ve, vf] = canvas.viewportTransform ?? [1, 0, 0, 1, 0, 0];
  const matrix = [va * a + vc * b, vb * a + vd * b, va * c + vc * d, vb * c + vd * d,
    va * e + vc * f + ve, vb * e + vd * f + vf];
  // Fabric's matrix origin is the frame centre; DOM origin is its top-left.
  matrix[4] -= matrix[0] * width / 2 + matrix[2] * height / 2;
  matrix[5] -= matrix[1] * width / 2 + matrix[3] * height / 2;
  if (!matrix.every(Number.isFinite)) return null;
  return { id: String(notebook.boardObjectId), pageNumber: notebook.notebookPageNumber || 1,
    pageCount: Math.max(1, notebook.notebookPageNumber || 1, notebook.notebookPages?.length || 0),
    position: { width, height, transform: `matrix(${matrix.join(',')})`, transformOrigin: '0 0' } };
}

/** Index only notebook frames. A video/render tick never scans the whole board
 * or touches the visible/hidden child records just to position three controls. */
export function createNotebookNavigationTracker(canvas) {
  const notebooks = new Set(canvas.getObjects().filter(isNotebook));
  const added = canvas.on('object:added', ({ target }) => { if (isNotebook(target)) notebooks.add(target); });
  const removed = canvas.on('object:removed', ({ target }) => notebooks.delete(target));
  let disposed = false;
  return {
    read: () => disposed ? [] : [...notebooks].map(notebook => notebookNavigationLayout(notebook, canvas)).filter(Boolean),
    dispose() { if (disposed) return; disposed = true; added(); removed(); notebooks.clear(); },
  };
}

/** Disable hit-testing, NOT painting, while another surface owns a gesture.
 * The lower/upper canvas continues receiving moves through the white islands.
 * Keep that protection through pointerup's compatibility click (next task).
 * Track TouchEvents too: the existing iPad input adapter may own those instead.
 */
export function installNotebookNavigationInput(layer) {
  const win = layer.ownerDocument.defaultView;
  const pointers = new Set(), touches = new Set();
  let blocked = false, fileDrag = false, timer = null, disposed = false;
  const controlTarget = event => event.target instanceof win.Node && layer.contains(event.target) && Boolean(event.target.closest?.('.notebook-nav-island'));
  const setBlocked = value => {
    blocked = value;
    if (value) layer.dataset.gestureActive = 'true'; else delete layer.dataset.gestureActive;
  };
  const block = () => { win.clearTimeout(timer); timer = null; setBlocked(true); };
  const release = () => {
    if (pointers.size || touches.size || fileDrag) return;
    win.clearTimeout(timer);
    timer = win.setTimeout(() => { timer = null; if (!disposed && !pointers.size && !touches.size && !fileDrag) setBlocked(false); }, 0);
  };
  const pointerDown = event => { if (!controlTarget(event)) { pointers.add(event.pointerId); block(); } };
  const pointerMove = event => { if (event.pointerType === 'mouse' && event.buttons === 0 && pointers.delete(event.pointerId)) release(); };
  const pointerEnd = event => { if (pointers.delete(event.pointerId)) release(); };
  const touchStart = event => {
    if (controlTarget(event)) return;
    for (const touch of event.changedTouches ?? []) touches.add(touch.identifier);
    if (touches.size) block();
  };
  const touchEnd = event => { for (const touch of event.changedTouches ?? []) touches.delete(touch.identifier); release(); };
  const dragEnter = event => {
    if (Array.from(event.dataTransfer?.types ?? []).includes('Files')) { fileDrag = true; block(); }
  };
  const dragEnd = () => { fileDrag = false; release(); };
  const dragLeave = event => {
    if (!event.relatedTarget && [layer.ownerDocument, layer.ownerDocument.documentElement, layer.ownerDocument.body].includes(event.target)) dragEnd();
  };
  const reset = event => {
    // Capture listeners also receive blur from a focused toolbar/button. Only
    // losing the window itself ends a gesture; focus moving to canvas does not.
    if (event?.type === 'blur' && event.target !== win) return;
    win.clearTimeout(timer); timer = null; pointers.clear(); touches.clear(); fileDrag = false; setBlocked(false);
  };
  const listeners = { pointerdown: pointerDown, pointermove: pointerMove, pointerup: pointerEnd, pointercancel: pointerEnd,
    touchstart: touchStart, touchend: touchEnd, touchcancel: touchEnd,
    dragenter: dragEnter, dragleave: dragLeave, drop: dragEnd, dragend: dragEnd, blur: reset, pagehide: reset };
  for (const [type, listener] of Object.entries(listeners)) win.addEventListener(type, listener, { capture: true, passive: true });
  return {
    allowsActivation: () => !disposed && !blocked,
    dispose() {
      if (disposed) return;
      disposed = true; reset();
      for (const [type, listener] of Object.entries(listeners)) win.removeEventListener(type, listener, true);
    },
  };
}

const consume = event => { event.stopPropagation(); if (event.cancelable !== false) event.preventDefault(); };

/** A page turn belongs to a down+up on this button, never to a crossing stroke,
 * cancelled contact, drag off the button, or duplicate compatibility click. */
export function createNotebookNavigationTap({ canActivate, activate }) {
  let contact = null;
  const moved = event => Math.hypot(event.clientX - contact.x, event.clientY - contact.y) > 8;
  return {
    down(event) {
      consume(event);
      contact = null;
      if (!canActivate() || event.isPrimary === false || event.button > 0) return;
      contact = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Detached/cancelled native contact. */ }
    },
    move(event) {
      if (!contact || event.pointerId !== contact.id) return;
      consume(event); contact.moved ||= moved(event);
    },
    up(event) {
      if (!contact || event.pointerId !== contact.id) return;
      consume(event);
      const rect = event.currentTarget.getBoundingClientRect();
      const valid = !contact.moved && !moved(event) && canActivate() && event.currentTarget.isConnected
        && event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
      contact = null;
      try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* Already released by the browser. */ }
      if (valid) activate();
    },
    cancel(event) { if (contact?.id === event.pointerId) contact = null; },
    click(event) {
      consume(event);
      // Enter/Space/assistive activation has no preceding physical contact.
      if (event.detail === 0 && !contact && canActivate()) activate();
    },
  };
}
