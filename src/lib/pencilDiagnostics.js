const DEBUG_QUERY_KEY = 'pencilDebug';
const MAX_LOG_LINES = 4800;
const VISIBLE_LOG_LINES = 80;

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

function pointerHasContact(event) {
  return Number(event?.buttons ?? 0) !== 0 || Number(event?.pressure ?? 0) > 0.001;
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
  let orphanPointerSequence = 0;
  let orphanStylusSequence = 0;
  let mouseContactSequence = 0;
  let renderFrame = null;
  let collapsed = false;
  let mouseContact = null;
  let lastPenEventAt = Number.NEGATIVE_INFINITY;
  const lines = [];
  const pointerContacts = new Map();
  const touchContacts = new Map();
  const orphanPointerContacts = new Map();
  const orphanStylusContacts = new Map();
  const pointerStates = new Map();
  const counters = {
    pointerContacts: 0,
    touchContacts: 0,
    orphanPointerContacts: 0,
    orphanStylusContacts: 0,
    mouseContacts: 0,
    rawUpdates: 0,
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
      `OrphanP:${counters.orphanPointerContacts}`,
      `OrphanT:${counters.orphanStylusContacts}`,
      `Mouse:${counters.mouseContacts}`,
      `Raw:${counters.rawUpdates}`,
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

  const rememberPointerState = (pointerId, value) => {
    pointerStates.delete(pointerId);
    pointerStates.set(pointerId, value);
    if (pointerStates.size > 64) {
      pointerStates.delete(pointerStates.keys().next().value);
    }
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
    const now = performance.now();
    lastPenEventAt = now;
    const pointerId = Number(event.pointerId ?? -1);
    const buttons = Number(event.buttons ?? 0);
    const pressure = numeric(event.pressure, 0);
    const hasContact = pointerHasContact(event);
    const previousState = pointerStates.get(pointerId) ?? null;
    const marker = event.alexStylusTouchFallback
      ? 'synthetic-touch'
      : (event.alexStylusNativeBridge ? 'native-bridge' : 'native');
    if (event.type === 'pointerdown') {
      const orphan = orphanPointerContacts.get(pointerId);
      if (orphan) {
        record('RAW pointerdown after orphan contact', {
          o: orphan.serial,
          pointerId,
          marker,
          ageMs: numeric(now - orphan.startedAt),
          samples: orphan.samples,
          rawUpdates: orphan.rawUpdates,
        });
        orphanPointerContacts.delete(pointerId);
      }
      const previous = pointerContacts.get(pointerId);
      const contact = {
        serial: pointerContactSequence + 1,
        startedAt: now,
        moves: 0,
        rawUpdates: 0,
        firstMoveSeen: false,
        firstRawUpdateSeen: false,
      };
      pointerContactSequence = contact.serial;
      counters.pointerContacts = pointerContactSequence;
      pointerContacts.set(pointerId, contact);
      record('RAW pointerdown', {
        p: contact.serial,
        pointerId,
        marker,
        previousStillOpen: previous?.serial ?? null,
        previousAgeMs: previous ? numeric(now - previous.startedAt) : null,
        ts: numeric(event.timeStamp),
        x: numeric(event.clientX),
        y: numeric(event.clientY),
        buttons,
        pressure,
      });
      rememberPointerState(pointerId, { hasContact, buttons, pressure, type: event.type, at: now });
      return;
    }
    const contact = pointerContacts.get(pointerId);
    if (event.type === 'pointermove' || event.type === 'pointerrawupdate') {
      if (event.type === 'pointerrawupdate') counters.rawUpdates += 1;
      if (contact) {
        if (event.type === 'pointermove') contact.moves += 1;
        else contact.rawUpdates += 1;
        const firstForType = event.type === 'pointermove'
          ? !contact.firstMoveSeen
          : !contact.firstRawUpdateSeen;
        if (event.type === 'pointermove') contact.firstMoveSeen = true;
        else contact.firstRawUpdateSeen = true;
        if (firstForType) {
          record(`RAW first ${event.type}`, {
            p: contact.serial,
            pointerId,
            marker,
            ts: numeric(event.timeStamp),
            x: numeric(event.clientX),
            y: numeric(event.clientY),
            buttons,
            pressure,
          });
        }
        if (previousState && previousState.hasContact !== hasContact) {
          record('RAW pointer contact-state transition', {
            p: contact.serial,
            pointerId,
            eventType: event.type,
            fromContact: previousState.hasContact,
            toContact: hasContact,
            previousButtons: previousState.buttons,
            buttons,
            previousPressure: previousState.pressure,
            pressure,
            ts: numeric(event.timeStamp),
            x: numeric(event.clientX),
            y: numeric(event.clientY),
          });
        }
        rememberPointerState(pointerId, { hasContact, buttons, pressure, type: event.type, at: now });
        return;
      }

      let orphan = orphanPointerContacts.get(pointerId);
      if (hasContact) {
        if (!orphan) {
          orphan = {
            serial: orphanPointerSequence + 1,
            startedAt: now,
            samples: 0,
            rawUpdates: 0,
          };
          orphanPointerSequence = orphan.serial;
          counters.orphanPointerContacts = orphanPointerSequence;
          orphanPointerContacts.set(pointerId, orphan);
          record('RAW orphan pen contact start', {
            o: orphan.serial,
            pointerId,
            eventType: event.type,
            marker,
            previousEventType: previousState?.type ?? null,
            previousButtons: previousState?.buttons ?? null,
            previousPressure: previousState?.pressure ?? null,
            ts: numeric(event.timeStamp),
            x: numeric(event.clientX),
            y: numeric(event.clientY),
            buttons,
            pressure,
          });
        }
        orphan.samples += 1;
        if (event.type === 'pointerrawupdate') orphan.rawUpdates += 1;
        if (orphan.samples > 1) {
          record('RAW orphan pen contact sample', {
            o: orphan.serial,
            pointerId,
            eventType: event.type,
            sample: orphan.samples,
            ts: numeric(event.timeStamp),
            x: numeric(event.clientX),
            y: numeric(event.clientY),
            buttons,
            pressure,
          });
        }
      } else if (orphan) {
        record('RAW orphan pen contact end by hover', {
          o: orphan.serial,
          pointerId,
          eventType: event.type,
          ageMs: numeric(now - orphan.startedAt),
          samples: orphan.samples,
          rawUpdates: orphan.rawUpdates,
          ts: numeric(event.timeStamp),
          x: numeric(event.clientX),
          y: numeric(event.clientY),
          buttons,
          pressure,
        });
        orphanPointerContacts.delete(pointerId);
      }
      rememberPointerState(pointerId, { hasContact, buttons, pressure, type: event.type, at: now });
      return;
    }
    const orphan = orphanPointerContacts.get(pointerId);
    if (orphan) {
      record(`RAW orphan pen ${event.type}`, {
        o: orphan.serial,
        pointerId,
        marker,
        ageMs: numeric(now - orphan.startedAt),
        samples: orphan.samples,
        rawUpdates: orphan.rawUpdates,
        ts: numeric(event.timeStamp),
        x: numeric(event.clientX),
        y: numeric(event.clientY),
        buttons,
        pressure,
      });
      orphanPointerContacts.delete(pointerId);
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
      rawUpdates: contact?.rawUpdates ?? 0,
      buttons,
      pressure,
    });
    if (event.type === 'pointerup' || event.type === 'pointercancel') {
      pointerContacts.delete(pointerId);
      pointerStates.delete(pointerId);
    }
  };

  const touchHandler = (event) => {
    if (event.target?.closest?.('[data-pencil-debug-panel="true"]')) return;
    const changed = Array.from(event.changedTouches ?? event.touches ?? []);
    if (!changed.length) return;
    if (event.type === 'touchmove') {
      for (const touch of changed) {
        if (String(touch?.touchType ?? '').toLowerCase() !== 'stylus') continue;
        const identifier = Number(touch.identifier ?? -1);
        const contact = touchContacts.get(identifier);
        if (contact) {
          contact.moves = Number(contact.moves ?? 0) + 1;
          if (contact.moves === 1) {
            record('RAW first stylus touchmove', {
              t: contact.serial,
              ts: numeric(event.timeStamp),
              touch: touchSummary(touch),
              totalTouches: Number(event.touches?.length ?? 0),
            });
          }
          continue;
        }
        let orphan = orphanStylusContacts.get(identifier);
        if (!orphan) {
          orphan = {
            serial: orphanStylusSequence + 1,
            startedAt: performance.now(),
            samples: 0,
          };
          orphanStylusSequence = orphan.serial;
          counters.orphanStylusContacts = orphanStylusSequence;
          orphanStylusContacts.set(identifier, orphan);
          record('RAW orphan stylus touchmove start', {
            ot: orphan.serial,
            touchId: identifier,
            ts: numeric(event.timeStamp),
            touch: touchSummary(touch),
            totalTouches: Number(event.touches?.length ?? 0),
          });
        }
        orphan.samples += 1;
        if (orphan.samples > 1) {
          record('RAW orphan stylus touchmove sample', {
            ot: orphan.serial,
            touchId: identifier,
            sample: orphan.samples,
            ts: numeric(event.timeStamp),
            touch: touchSummary(touch),
            totalTouches: Number(event.touches?.length ?? 0),
          });
        }
      }
      return;
    }
    for (const touch of changed) {
      const identifier = Number(touch.identifier ?? -1);
      if (event.type === 'touchstart') {
        const orphan = orphanStylusContacts.get(identifier);
        if (orphan) {
          record('RAW touchstart after orphan stylus move', {
            ot: orphan.serial,
            touchId: identifier,
            ageMs: numeric(performance.now() - orphan.startedAt),
            samples: orphan.samples,
          });
          orphanStylusContacts.delete(identifier);
        }
        const previous = touchContacts.get(identifier);
        const contact = {
          serial: touchContactSequence + 1,
          startedAt: performance.now(),
          moves: 0,
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
        const orphan = orphanStylusContacts.get(identifier);
        if (!contact && orphan) {
          record(`RAW orphan stylus ${event.type}`, {
            ot: orphan.serial,
            touchId: identifier,
            ageMs: numeric(performance.now() - orphan.startedAt),
            samples: orphan.samples,
            ts: numeric(event.timeStamp),
            touch: touchSummary(touch),
            totalTouches: Number(event.touches?.length ?? 0),
          });
          orphanStylusContacts.delete(identifier);
        }
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

  const mouseHandler = (event) => {
    if (event.target?.closest?.('[data-pencil-debug-panel="true"]')) return;
    const now = performance.now();
    const buttons = Number(event.buttons ?? 0);
    const details = {
      x: numeric(event.clientX),
      y: numeric(event.clientY),
      button: Number(event.button ?? -1),
      buttons,
      ts: numeric(event.timeStamp),
      firesTouchEvents: Boolean(event.sourceCapabilities?.firesTouchEvents),
      trusted: Boolean(event.isTrusted),
      sinceLastPenEventMs: numeric(now - lastPenEventAt),
    };
    if (event.type === 'mousedown') {
      mouseContact = {
        serial: mouseContactSequence + 1,
        startedAt: now,
        moves: 0,
        implicit: false,
      };
      mouseContactSequence = mouseContact.serial;
      counters.mouseContacts = mouseContactSequence;
      record('RAW compatibility mousedown', { m: mouseContact.serial, ...details });
      return;
    }
    if (event.type === 'mousemove') {
      if (!mouseContact && buttons !== 0) {
        mouseContact = {
          serial: mouseContactSequence + 1,
          startedAt: now,
          moves: 0,
          implicit: true,
        };
        mouseContactSequence = mouseContact.serial;
        counters.mouseContacts = mouseContactSequence;
        record('RAW orphan compatibility mouse contact', {
          m: mouseContact.serial,
          ...details,
        });
      }
      if (!mouseContact) return;
      mouseContact.moves += 1;
      if (mouseContact.moves === 1) {
        record('RAW first compatibility mousemove', {
          m: mouseContact.serial,
          implicit: mouseContact.implicit,
          ...details,
        });
      }
      return;
    }
    record('RAW compatibility mouseup', {
      m: mouseContact?.serial ?? null,
      implicit: mouseContact?.implicit ?? null,
      ageMs: mouseContact ? numeric(now - mouseContact.startedAt) : null,
      moves: mouseContact?.moves ?? 0,
      ...details,
    });
    mouseContact = null;
  };

  const rawListeners = [
    ['pointerdown', pointerHandler],
    ['pointermove', pointerHandler],
    ['pointerrawupdate', pointerHandler],
    ['pointerup', pointerHandler],
    ['pointercancel', pointerHandler],
    ['touchstart', touchHandler],
    ['touchmove', touchHandler],
    ['touchend', touchHandler],
    ['touchcancel', touchHandler],
    ['mousedown', mouseHandler],
    ['mousemove', mouseHandler],
    ['mouseup', mouseHandler],
  ];
  rawListeners.forEach(([type, handler]) => {
    window.addEventListener(type, handler, { capture: true, passive: true });
  });

  const makeExport = () => {
    updateSummary();
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
      `openPointerContacts=${pointerContacts.size}`,
      `openOrphanPointerContacts=${orphanPointerContacts.size}`,
      `openOrphanStylusContacts=${orphanStylusContacts.size}`,
      `openMouseContact=${mouseContact ? 1 : 0}`,
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
    orphanPointerSequence = 0;
    orphanStylusSequence = 0;
    mouseContactSequence = 0;
    mouseContact = null;
    lastPenEventAt = Number.NEGATIVE_INFINITY;
    pointerContacts.clear();
    touchContacts.clear();
    orphanPointerContacts.clear();
    orphanStylusContacts.clear();
    pointerStates.clear();
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

  record('DEBUG started', {
    pointerEventSupported: typeof window.PointerEvent === 'function',
    pointerRawUpdateSupported: 'onpointerrawupdate' in window,
    touchEventSupported: typeof window.TouchEvent === 'function',
  });

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
