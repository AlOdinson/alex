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

function gateMessage(state, permission) {
  if (state === 'error') return 'Не удалось подключить сохранение — редактирование отключено';
  if (permission === 'owner') return 'Доска открыта в другой вкладке — ожидаю доступ';
  return 'Подключаю редактирование…';
}

function installDurableEditGate() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__alexDurableEditGateInstalled) return;
  window.__alexDurableEditGateInstalled = true;

  const boardId = currentBoardId();
  if (!boardId) return;

  let state = 'booting';
  let permission = '';
  let blocked = true;
  let badge = null;

  const updateDataset = () => {
    const root = document.documentElement;
    if (!root?.dataset) return;
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
    if (!blocked || state === 'booting') {
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
    badge.textContent = gateMessage(state, permission);
  };

  const applyRuntimeState = (detail = {}) => {
    if (String(detail.boardId ?? '') !== boardId) return;
    state = String(detail.state ?? 'waiting');
    permission = String(detail.permission ?? '');
    blocked = shouldBlockDurableEdit({ state, permission });
    updateDataset();
    showBadge();
  };

  const blockInput = (event) => {
    if (!blocked || !isBoardCanvasTarget(event.target)) return;
    if (event.cancelable) event.preventDefault();
    event.stopImmediatePropagation?.();
  };

  updateDataset();
  window.addEventListener(RUNTIME_STATE_EVENT, (event) => applyRuntimeState(event.detail ?? {}));
  BLOCKED_INPUT_EVENTS.forEach((type) => {
    window.addEventListener(type, blockInput, { capture: true, passive: false });
  });
}

installDurableEditGate();
