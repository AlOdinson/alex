const DEBUG_QUERY_KEY = 'pencilDebug';
const MAX_LOG_LINES = 2400;
const VISIBLE_LOG_LINES = 70;

function debugEnabled() {
  if (typeof window === 'undefined') return false;
  try {
    return new URLSearchParams(window.location.search).get(DEBUG_QUERY_KEY) === '1';
  } catch {
    return false;
  }
}

function numeric(value, fallback = null) {
  const result = Number(value);
  return Number.isFinite(result) ? Number(result.toFixed(2)) : fallback;
}

function touchSummary(touch) {
  return {
    id: touch?.identifier == null ? null : Number(touch.identifier),
    type: String(touch?.touchType ?? 'unknown'),
    x: numeric(touch?.clientX),
    y: numeric(touch?.clientY),
    force: numeric(touch?.force, 0),
    radiusX: numeric(touch?.radiusX, 0),
    radiusY: numeric(touch?.radiusY, 0),
  };
}

function compactJson(value) {
  try {
    return JSON.stringify(value, (_key, item) => {
      if (typeof item === 'number' && Number.isFinite(item)) return Number(item.toFixed(2));
      return item;
    });
  } catch {
    return '{"error":"unserializable diagnostic data"}';
  }
}

function makeButton(label) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.style.cssText = [
    'border:1px solid rgba(255,255,255,.35)',
    'border-radius:8px',
    'background:#1f2937',
    'color:#fff',
    'font:600 12px/1.2 -apple-system,BlinkMacSystemFont,sans-serif',
    'padding:7px 9px',
  ].join(';');
  return button;
}

export function createPencilDiagnostics({ version = 'diagnostic', getContext = null } = {}) {
  if (!debugEnabled()) return null;

  let startedAt = performance.now();
  let sequence = 0;
  let pointerContactSequence = 0;
  let touchContactSequence = 0;
  let renderFrame = null;
  let collapsed = false;
  const lines = [];
  const pointerContacts = new Map();
  const touchContacts = new Map();
  const counters = {
    pointerContacts: 0,
    touchContacts: 0,
    fabricDowns: 0,
    paths: 0,
    durableEnqueues: 0,
    durableConfirms: 0,
  };

  const panel = document.createElement('aside');
  panel.dataset.pencilDebugPanel = 'true';
  panel.setAttribute('aria-label', 'Диагностика Apple Pencil');
  panel.style.cssText = [
    'position:fixed',
    'right:8px',
    'bottom:8px',
    'z-index:2147483647',
    'width:min(430px,calc(100vw - 16px))',
    'max-height:46vh',
    'box-sizing:border-box',
    'display:flex',
    'flex-direction:column',
    'gap:7px',
    'padding:9px',
    'border:1px solid rgba(255,255,255,.28)',
    'border-radius:12px',
    'background:rgba(10,15,25,.94)',
    'box-shadow:0 8px 30px rgba(0,0,0,.35)',
    'color:#e5e7eb',
    'font:12px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace',
    'touch-action:manipulation',
    '-webkit-user-select:text',
    'user-select:text',
  ].join(';');

  const heading = document.createElement('div');
  heading.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px';
  const title = document.createElement('strong');
  title.textContent = `Pencil Debug ${version}`;
  title.style.cssText = 'font:700 13px/1.2 -apple-system,BlinkMacSystemFont,sans-serif;color:#fff';
  const state = document.createElement('span');
  state.textContent = '● запись';
  state.style.cssText = 'color:#4ade80;font:700 12px/1.2 -apple-system,BlinkMacSystemFont,sans-serif';
  heading.append(title, state);

  const summary = document.createElement('div');
  summary.dataset.pencilDebugSummary = 'true';
  summary.style.cssText = 'color:#bfdbfe;white-space:normal';

  const controls = document.createElement('div');
  controls.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap';
  const clearButton = makeButton('Очистить');
  const copyButton = makeButton('Скопировать журнал');
  const collapseButton = makeButton('Свернуть');
  const copyStatus = document.createElement('span');
  copyStatus.style.cssText = 'align-self:center;color:#93c5fd;font:600 12px/1.2 -apple-system,BlinkMacSystemFont,sans-serif';
  controls.append(clearButton, copyButton, collapseButton, copyStatus);

  const output = document.createElement('pre');
  output.dataset.pencilDebugOutput = 'true';
  output.style.cssText = [
    'margin:0',
    'padding:7px',
    'min-height:70px',
    'max-height:30vh',
    'overflow:auto',
    'border-radius:8px',
    'background:#020617',
    'color:#d1fae5',
    'white-space:pre-wrap',
    'overflow-wrap:anywhere',
    '-webkit-overflow-scrolling:touch',
  ].join(';');
  panel.append(heading, summary, controls, output);
  document.body.append(panel);

  const updateSummary = () => {
    summary.textContent = [
      `P:${counters.pointerContacts}`,
      `T:${counters.touchContacts}`,
      `Fabric↓:${counters.fabricDowns}`,
      `paths:${counters.paths}`,
      `enqueue:${counters.durableEnqueues}`,
      `confirm:${counters.durableConfirms}`,
    ].join(' · ');
  };

  const render = () => {
    renderFrame = null;
    updateSummary();
    if (collapsed) return;
    output.textContent = lines.slice(-VISIBLE_LOG_LINES).join('\n');
    output.scrollTop = output.scrollHeight;
  };

  const scheduleRender = () => {
    if (renderFrame != null) return;
    renderFrame = window.requestAnimationFrame(render);
  };

  const record = (kind, details = {}) => {
    sequence += 1;
    if (kind === 'FABRIC pointerdown') counters.fabricDowns += 1;
    if (kind === 'FABRIC path:created') counters.paths += 1;
    if (kind === 'DURABLE enqueue') counters.durableEnqueues += 1;
    if (kind === 'DURABLE confirmed') counters.durableConfirms += 1;
    const context = typeof getContext === 'function' ? getContext() : null;
    const elapsed = (performance.now() - startedAt).toFixed(1).padStart(8, ' ');
    const suffix = compactJson(context ? { ...details, ctx: context } : details);
    lines.push(`${elapsed} #${String(sequence).padStart(4, '0')} ${kind} ${suffix}`);
    if (lines.length > MAX_LOG_LINES) lines.splice(0, lines.length - MAX_LOG_LINES);
    scheduleRender();
  };

  const pointerHandler = (event) => {
    if (event.target?.closest?.('[data-pencil-debug-panel="true"]')) return;
    if (event.pointerType !== 'pen') return;
    const pointerId = Number(event.pointerId ?? -1);
    const marker = event.alexStylusTouchFallback
      ? 'synthetic-touch'
      : (event.alexStylusNativeBridge ? 'native-bridge' : 'native');
    if (event.type === 'pointerdown') {
      const previous = pointerContacts.get(pointerId);
      const contact = {
        serial: pointerContactSequence + 1,
        startedAt: performance.now(),
        moves: 0,
      };
      pointerContactSequence = contact.serial;
      counters.pointerContacts = pointerContactSequence;
      pointerContacts.set(pointerId, contact);
      record('RAW pointerdown', {
        p: contact.serial,
        pointerId,
        marker,
        previousStillOpen: previous?.serial ?? null,
        previousAgeMs: previous ? numeric(performance.now() - previous.startedAt) : null,
        ts: numeric(event.timeStamp),
        x: numeric(event.clientX),
        y: numeric(event.clientY),
        buttons: Number(event.buttons ?? 0),
        pressure: numeric(event.pressure, 0),
      });
      return;
    }
    const contact = pointerContacts.get(pointerId);
    if (event.type === 'pointermove') {
      if (!contact) return;
      contact.moves += 1;
      if (contact.moves === 1) {
        record('RAW first pointermove', {
          p: contact.serial,
          pointerId,
          marker,
          ts: numeric(event.timeStamp),
          buttons: Number(event.buttons ?? 0),
          pressure: numeric(event.pressure, 0),
        });
      }
      return;
    }
    record(`RAW ${event.type}`, {
      p: contact?.serial ?? null,
      pointerId,
      marker,
      ageMs: contact ? numeric(performance.now() - contact.startedAt) : null,
      moves: contact?.moves ?? 0,
      ts: numeric(event.timeStamp),
      x: numeric(event.clientX),
      y: numeric(event.clientY),
      buttons: Number(event.buttons ?? 0),
      pressure: numeric(event.pressure, 0),
    });
    if (event.type === 'pointerup' || event.type === 'pointercancel') {
      pointerContacts.delete(pointerId);
    }
  };

  const touchHandler = (event) => {
    if (event.target?.closest?.('[data-pencil-debug-panel="true"]')) return;
    const changed = Array.from(event.changedTouches ?? []);
    if (!changed.length || event.type === 'touchmove') return;
    for (const touch of changed) {
      const identifier = Number(touch.identifier ?? -1);
      if (event.type === 'touchstart') {
        const previous = touchContacts.get(identifier);
        const contact = {
          serial: touchContactSequence + 1,
          startedAt: performance.now(),
        };
        touchContactSequence = contact.serial;
        counters.touchContacts = touchContactSequence;
        touchContacts.set(identifier, contact);
        record('RAW touchstart', {
          t: contact.serial,
          previousStillOpen: previous?.serial ?? null,
          previousAgeMs: previous ? numeric(performance.now() - previous.startedAt) : null,
          ts: numeric(event.timeStamp),
          touch: touchSummary(touch),
          totalTouches: Number(event.touches?.length ?? 0),
        });
      } else {
        const contact = touchContacts.get(identifier);
        record(`RAW ${event.type}`, {
          t: contact?.serial ?? null,
          ageMs: contact ? numeric(performance.now() - contact.startedAt) : null,
          ts: numeric(event.timeStamp),
          touch: touchSummary(touch),
          totalTouches: Number(event.touches?.length ?? 0),
        });
        touchContacts.delete(identifier);
      }
    }
  };

  const rawListeners = [
    ['pointerdown', pointerHandler],
    ['pointermove', pointerHandler],
    ['pointerup', pointerHandler],
    ['pointercancel', pointerHandler],
    ['touchstart', touchHandler],
    ['touchend', touchHandler],
    ['touchcancel', touchHandler],
  ];
  rawListeners.forEach(([type, handler]) => {
    window.addEventListener(type, handler, { capture: true, passive: true });
  });

  const makeExport = () => {
    const safePath = `${window.location.origin}${window.location.pathname}`;
    const header = [
      'Alex Board Apple Pencil diagnostic',
      `version=${version}`,
      `created=${new Date().toISOString()}`,
      `page=${safePath}`,
      `userAgent=${navigator.userAgent}`,
      `platform=${navigator.platform ?? ''}`,
      `maxTouchPoints=${Number(navigator.maxTouchPoints ?? 0)}`,
      `viewport=${window.innerWidth}x${window.innerHeight}`,
      `devicePixelRatio=${numeric(window.devicePixelRatio, 1)}`,
      `summary=${summary.textContent}`,
      '--- events ---',
    ];
    return [...header, ...lines].join('\n');
  };

  const copyExport = async () => {
    const text = makeExport();
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.cssText = 'position:fixed;left:-10000px;top:0';
      document.body.append(textarea);
      textarea.focus();
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
    }
    copyStatus.textContent = 'Скопировано';
    window.setTimeout(() => {
      copyStatus.textContent = '';
    }, 1800);
  };

  clearButton.addEventListener('click', () => {
    startedAt = performance.now();
    sequence = 0;
    pointerContactSequence = 0;
    touchContactSequence = 0;
    pointerContacts.clear();
    touchContacts.clear();
    Object.keys(counters).forEach((key) => { counters[key] = 0; });
    lines.length = 0;
    copyStatus.textContent = 'Очищено';
    record('DEBUG reset', {});
  });
  copyButton.addEventListener('click', () => {
    copyExport().catch(() => {
      copyStatus.textContent = 'Не удалось скопировать';
    });
  });
  collapseButton.addEventListener('click', () => {
    collapsed = !collapsed;
    output.hidden = collapsed;
    summary.hidden = collapsed;
    clearButton.hidden = collapsed;
    copyButton.hidden = collapsed;
    copyStatus.hidden = collapsed;
    collapseButton.textContent = collapsed ? 'Развернуть' : 'Свернуть';
    panel.style.maxHeight = collapsed ? 'none' : '46vh';
    scheduleRender();
  });

  const keepPanelEvent = (event) => {
    event.stopPropagation();
  };
  panel.addEventListener('pointerdown', keepPanelEvent);
  panel.addEventListener('touchstart', keepPanelEvent, { passive: true });

  record('DEBUG started', {});

  return {
    record,
    exportText: makeExport,
    destroy() {
      if (renderFrame != null) window.cancelAnimationFrame(renderFrame);
      rawListeners.forEach(([type, handler]) => {
        window.removeEventListener(type, handler, true);
      });
      panel.removeEventListener('pointerdown', keepPanelEvent);
      panel.removeEventListener('touchstart', keepPanelEvent);
      panel.remove();
    },
  };
}
