const SETTINGS_ROOT_ID = 'alex-board-settings-root';
const BRING_CLASS = 'alex-settings-source-bring';
const OWNER_NAV_CLASS = 'alex-settings-owner-navigation';

const COPY = {
  ru: {
    settings: 'Настройки',
    share: 'Поделиться',
    export: 'Экспорт',
    background: 'Фон',
    screenShare: 'ShareScreen',
    stopShare: 'Stop Share',
    bring: 'Ко мне',
    bringTitle: 'Переместить всех учеников к текущему месту на доске',
    backgrounds: { grid: 'Клетки', dots: 'Точки', blank: 'Белый лист' },
  },
  en: {
    settings: 'Settings',
    share: 'Share',
    export: 'Export',
    background: 'Background',
    screenShare: 'ShareScreen',
    stopShare: 'Stop Share',
    bring: 'Bring here',
    bringTitle: 'Move all students to your current board view',
    backgrounds: { grid: 'Grid', dots: 'Dots', blank: 'Blank' },
  },
};

function boardToolbar() {
  return document.querySelector('.toolbar-shell');
}

function sourceControls() {
  const bringStudents = document.querySelector(`.${BRING_CLASS}`)
    || [...document.querySelectorAll('.navigation-actions .navigation-text-button')].find((button) => {
      const text = button.textContent?.trim();
      const title = button.getAttribute('title') || '';
      return text === 'Ко мне'
        || text === 'Bring here'
        || title.includes('переместить всех учеников')
        || title.includes('Move all students instantly');
    })
    || null;

  return {
    share: document.querySelector('.toolbar-share-button'),
    export: document.querySelector('.toolbar-export-button'),
    background: document.querySelector('.toolbar-secondary-row .background-control select'),
    language: [...document.querySelectorAll('.toolbar-secondary-row .language-toggle button')],
    screenShare: document.querySelector('.desktop-screen-share .navigation-text-button'),
    bringStudents,
  };
}

function currentLanguage(controls = sourceControls()) {
  return controls.language.find((button) => button.classList.contains('active'))?.textContent?.trim().toLowerCase() === 'en'
    ? 'en'
    : 'ru';
}

function iconSvg(name) {
  const common = 'viewBox="0 0 24 24" aria-hidden="true" focusable="false"';
  if (name === 'share') return `<svg ${common}><circle cx="18" cy="5" r="2.2"/><circle cx="6" cy="12" r="2.2"/><circle cx="18" cy="19" r="2.2"/><path d="m8 11 7.8-4.6M8 13l7.8 4.6"/></svg>`;
  if (name === 'export') return `<svg ${common}><path d="M12 3v11m0 0 4-4m-4 4-4-4M5 15v4h14v-4"/></svg>`;
  if (name === 'background') return `<svg ${common}><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M4 9h16M9 4v16"/></svg>`;
  if (name === 'language') return `<svg ${common}><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>`;
  return `<svg ${common}><rect x="3.5" y="5" width="17" height="12" rx="2.5"/><path d="M9 20h6M12 17v3"/></svg>`;
}

function createSettingsRoot() {
  const root = document.createElement('div');
  root.id = SETTINGS_ROOT_ID;
  root.innerHTML = `
    <button type="button" class="alex-settings-gear" aria-haspopup="menu" aria-expanded="false">
      <span class="alex-settings-gear-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" focusable="false">
          <path d="M9.45 3.15h5.1l.46 2.02c.62.22 1.2.55 1.72.99l1.98-.63 2.55 4.42-1.53 1.39c.12.65.12 1.31 0 1.96l1.53 1.39-2.55 4.42-1.98-.63a7.4 7.4 0 0 1-1.72.99l-.46 2.02h-5.1l-.46-2.02a7.4 7.4 0 0 1-1.72-.99l-1.98.63-2.55-4.42 1.53-1.39a7.3 7.3 0 0 1 0-1.96L2.74 9.95l2.55-4.42 1.98.63a7.4 7.4 0 0 1 1.72-.99l.46-2.02Z"/>
          <circle cx="12" cy="12.32" r="3.25"/>
        </svg>
      </span>
    </button>
    <div class="alex-settings-menu" role="menu" hidden>
      <button type="button" class="alex-settings-item" data-action="share" role="menuitem">
        <span class="alex-settings-item-icon">${iconSvg('share')}</span>
        <span class="alex-settings-item-label"></span>
      </button>
      <button type="button" class="alex-settings-item" data-action="export" role="menuitem">
        <span class="alex-settings-item-icon">${iconSvg('export')}</span>
        <span class="alex-settings-item-label"></span>
        <span class="alex-settings-chevron" aria-hidden="true">›</span>
      </button>
      <button type="button" class="alex-settings-item" data-action="background" role="menuitem" aria-expanded="false">
        <span class="alex-settings-item-icon">${iconSvg('background')}</span>
        <span class="alex-settings-item-label"></span>
        <span class="alex-settings-item-value" data-current-background></span>
      </button>
      <div class="alex-settings-backgrounds" hidden>
        <button type="button" data-background="grid"></button>
        <button type="button" data-background="dots"></button>
        <button type="button" data-background="blank"></button>
      </div>
      <button type="button" class="alex-settings-item" data-action="language" role="menuitem">
        <span class="alex-settings-item-icon">${iconSvg('language')}</span>
        <span class="alex-settings-item-label">RU / EN</span>
        <span class="alex-settings-item-value" data-current-language></span>
      </button>
      <button type="button" class="alex-settings-item" data-action="screenShare" role="menuitem">
        <span class="alex-settings-item-icon">${iconSvg('screenShare')}</span>
        <span class="alex-settings-item-label"></span>
        <span class="alex-settings-live-indicator" aria-hidden="true"></span>
      </button>
    </div>
  `;
  document.body.append(root);

  const gear = root.querySelector('.alex-settings-gear');
  const menu = root.querySelector('.alex-settings-menu');
  const backgrounds = root.querySelector('.alex-settings-backgrounds');

  function closeMenu() {
    menu.hidden = true;
    backgrounds.hidden = true;
    gear.setAttribute('aria-expanded', 'false');
    root.querySelector('[data-action="background"]')?.setAttribute('aria-expanded', 'false');
  }

  gear.addEventListener('click', () => {
    const nextOpen = menu.hidden;
    menu.hidden = !nextOpen;
    gear.setAttribute('aria-expanded', String(nextOpen));
    if (!nextOpen) backgrounds.hidden = true;
  });

  root.addEventListener('click', (event) => {
    const backgroundChoice = event.target.closest('[data-background]');
    if (backgroundChoice) {
      const controls = sourceControls();
      if (!controls.background) return;
      controls.background.value = backgroundChoice.dataset.background;
      controls.background.dispatchEvent(new Event('change', { bubbles: true }));
      backgrounds.hidden = true;
      root.querySelector('[data-action="background"]')?.setAttribute('aria-expanded', 'false');
      queueMicrotask(syncBoardSettingsUi);
      return;
    }

    const actionButton = event.target.closest('[data-action]');
    if (!actionButton) return;
    const controls = sourceControls();
    const action = actionButton.dataset.action;

    if (action === 'share') {
      controls.share?.click();
      closeMenu();
      return;
    }
    if (action === 'export') {
      controls.export?.click();
      closeMenu();
      return;
    }
    if (action === 'background') {
      const open = backgrounds.hidden;
      backgrounds.hidden = !open;
      actionButton.setAttribute('aria-expanded', String(open));
      return;
    }
    if (action === 'language') {
      const language = currentLanguage(controls);
      controls.language.find((button) => button.textContent?.trim().toLowerCase() === (language === 'ru' ? 'en' : 'ru'))?.click();
      queueMicrotask(syncBoardSettingsUi);
      return;
    }
    if (action === 'screenShare') {
      if (!controls.screenShare?.disabled) controls.screenShare?.click();
      closeMenu();
    }
  });

  document.addEventListener('pointerdown', (event) => {
    if (!root.contains(event.target)) closeMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeMenu();
  });

  return root;
}

function markBringStudentsControl(controls) {
  const button = controls.bringStudents;
  if (!button) return;
  button.classList.add(BRING_CLASS);
  button.closest('.navigation-actions')?.classList.add(OWNER_NAV_CLASS);
  const language = currentLanguage(controls);
  button.setAttribute('aria-label', COPY[language].bring);
  button.setAttribute('title', COPY[language].bringTitle);

  const editRail = document.querySelector('.toolbar-secondary-row .edit-actions');
  const copyButton = editRail?.querySelector('.tool-button');
  if (!editRail || !copyButton) return;
  const rect = copyButton.getBoundingClientRect();
  const railRect = editRail.getBoundingClientRect();
  const gap = 4;
  button.style.left = `${Math.round(rect.left)}px`;
  button.style.top = `${Math.round(railRect.top - rect.height - gap)}px`;
  button.style.width = `${Math.round(rect.width)}px`;
  button.style.height = `${Math.round(rect.height)}px`;
}

function syncSettingsMenu(root, controls) {
  const language = currentLanguage(controls);
  const copy = COPY[language];
  const gear = root.querySelector('.alex-settings-gear');
  gear.setAttribute('title', copy.settings);
  gear.setAttribute('aria-label', copy.settings);

  const labels = {
    share: copy.share,
    export: copy.export,
    background: copy.background,
    screenShare: controls.screenShare?.classList.contains('active') || controls.screenShare?.textContent?.includes('Stop')
      ? copy.stopShare
      : copy.screenShare,
  };
  for (const [action, label] of Object.entries(labels)) {
    const item = root.querySelector(`[data-action="${action}"]`);
    if (!item) continue;
    item.querySelector('.alex-settings-item-label').textContent = label;
  }

  const shareItem = root.querySelector('[data-action="share"]');
  const backgroundItem = root.querySelector('[data-action="background"]');
  const screenShareItem = root.querySelector('[data-action="screenShare"]');
  shareItem.hidden = !controls.share;
  backgroundItem.hidden = !controls.background;
  screenShareItem.hidden = !controls.screenShare;
  screenShareItem.disabled = Boolean(controls.screenShare?.disabled);
  screenShareItem.classList.toggle('is-active', Boolean(controls.screenShare?.classList.contains('active')));

  const currentBackground = controls.background?.value || 'grid';
  const currentBackgroundNode = root.querySelector('[data-current-background]');
  currentBackgroundNode.textContent = copy.backgrounds[currentBackground] || '';
  for (const button of root.querySelectorAll('[data-background]')) {
    const value = button.dataset.background;
    button.textContent = copy.backgrounds[value] || value;
    button.classList.toggle('active', value === currentBackground);
  }

  root.querySelector('[data-current-language]').textContent = language.toUpperCase();
}

let scheduled = false;
function syncBoardSettingsUi() {
  scheduled = false;
  const toolbar = boardToolbar();
  let root = document.getElementById(SETTINGS_ROOT_ID);
  if (!toolbar) {
    root?.remove();
    return;
  }
  if (!root) root = createSettingsRoot();
  const controls = sourceControls();
  markBringStudentsControl(controls);
  syncSettingsMenu(root, controls);
}

function scheduleSync() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(syncBoardSettingsUi);
}

const observer = new MutationObserver(scheduleSync);
observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'disabled', 'aria-pressed'] });
window.addEventListener('resize', scheduleSync, { passive: true });
window.visualViewport?.addEventListener('resize', scheduleSync, { passive: true });
queueMicrotask(scheduleSync);
