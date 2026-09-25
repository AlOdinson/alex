import { INTEGRITY_LIMITS } from './boardIntegrityQueue.js';

const RUNTIME_KEYS = new Set([
  'selectable', 'evented', 'hasControls', 'hasBorders', 'hoverCursor', 'moveCursor',
  'objectCaching', 'pendingImage', 'pendingImageSerialized',
]);
const CANVAS_IGNORED = new Set([...RUNTIME_KEYS, 'version', 'strokeUniform']);
const ignored = (key) => RUNTIME_KEYS.has(key) || key.startsWith('transient');
const MAX_STRING_CHUNK = 1024;

// The budget is cooperative, not a hard real-time promise. Traversal yields within
// large paths/strings too, rather than only between whole Fabric objects.
export function createIntegrityBudget({
  now = () => performance.now(), yieldTask = () => new Promise((resolve) => setTimeout(resolve, 0)),
  isCurrent = () => true, signal = null, sliceMs = INTEGRITY_LIMITS.sliceMs,
} = {}) {
  let started = now();
  let units = 0;
  const assertCurrent = () => {
    if (signal?.aborted || !isCurrent()) throw new Error('Integrity work is stale or aborted');
  };
  return {
    assertCurrent,
    async run(iterator, visit = () => {}) {
      assertCurrent();
      let next;
      while (!(next = iterator.next()).done) {
        visit(next.value);
        units++;
        if (units % 32 === 0 && (now() - started >= sliceMs || units >= 32768)) {
          assertCurrent();
          await yieldTask();
          assertCurrent();
          started = now(); units = 0;
        }
      }
      assertCurrent();
      return next.value;
    },
  };
}

function* canonicalTokens(value, depth = 0) {
  if (depth > 128) throw new Error('Integrity value nesting is too deep');
  if (value === null) { yield 'null;'; return; }
  if (typeof value === 'string') {
    yield `s${value.length}:`;
    for (let i = 0; i < value.length; i += MAX_STRING_CHUNK) yield value.slice(i, i + MAX_STRING_CHUNK);
    yield ';'; return;
  }
  if (typeof value !== 'object') { yield `${typeof value}:${String(value)};`; return; }
  if (Array.isArray(value)) {
    yield `a${value.length}:[`;
    for (const item of value) yield* canonicalTokens(item, depth + 1);
    yield ']'; return;
  }
  yield '{';
  for (const key of Object.keys(value).sort()) {
    if (ignored(key)) continue;
    yield* canonicalTokens(key, depth + 1);
    yield* canonicalTokens(value[key], depth + 1);
  }
  yield '}';
}

// Independent 32-bit accumulators are a drift checksum, never authentication.
export async function fingerprintIntegrityRecord(record, budget = createIntegrityBudget()) {
  let a = 0x811c9dc5; let b = 0x9e3779b9;
  await budget.run(canonicalTokens(record), (token) => {
    for (let i = 0; i < token.length; i++) {
      const code = token.charCodeAt(i);
      a = Math.imul(a ^ code, 0x01000193);
      b = Math.imul(b ^ code, 0x85ebca6b);
    }
  });
  return `${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}`;
}

export function validIntegrityIds(ids) {
  return Array.isArray(ids) && ids.length <= INTEGRITY_LIMITS.batchSize
    && ids.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 128)
    && new Set(ids).size === ids.length;
}

export async function captureIntegrityRecords(source, ids, budget = createIntegrityBudget()) {
  if (!validIntegrityIds(ids)) throw new Error('Invalid integrity record batch');
  const selected = new Map(ids.map((id) => [id, { id, count: 0, object: null, zIndex: -1 }]));
  const objects = source?.snapshot?.canvas?.objects ?? [];
  // Inspect membership/order without cloning or serializing the board. Only the
  // <=100 selected records are fingerprinted. Scanning the ID index itself yields.
  await budget.run((function* () {
    for (let index = 0; index < objects.length; index++) {
      const object = objects[index];
      const record = selected.get(String(object?.boardObjectId ?? ''));
      if (record) { record.count++; record.object = object; record.zIndex = index; }
      yield null;
    }
  }()));
  return [...selected.values()];
}

function* subsetEqual(actual, expected, key = '', depth = 0) {
  yield null;
  if (depth > 128) return false;
  if (CANVAS_IGNORED.has(key) || key.startsWith('transient')) return true;
  if (key === 'type') return String(actual).toLowerCase() === String(expected).toLowerCase();
  if (typeof expected === 'number') return Number.isFinite(Number(actual)) && Math.abs(Number(actual) - expected) <= 0.002;
  if (typeof expected === 'string') {
    if (typeof actual !== 'string' || actual.length !== expected.length) return false;
    for (let i = 0; i < expected.length; i += MAX_STRING_CHUNK) {
      if (actual.slice(i, i + MAX_STRING_CHUNK) !== expected.slice(i, i + MAX_STRING_CHUNK)) return false;
      yield null;
    }
    return true;
  }
  if (expected == null || typeof expected !== 'object') return actual === expected;
  if (!actual || typeof actual !== 'object') return false;
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    for (let i = 0; i < expected.length; i++) if (!(yield* subsetEqual(actual[i], expected[i], '', depth + 1))) return false;
    return true;
  }
  for (const childKey of Object.keys(expected)) {
    // A rendered image may have a device-local blob URL. Its stable storage path
    // is the shared asset identity; loading placeholders are checked separately.
    if (childKey === 'src' && expected.storagePath && actual.storagePath === expected.storagePath) continue;
    const child = childKey === 'objects' && typeof actual.getObjects === 'function'
      ? actual.getObjects()
      : actual[childKey];
    if (!(yield* subsetEqual(child, expected[childKey], childKey, depth + 1))) return false;
  }
  return true;
}

export async function compareIntegrityCanvas(expected, actual, budget = createIntegrityBudget()) {
  const byId = new Map(actual.map((record) => [record.id, record]));
  const mismatches = [];
  for (const record of expected) {
    const found = byId.get(record.id) ?? { count: 0, object: null, zIndex: -1 };
    if (found.protected) continue;
    if (record.count !== found.count || record.zIndex !== found.zIndex
      || !(await budget.run(subsetEqual(found.object, record.object)))) mismatches.push(record.id);
  }
  return mismatches;
}

function* jsonTokens(value, depth = 0) {
  if (depth > 128) throw new Error('Integrity value nesting is too deep');
  if (typeof value === 'string') {
    yield '"';
    for (let i = 0; i < value.length; i += MAX_STRING_CHUNK) yield JSON.stringify(value.slice(i, i + MAX_STRING_CHUNK)).slice(1, -1);
    yield '"'; return;
  }
  if (value === null || typeof value !== 'object') { yield JSON.stringify(value) ?? 'null'; return; }
  if (Array.isArray(value)) {
    yield '[';
    for (let i = 0; i < value.length; i++) { if (i) yield ','; yield* jsonTokens(value[i], depth + 1); }
    yield ']'; return;
  }
  yield '{'; let separator = false;
  for (const key of Object.keys(value)) {
    if (typeof value[key] === 'undefined' || typeof value[key] === 'function') continue;
    if (separator) yield ',';
    separator = true; yield* jsonTokens(key, depth + 1); yield ':'; yield* jsonTokens(value[key], depth + 1);
  }
  yield '}';
}

export async function serializeIntegrityValue(value, budget = createIntegrityBudget()) {
  const parts = [];
  await budget.run(jsonTokens(value), (part) => parts.push(part));
  return parts.join('');
}
