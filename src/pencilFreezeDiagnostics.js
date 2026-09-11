const DEBUG_QUERY_KEY = 'pencilDebug';
const SAMPLE_MS = 50;
const EVENT_LOOP_GAP_MS = 180;
const RAF_GAP_MS = 180;
const DELIVERY_LAG_MS = 80;
const MAX_LINES = 600;

function enabled() {
  try {
    return typeof window !== 'undefined'
      && new URLSearchParams(window.location.search).get(DEBUG_QUERY_KEY) === '1';
  } catch {
    return false;
  }
}

function numeric(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? Number(number.toFixed(1)) : fallback;
}

function compact(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return '{"error":"unserializable"}';
  }
}

function pencilSummary() {
  return document.querySelector('[data-pencil-debug-summary="true"]')?.textContent ?? '';
}

function durableEditGateSnapshot() {
  const dataset = document.documentElement?.dataset ?? {};
  return {
    state: String(dataset.alexDurableEditState ?? ''),
    permission: String(dataset.alexDurableEditPermission ?? ''),
    blocked: String(dataset.alexDurableEditBlocked ?? ''),
  };
}

function pageStateSnapshot() {
  let hasFocus = null;
  try {
    hasFocus = typeof document.hasFocus === 'function' ? Boolean(document.hasFocus()) : null;
  } catch {
    hasFocus = null;
  }
  return {
    visibility: String(document.visibilityState ?? 'unknown'),
    hasFocus,
  };
}

function eventDeliveryLagMs(event, now = performance.now()) {
  const stamp = Number(event?.timeStamp);
  if (!Number.isFinite(stamp) || stamp <= 0) return null;

  // Modern Safari uses the performance time origin. Some older WebKit builds used
  // an epoch timestamp, so accept either clock only when the result is plausible.
  const performanceLag = now - stamp;
  if (performanceLag >= 0 && performanceLag < 60_000) return performanceLag;
  const wallLag = Date.now() - stamp;
  if (wallLag >= 0 && wallLag < 60_000) return wallLag;
  return null;
}

function installFreezeDiagnostics() {
  if (!enabled() || document.querySelector('[data-pencil-freeze-debug="true"]')) return null;

  const startedAt = performance.now();
  const lines = [];
  let lastTick = startedAt;
  let lastRafAt = null;
  let lastDeliveryLagLogAt = Number.NEGATIVE_INFINITY;
  let maximumGapMs = 0;
  let maximumRafGapMs = 0;
  let maximumDeliveryLagMs = 0;
  let rafId = null;

  const panel = document.createElement('aside');
  panel.dataset.pencilFreezeDebug = 'true';
  panel.style.cssText = [
    'position:fixed',
    'left:8px',
    'bottom:8px',
    'z-index:2147483646',
    'width:min(360px,calc(100vw - 16px))',
    'max-height:26vh',
    'box-sizing:border-box',
    'padding:8px',
    'border:1px solid rgba(255,255,255,.25)',
    'border-radius:11px',
    'background:rgba(15,23,42,.93)',
    'color:#e2e8f0',
    'font:11px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace',
    'touch-action:manipulation',
  ].join(';');

  const title = document.createElement('div');
  title.textContent = 'Freeze monitor · запись';
  title.style.cssText = 'font-weight:700;color:#f8fafc;margin-bottom:5px';
  const summary = document.createElement('div');
  summary.style.cssText = 'color:#bae6fd;margin-bottom:5px';
  const controls = document.createElement('div');
  controls.style.cssText = 'display:flex;gap:5px;margin-bottom:5px';
  const copyButton = document.createElement('button');
  copyButton.type = 'button';
  copyButton.textContent = 'Скопировать freeze';
  const clearButton = document.createElement('button');
  clearButton.type = 'button';
  clearButton.textContent = 'Очистить';
  for (const button of [copyButton, clearButton]) {
    button.style.cssText = 'font:600 11px -apple-system,BlinkMacSystemFont,sans-serif;padding:5px 7px;border-radius:7px;border:1px solid #64748b;background:#1e293b;color:white';
  }
  controls.append(copyButton, clearButton);
  const output = document.createElement('pre');
  output.style.cssText = 'margin:0;max-height:13vh;overflow:auto;white-space:pre-wrap;color:#bbf7d0';
  panel.append(title, summary, controls, output);
  document.body.append(panel);

  const render = () => {
    summary.textContent = `max UI ${numeric(maximumGapMs, 0)} ms · max frame ${numeric(maximumRafGapMs, 0)} ms · max event ${numeric(maximumDeliveryLagMs, 0)} ms`;
    output.textContent = lines.slice(-20).join('\n');
    output.scrollTop = output.scrollHeight;
  };

  const record = (kind, details = {}) => {
    const elapsed = numeric(performance.now() - startedAt, 0);
    lines.push(`${elapsed}ms ${kind} ${compact({ ...details, pencilSummary: pencilSummary() })}`);
    if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
    render();
  };

  const intervalId = window.setInterval(() => {
    const now = performance.now();
    const elapsed = now - lastTick;
    lastTick = now;
    const gapMs = elapsed - SAMPLE_MS;
    if (gapMs < EVENT_LOOP_GAP_MS) return;
    maximumGapMs = Math.max(maximumGapMs, gapMs);
    record('UI event-loop gap', {
      gapMs: numeric(gapMs),
      tickElapsedMs: numeric(elapsed),
      ...pageStateSnapshot(),
    });
  }, SAMPLE_MS);

  const animationFrameTick = (now) => {
    const state = pageStateSnapshot();
    if (lastRafAt != null && state.visibility === 'visible') {
      const gapMs = Number(now) - lastRafAt;
      if (gapMs >= RAF_GAP_MS) {
        maximumRafGapMs = Math.max(maximumRafGapMs, gapMs);
        record('UI animation-frame gap', {
          gapMs: numeric(gapMs),
          ...state,
        });
      }
    }
    lastRafAt = Number(now);
    rafId = window.requestAnimationFrame?.(animationFrameTick) ?? null;
  };
  if (typeof window.requestAnimationFrame === 'function') {
    rafId = window.requestAnimationFrame(animationFrameTick);
  }

  const pointerHandler = (event) => {
    if (event.pointerType !== 'pen') return;
    if (event.type !== 'pointermove' && event.type !== 'pointerrawupdate') return;
    const now = performance.now();
    const deliveryLagMs = eventDeliveryLagMs(event, now);
    if (deliveryLagMs == null || deliveryLagMs < DELIVERY_LAG_MS) return;
    maximumDeliveryLagMs = Math.max(maximumDeliveryLagMs, deliveryLagMs);
    if (now - lastDeliveryLagLogAt < 250) return;
    lastDeliveryLagLogAt = now;
    record('RAW pointer delivery lag', {
      deliveryLagMs: numeric(deliveryLagMs),
      eventType: event.type,
      pointerId: event.pointerId ?? null,
      buttons: Number(event.buttons ?? 0),
      pressure: numeric(event.pressure, 0),
    });
  };
  window.addEventListener('pointermove', pointerHandler, { capture: true, passive: true });
  window.addEventListener('pointerrawupdate', pointerHandler, { capture: true, passive: true });

  const lifecycleHandler = (event) => {
    if (event.type === 'visibilitychange') lastRafAt = performance.now();
    record(`PAGE ${event.type}`, {
      persisted: typeof event.persisted === 'boolean' ? event.persisted : undefined,
      ...pageStateSnapshot(),
    });
  };
  document.addEventListener?.('visibilitychange', lifecycleHandler, true);
  window.addEventListener('focus', lifecycleHandler, true);
  window.addEventListener('blur', lifecycleHandler, true);
  window.addEventListener('pageshow', lifecycleHandler, true);
  window.addEventListener('pagehide', lifecycleHandler, true);

  const exportText = () => {
    const gate = durableEditGateSnapshot();
    const page = pageStateSnapshot();
    return [
      'Alex Board iPad freeze diagnostic',
      `created=${new Date().toISOString()}`,
      `userAgent=${navigator.userAgent}`,
      `maxUiGapMs=${numeric(maximumGapMs, 0)}`,
      `maxRafGapMs=${numeric(maximumRafGapMs, 0)}`,
      `maxPointerDeliveryLagMs=${numeric(maximumDeliveryLagMs, 0)}`,
      `pageVisibility=${page.visibility}`,
      `pageHasFocus=${page.hasFocus == null ? 'unknown' : String(page.hasFocus)}`,
      `durableEditState=${gate.state}`,
      `durableEditPermission=${gate.permission}`,
      `durableEditBlocked=${gate.blocked}`,
      `pencilSummary=${pencilSummary()}`,
      '--- freeze events ---',
      ...lines,
      '--- visible pencil journal ---',
      document.querySelector('[data-pencil-debug-output="true"]')?.textContent ?? '',
    ].join('\n');
  };

  copyButton.addEventListener('click', async (event) => {
    event.stopPropagation();
    const text = exportText();
    try {
      await navigator.clipboard.writeText(text);
      copyButton.textContent = 'Скопировано';
      window.setTimeout(() => { copyButton.textContent = 'Скопировать freeze'; }, 1400);
    } catch {
      copyButton.textContent = 'Ошибка копирования';
    }
  });
  clearButton.addEventListener('click', (event) => {
    event.stopPropagation();
    lines.length = 0;
    maximumGapMs = 0;
    maximumRafGapMs = 0;
    maximumDeliveryLagMs = 0;
    lastTick = performance.now();
    lastRafAt = lastTick;
    render();
  });

  record('FREEZE diagnostics started', pageStateSnapshot());

  return {
    exportText,
    destroy() {
      window.clearInterval(intervalId);
      if (rafId != null && typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(rafId);
      }
      window.removeEventListener('pointermove', pointerHandler, true);
      window.removeEventListener('pointerrawupdate', pointerHandler, true);
      document.removeEventListener?.('visibilitychange', lifecycleHandler, true);
      window.removeEventListener('focus', lifecycleHandler, true);
      window.removeEventListener('blur', lifecycleHandler, true);
      window.removeEventListener('pageshow', lifecycleHandler, true);
      window.removeEventListener('pagehide', lifecycleHandler, true);
      panel.remove();
    },
  };
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  installFreezeDiagnostics();
}

export {
  durableEditGateSnapshot,
  eventDeliveryLagMs,
  installFreezeDiagnostics,
  pageStateSnapshot,
};
