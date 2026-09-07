function createHistoryIcon(kind) {
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');
  svg.classList.add('dock-history-icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  const arrow = document.createElementNS(namespace, 'path');
  const arc = document.createElementNS(namespace, 'path');

  if (kind === 'redo') {
    arrow.setAttribute('d', 'M16 5 19.5 8.5 16 12');
    arc.setAttribute('d', 'M19.2 8.5A7.5 7.5 0 1 0 18.4 16.8');
  } else {
    arrow.setAttribute('d', 'M8 5 4.5 8.5 8 12');
    arc.setAttribute('d', 'M4.8 8.5A7.5 7.5 0 1 1 5.6 16.8');
  }

  svg.append(arrow, arc);
  return svg;
}

function installHistoryIcon(button, kind) {
  if (!(button instanceof HTMLButtonElement)) return false;
  if (button.querySelector('.dock-history-icon')) return true;
  button.replaceChildren(createHistoryIcon(kind));
  return true;
}

function installHistoryIcons() {
  const undo = document.querySelector('.dock-history-undo');
  const redo = document.querySelector('.dock-history-redo');
  const undoReady = installHistoryIcon(undo, 'undo');
  const redoReady = installHistoryIcon(redo, 'redo');
  return undoReady && redoReady;
}

if (typeof document !== 'undefined') {
  if (!installHistoryIcons()) {
    const observer = new MutationObserver(() => {
      if (!installHistoryIcons()) return;
      observer.disconnect();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
}
