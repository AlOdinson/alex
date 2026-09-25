import { createVerificationBudget, verificationDigest } from './boundedVerificationDigest.js';

const validId = (value) => typeof value === 'string' && value.length > 0 && value.length <= 200;
export function validVerificationRequest(request) {
  return request?.version === 1 && validId(request.requestId) && validId(request.epoch)
    && Number.isSafeInteger(request.revision) && request.revision >= 0
    && Array.isArray(request.entries) && request.entries.length <= 100
    && new Set(request.entries.map((e) => e?.id)).size === request.entries.length
    && request.entries.every((e) => validId(e?.id) && /^[a-f0-9]{64}$/.test(e?.hash ?? ''))
    && (request.backgroundHash == null || /^[a-f0-9]{64}$/.test(request.backgroundHash));
}

export async function buildVerificationReply(view, request, epoch, options = {}) {
  const base = {
    version: 1, requestId: validId(request?.requestId) ? request.requestId : '',
    epoch, revision: view.revision(),
  };
  if (!validVerificationRequest(request)) return { ...base, status: 'invalid' };
  if (request.epoch !== epoch || request.revision !== view.revision()) return { ...base, status: 'stale' };
  const stamp = view.capture();
  const budget = createVerificationBudget({ ...options,
    isCurrent: () => view.isCurrent(stamp) && (options.isCurrent?.() ?? true),
  });
  try {
    const repairs = [];
    for (const entry of request.entries) {
      const expected = view.read(entry.id);
      const hash = await verificationDigest(expected, { budget });
      if (hash !== entry.hash) repairs.push(expected);
    }
    let background = null;
    if (request.backgroundHash != null
      && await verificationDigest(view.background(), { budget }) !== request.backgroundHash) {
      background = view.background();
    }
    budget.assertCurrent();
    return {
      ...base, status: 'ok', checkedIds: request.entries.map((e) => e.id), repairs, background,
      scan: view.page(request.scanCursor, Math.max(0, Math.min(20, Number(request.scanLimit) || 0))),
    };
  } catch (error) {
    if (error?.name === 'AbortError') return { ...base, revision: view.revision(), status: 'stale' };
    throw error;
  }
}

// One cooperative CPU lane for the local Canvas check and every student request.
// A slow check never joins the durable commit/history queue. Per-peer de-duplication
// bounds this queue by connected peers plus the local checker, not action count.
export function createVerificationWorkLane({
  now = () => globalThis.performance?.now?.() ?? Date.now(),
  schedule = (fn, delay) => setTimeout(fn, delay),
  cancel = (timer) => clearTimeout(timer),
} = {}) {
  const jobs = new Map();
  const waiting = [];
  const controller = new AbortController();
  let active = false;
  let closed = false;
  let timer = null;
  let lastStarted = -Infinity;
  const arm = () => {
    if (closed || active || timer !== null || !waiting.length) return;
    timer = schedule(() => { timer = null; void drain(); }, Math.max(0, lastStarted + 250 - now()));
  };
  const drain = async () => {
    if (closed || active || !waiting.length) return;
    const job = waiting.shift();
    active = true; lastStarted = now();
    try { job.resolve(await job.work(controller.signal)); }
    catch (error) { job.reject(error); }
    finally { jobs.delete(job.key); active = false; arm(); }
  };
  return {
    run(key, work) {
      if (closed) return Promise.reject(new Error('Verification lane closed'));
      if (jobs.has(key)) return Promise.reject(new Error('Verification for this peer is already pending'));
      if (typeof work !== 'function') return Promise.reject(new TypeError('Verification work must be a function'));
      return new Promise((resolve, reject) => {
        const job = { key, work, resolve, reject };
        jobs.set(key, job); waiting.push(job); arm();
      });
    },
    close() {
      if (closed) return;
      closed = true; controller.abort();
      if (timer !== null) cancel(timer);
      timer = null;
      for (const job of jobs.values()) job.reject(new Error('Verification lane closed'));
      jobs.clear(); waiting.length = 0;
    },
  };
}
