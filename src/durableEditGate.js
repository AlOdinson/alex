const RUNTIME_STATE_EVENT = 'alex-board-runtime-state';
const BOARD_ROUTE_PATTERN = /\/board\/([^/?#]+)/;
const BLOCKED_INPUT_EVENTS = ['pointerdown', 'touchstart', 'mousedown'];

function currentBoardId() {
  if (typeof window === 'undefined') return '';
  const match = String(window.location?.pathname ?? '').match(BOARD_ROUTE_PATTERN);
  try {
    return match?.[1] ? decodeURIComponent(match[1]) : '';
  } catch {
    return match?.[1] ?? '';
  }
}

function isEditablePermission(permission) {
  return permission === 'owner' || permission === 'edit';
}

export function shouldBlockDurableEdit({ state = '', permission = '' } = {}) {
  if (!isEditablePermission(String(permission))) return false;
  return String(state) !== 'ready';
}

function isBoardCanvasTarget(target) {
  if (!target || typeof target.closest !== 'function') return false;
  return Boolean(target.closest('.canvas-container, canvas.upper-canvas, canvas.lower-canvas'));
}

function gateMessage(state, permission, hasSnapshot) {
  if (state === 'teacher-offline') return hasSnapshot
    ? 'Владелец офлайн — сохранённая копия, только просмотр'
    : 'Владелец офлайн — на этом устройстве пока нет сохранённой копии';
  if (state === 'error') return hasSnapshot
    ? 'Нет связи с владельцем — сохранённая копия, только просмотр'
    : 'Нет связи с владельцем — ожидаю содержимое доски';
  if (permission === 'owner') return 'Доска открыта в другой вкладке — ожидаю доступ';
  return 'Подключаю редактирование… Просмотр доступен';
}

function installDurableEditGate() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__alexDurableEditGateInstalled) return;
  window.__alexDurableEditGateInstalled = true;

  let activeBoardId = '';
  let state = 'idle';
  let permission = '';
  let hasSnapshot = false;
  let blocked = false;
  let badge = null;

  const updateDataset = () => {
    const root = document.documentElement;
    if (!root?.dataset) return;
    if (!activeBoardId) {
      delete root.dataset.alexDurableEditBoardId;
      delete root.dataset.alexDurableEditState;
      delete root.dataset.alexDurableEditPermission;
      delete root.dataset.alexDurableEditBlocked;
      return;
    }
    root.dataset.alexDurableEditBoardId = activeBoardId;
    root.dataset.alexDurableEditState = state;
    if (permission) root.dataset.alexDurableEditPermission = permission;
    else delete root.dataset.alexDurableEditPermission;
    root.dataset.alexDurableEditBlocked = blocked ? 'true' : 'false';
  };

  const removeBadge = () => {
    badge?.remove?.();
    badge = null;
  };

  const showBadge = () => {
    if ((!blocked && !(permission === 'view' && state !== 'ready')) || state === 'booting') {
      removeBadge();
      return;
    }
    if (!badge) {
      badge = document.createElement('div');
      badge.dataset.alexDurableEditGate = 'true';
      Object.assign(badge.style, {
        position: 'fixed',
        left: '50%',
        top: '14px',
        transform: 'translateX(-50%)',
        zIndex: '2147483600',
        maxWidth: 'calc(100vw - 28px)',
        padding: '8px 12px',
        borderRadius: '999px',
        background: 'rgba(15, 23, 42, 0.88)',
        color: '#fff',
        font: '600 13px/1.25 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
        textAlign: 'center',
        pointerEvents: 'none',
        boxShadow: '0 6px 20px rgba(15,23,42,.22)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
      });
      document.body?.append?.(badge);
    }
    badge.textContent = gateMessage(state, permission, hasSnapshot);
  };

  const syncRouteState = () => {
    const routeBoardId = currentBoardId();
    if (!routeBoardId) {
      if (activeBoardId) {
        activeBoardId = '';
        state = 'idle';
        permission = '';
        blocked = false;
        updateDataset();
        removeBadge();
      }
      return '';
    }
    if (activeBoardId !== routeBoardId) {
      activeBoardId = routeBoardId;
      hasSnapshot = false;
      state = 'booting';
      permission = '';
      blocked = true;
      updateDataset();
      showBadge();
    }
    return routeBoardId;
  };

  const applyRuntimeState = (detail = {}) => {
    const routeBoardId = syncRouteState();
    if (!routeBoardId || String(detail.boardId ?? '') !== routeBoardId) return;
    activeBoardId = routeBoardId;
    state = String(detail.state ?? 'waiting');
    permission = String(detail.permission ?? '');
    blocked = shouldBlockDurableEdit({ state, permission });
    updateDataset();
    showBadge();
  };

  const blockInput = (event) => {
    syncRouteState();
    if (!blocked || !isBoardCanvasTarget(event.target)) return;
    // Board sets this marker only after disabling drawing, object transforms,
    // text editing and all durable commands. Never bypass the owner's tab lock.
    if (permission !== 'owner' && event.target?.closest?.('[data-readonly-navigation="true"]')) return;
    if (event.cancelable) event.preventDefault();
    event.stopImmediatePropagation?.();
  };

  syncRouteState();
  window.addEventListener(RUNTIME_STATE_EVENT, (event) => applyRuntimeState(event.detail ?? {}));
  window.addEventListener('alex-board-readonly-view', (event) => {
    if (!syncRouteState() || String(event.detail?.boardId ?? '') !== activeBoardId) return;
    hasSnapshot = event.detail.hasSnapshot === true;
    showBadge();
  });
  BLOCKED_INPUT_EVENTS.forEach((type) => {
    window.addEventListener(type, blockInput, { capture: true, passive: false });
  });
}

installDurableEditGate();
