// These fingerprints detect accidental state divergence. They are not permissions,
// action acknowledgements, or a replacement for the authoritative revision fence.
const LOCAL_KEYS = new Set([
  'selectable', 'evented', 'hasControls', 'hasBorders', 'hoverCursor', 'moveCursor',
  'objectCaching', 'pendingImage', 'pendingImageSerialized',
]);
const CHUNK_CHARS = 4096;
const STRING_PIECE_CHARS = 1024;
const encoder = new TextEncoder();
export const isVerificationKey = (key) => !LOCAL_KEYS.has(key) && !key.startsWith('transient');

function* stringPieces(value) {
  for (let offset = 0; offset < value.length; offset += STRING_PIECE_CHARS) {
    yield value.slice(offset, offset + STRING_PIECE_CHARS);
  }
}

export function* verificationTokens(value, ancestors = new Set(), depth = 0) {
  if (depth > 128) throw new RangeError('Verification data is too deeply nested');
  if (value === null) { yield 'null;'; return; }
  if (typeof value === 'string') {
    yield `s${value.length}:`; yield* stringPieces(value); yield ';'; return;
  }
  if (typeof value === 'number') {
    yield Number.isFinite(value) ? `n${Object.is(value, -0) ? 0 : value};` : 'null;'; return;
  }
  if (typeof value === 'boolean') { yield value ? 'true;' : 'false;'; return; }
  if (typeof value === 'undefined') { yield 'undefined;'; return; }
  if (typeof value !== 'object') throw new TypeError('Only board data may be fingerprinted');
  if (ancestors.has(value)) throw new TypeError('Cyclic verification data');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      yield `a${value.length}:[`;
      for (let i = 0; i < value.length; i++) yield* verificationTokens(value[i] === undefined ? null : value[i], ancestors, depth + 1);
      yield ']';
    } else {
      // Plain serialized board objects have a small number of keys. Large point
      // arrays/strings are traversed in pieces, never JSON.stringify'd wholesale.
      // Match JSON wire semantics: optional undefined properties are omitted by
      // DataChannel JSON but can remain in the teacher's structuredClone state.
      const keys = Object.keys(value).filter((key) => isVerificationKey(key) && value[key] !== undefined).sort();
      yield `o${keys.length}:{`;
      for (const key of keys) {
        yield* verificationTokens(key, ancestors, depth + 1);
        yield* verificationTokens(value[key], ancestors, depth + 1);
      }
      yield '}';
    }
  } finally { ancestors.delete(value); }
}

export function createVerificationBudget({
  signal,
  isCurrent = () => true,
  now = () => globalThis.performance?.now?.() ?? Date.now(),
  yieldControl = () => new Promise((resolve) => setTimeout(resolve, 0)),
  budgetMs = 4,
} = {}) {
  const limit = Number.isFinite(budgetMs) && budgetMs > 0 ? Math.min(4, budgetMs) : 4;
  let began = now();
  const assertCurrent = () => {
    if (signal?.aborted || !isCurrent()) {
      const error = new Error('Verification was superseded');
      error.name = 'AbortError';
      throw error;
    }
  };
  return {
    assertCurrent,
    checkpoint() {
      assertCurrent();
      // Most coordinates fit the current slice. Avoid creating/awaiting a Promise
      // for every scalar: that only builds a microtask chain, not an input turn.
      if (now() - began < limit) return null;
      return (async () => {
        // A task yield, not only a resolved Promise: input/rendering gets a turn.
        await yieldControl();
        assertCurrent();
        began = now();
      })();
    },
  };
}

export async function verificationDigest(value, options = {}) {
  const budget = options.budget ?? createVerificationBudget(options);
  budget.assertCurrent();
  if (!globalThis.crypto?.subtle) throw new Error('Secure digest API is unavailable');
  let previous = new Uint8Array(32);
  let pending = '';
  const fold = async (piece) => {
    const bytes = encoder.encode(piece);
    const input = new Uint8Array(previous.length + bytes.length);
    input.set(previous); input.set(bytes, previous.length);
    previous = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', input));
    budget.assertCurrent();
  };
  for (const token of verificationTokens(value)) {
    pending += token;
    while (pending.length >= CHUNK_CHARS) {
      await fold(pending.slice(0, CHUNK_CHARS));
      pending = pending.slice(CHUNK_CHARS);
    }
    const pause = budget.checkpoint();
    if (pause) await pause;
  }
  if (pending.length) await fold(pending);
  budget.assertCurrent();
  return Array.from(previous, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function* jsonTokens(value, ancestors = new Set(), depth = 0) {
  if (depth > 128) throw new RangeError('Verification response is too deeply nested');
  if (typeof value === 'string') {
    yield '"';
    for (const piece of stringPieces(value)) yield JSON.stringify(piece).slice(1, -1);
    yield '"'; return;
  }
  if (value == null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    yield encoded === undefined ? 'null' : encoded;
    return;
  }
  if (ancestors.has(value)) throw new TypeError('Cyclic verification response');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      yield '[';
      for (let i = 0; i < value.length; i++) {
        if (i) yield ',';
        yield* jsonTokens(value[i], ancestors, depth + 1);
      }
      yield ']';
    } else {
      yield '{'; let first = true;
      for (const key of Object.keys(value)) {
        if (value[key] === undefined) continue;
        if (!first) yield ',';
        first = false;
        yield* jsonTokens(key, ancestors, depth + 1); yield ':';
        yield* jsonTokens(value[key], ancestors, depth + 1);
      }
      yield '}';
    }
  } finally { ancestors.delete(value); }
}

export async function verificationJson(value, options = {}) {
  const budget = options.budget ?? createVerificationBudget(options);
  budget.assertCurrent();
  const parts = [];
  let part = '';
  for (const token of jsonTokens(value)) {
    part += token;
    if (part.length >= CHUNK_CHARS) { parts.push(part); part = ''; }
    const pause = budget.checkpoint();
    if (pause) await pause;
  }
  if (part) parts.push(part);
  budget.assertCurrent();
  return parts.join('');
}
