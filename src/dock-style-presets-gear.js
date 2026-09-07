function createPresetsGearIcon() {
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');
  svg.classList.add('dock-style-presets-gear-icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  const ring = document.createElementNS(namespace, 'circle');
  ring.setAttribute('cx', '12');
  ring.setAttribute('cy', '12');
  ring.setAttribute('r', '4');

  const teeth = document.createElementNS(namespace, 'path');
  teeth.setAttribute(
    'd',
    'M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1',
  );

  svg.append(ring, teeth);
  return svg;
}

function openPresetEditorPanel() {
  const sourceGear = document.querySelector('.drawing-presets-gear');
  if (!(sourceGear instanceof HTMLButtonElement)) return false;
  sourceGear.click();
  return true;
}

function ensurePresetsGear() {
  const shell = document.querySelector('.dock-style-right-accessories');
  if (!(shell instanceof HTMLElement)) return false;

  let gear = shell.querySelector('.dock-style-presets-gear');
  if (gear instanceof HTMLButtonElement) return true;

  gear = document.createElement('button');
  gear.type = 'button';
  gear.className = 'dock-style-presets-gear';
  gear.dataset.dockStyleAction = 'edit-presets';
  gear.setAttribute('aria-label', 'Редактировать пресеты');
  gear.title = 'Редактировать пресеты';
  gear.append(createPresetsGearIcon());
  gear.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    openPresetEditorPanel();
  });

  shell.append(gear);
  return true;
}

if (typeof document !== 'undefined') {
  if (!ensurePresetsGear()) {
    const observer = new MutationObserver(() => {
      if (!ensurePresetsGear()) return;
      observer.disconnect();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
}
