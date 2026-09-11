export function normalizeHistoryShortcutKey(event = {}) {
  if (!event?.ctrlKey && !event?.metaKey) return null;
  const key = String(event?.key ?? '').toLowerCase();
  const code = String(event?.code ?? '');

  // Board.jsx already handles Latin z/y directly. Only normalize the same
  // physical keys when the active keyboard layout produces another character
  // (for example Russian: KeyZ -> "я", KeyY -> "н").
  if (code === 'KeyZ' && key !== 'z') return 'z';
  if (code === 'KeyY' && key !== 'y') return 'y';
  return null;
}

export function installHistoryKeyboardShortcuts(target = globalThis.window ?? null) {
  if (!target?.addEventListener || !target?.KeyboardEvent) return () => {};

  const handleKeyDown = (event) => {
    const normalizedKey = normalizeHistoryShortcutKey(event);
    if (!normalizedKey) return;

    // Stop the non-Latin event before Board.jsx sees it, then replay the same
    // physical shortcut with only `key` normalized. Dispatch from the original
    // focused target so Board.jsx keeps all of its existing input/text-editing
    // guards and Ctrl/Cmd+Z behavior unchanged.
    event.preventDefault?.();
    event.stopImmediatePropagation?.();

    const dispatchTarget = event.target?.dispatchEvent ? event.target : target;
    const normalizedEvent = new target.KeyboardEvent('keydown', {
      key: normalizedKey,
      code: event.code,
      location: event.location,
      ctrlKey: Boolean(event.ctrlKey),
      metaKey: Boolean(event.metaKey),
      shiftKey: Boolean(event.shiftKey),
      altKey: Boolean(event.altKey),
      repeat: Boolean(event.repeat),
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    dispatchTarget.dispatchEvent(normalizedEvent);
  };

  target.addEventListener('keydown', handleKeyDown, true);
  return () => target.removeEventListener('keydown', handleKeyDown, true);
}

if (typeof window !== 'undefined') installHistoryKeyboardShortcuts(window);
