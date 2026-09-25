// Recovery of bootstrap signaling only. Never carries board actions or replaces
// ICE/TURN routing. The existing network startup deadline still owns failure.
export const SIGNALING_ASSIST_DELAYS_MS = Object.freeze([3000, 8000]);
const MAX_REPLAYS = 2;
const MAX_CACHED_CANDIDATES = 16;
const CANDIDATE_SPACING_MS = 150;

export function signalingNegotiationId(signal) {
  const value = signal?.negotiationId;
  return typeof value === 'string' && value.length > 0 && value.length <= 128 ? value : '';
}

function boundedCopy(value, limit) {
  try {
    const text = JSON.stringify(value);
    return new TextEncoder().encode(text).byteLength <= limit ? JSON.parse(text) : null;
  } catch { return null; }
}

export function createPeerSignalingAssistance({ enabled = false, initiator = false,
  send, isOpen = () => false, isClosed = () => false } = {}) {
  let stopped = !enabled;
  let armed = false;
  let active = false;
  let replays = 0;
  let description = null;
  const candidates = new Map();
  const timers = new Set();
  const available = () => !stopped && !isClosed() && !isOpen();
  const later = (fn, delay) => {
    const timer = setTimeout(() => { timers.delete(timer); if (available()) fn(); }, delay);
    timer?.unref?.(); timers.add(timer);
  };
  const stop = () => {
    stopped = true; active = false; description = null; candidates.clear();
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  };
  // A missing Ably publish receipt must not block a later finite replay. Sends
  // are paced and bounded independently of receipt promises; errors are reported
  // by the original send wrapper and never become orphan rejections here.
  const publish = (message) => {
    Promise.resolve().then(() => available() ? send(message) : undefined).catch(() => undefined);
  };
  const replay = () => {
    if (!available() || active || replays >= MAX_REPLAYS || !description) return false;
    replays++; active = true;
    const pending = [...candidates.values()];
    publish(description);
    const next = () => {
      if (!available()) { stop(); return; }
      if (!pending.length) { active = false; return; }
      publish(pending.shift());
      if (pending.length) later(next, CANDIDATE_SPACING_MS); else active = false;
    };
    if (pending.length) later(next, CANDIDATE_SPACING_MS); else active = false;
    return true;
  };
  return {
    rememberDescription(signal) {
      if (!available()) return;
      description = boundedCopy(signal, 48000);
      if (!armed && initiator && description?.type === 'offer') {
        armed = true;
        for (const delay of SIGNALING_ASSIST_DELAYS_MS) later(replay, delay);
      }
    },
    rememberCandidate(signal) {
      if (!available()) return;
      const copy = boundedCopy(signal, 4000);
      if (!copy) return;
      const key = JSON.stringify(copy);
      if (candidates.has(key)) return;
      if (candidates.size >= MAX_CACHED_CANDIDATES) candidates.delete(candidates.keys().next().value);
      candidates.set(key, copy);
    },
    replay,
    stop,
  };
}
