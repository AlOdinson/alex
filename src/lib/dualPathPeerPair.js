import { createBrowserPeerConnection } from './browserPeerConnection.js';
import { signalingNegotiationId } from './peerSignalingAssistance.js';

export const OWNER_INITIATED_PATH = 'owner-initiated';
export const STUDENT_INITIATED_PATH = 'student-initiated';

const VALID_PATHS = new Set([OWNER_INITIATED_PATH, STUDENT_INITIATED_PATH]);
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_DISCONNECT_GRACE_MS = 3_500;
// Probe directions sequentially so a dead ICE route cannot interfere with the viable route.
const DEFAULT_PRIMARY_PATH_TIMEOUT_MS = 4_000;
const CONTROL_REPLAY_DELAYS_MS = Object.freeze([500, 1_500]);

function positiveTimeout(value, fallback) {
  const milliseconds = Number(value);
  return Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : fallback;
}

function safePath(value) {
  const path = String(value ?? '');
  return VALID_PATHS.has(path) ? path : '';
}

export function createDualPathPeerPair({
  localRole,
  peerId,
  signaling,
  rtcConfig = {},
  enableLiveChannel = true,
  connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
  disconnectGraceMs = DEFAULT_DISCONNECT_GRACE_MS,
  primaryPathTimeoutMs = DEFAULT_PRIMARY_PATH_TIMEOUT_MS,
  // Kept for rolling compatibility with callers from the parallel-race release.
  ownerPreferenceGraceMs: _ownerPreferenceGraceMs = null,
  createConnection = createBrowserPeerConnection,
  onSelectedChannel = () => {},
  onSelectedLiveChannel = () => {},
  onSelectedPath = () => {},
  onState = () => {},
  onFatal = () => {},
  onError = () => {},
} = {}) {
  const role = String(localRole ?? '');
  if (role !== 'owner' && role !== 'student') throw new Error('localRole must be owner or student');
  const remoteId = String(peerId ?? '').trim();
  if (!remoteId) throw new Error('peerId is required');
  if (!signaling?.send) throw new Error('signaling bridge is required');

  const localInitiatedPath = role === 'owner' ? OWNER_INITIATED_PATH : STUDENT_INITIATED_PATH;
  const remoteInitiatedPath = role === 'owner' ? STUDENT_INITIATED_PATH : OWNER_INITIATED_PATH;
  const candidates = new Map();
  const retiredNegotiations = new Set();
  const controlTimers = new Set();

  let started = false;
  let closed = false;
  let fatal = false;
  let activePath = OWNER_INITIATED_PATH;
  let selectedPath = '';
  let pendingSelectedPath = '';
  let selectedAttached = false;
  let selectedLiveAttached = false;
  let fallbackStarted = false;
  let deadlineTimer = null;
  let primaryTimer = null;

  const reportError = (error) => {
    try { onError(error instanceof Error ? error : new Error(String(error))); } catch { /* observer */ }
  };

  const later = (fn, delay) => {
    const timer = setTimeout(() => {
      controlTimers.delete(timer);
      if (!closed) fn();
    }, delay);
    timer?.unref?.();
    controlTimers.add(timer);
  };

  const clearControlTimers = () => {
    for (const timer of controlTimers) clearTimeout(timer);
    controlTimers.clear();
  };

  const clearPrimaryTimer = () => {
    clearTimeout(primaryTimer);
    primaryTimer = null;
  };

  const clearDeadline = () => {
    clearTimeout(deadlineTimer);
    deadlineTimer = null;
  };

  const retireNegotiation = (candidate) => {
    const id = String(candidate?.negotiationId ?? '');
    if (!id) return;
    if (retiredNegotiations.size >= 64) retiredNegotiations.delete(retiredNegotiations.values().next().value);
    retiredNegotiations.add(id);
  };

  function closeCandidate(candidate) {
    if (!candidate || candidate.closed) return;
    candidate.closed = true;
    clearTimeout(candidate.disconnectTimer);
    candidate.disconnectTimer = null;
    retireNegotiation(candidate);
    try { candidate.connection?.close?.(); } catch (error) { reportError(error); }
  }

  function removeCandidate(path) {
    const resolved = safePath(path);
    const candidate = candidates.get(resolved);
    if (!candidate) return;
    closeCandidate(candidate);
    candidates.delete(resolved);
  }

  function failPair(error) {
    if (closed || fatal) return;
    fatal = true;
    clearDeadline();
    clearPrimaryTimer();
    clearControlTimers();
    try { onState('failed', selectedPath || activePath); } catch { /* observer */ }
    try { onFatal(error instanceof Error ? error : new Error(String(error))); } catch { /* observer */ }
  }

  function sendControl(signal) {
    Promise.resolve(signaling.send(remoteId, signal)).catch(reportError);
  }

  function replayControl(signal) {
    sendControl(signal);
    for (const delay of CONTROL_REPLAY_DELAYS_MS) later(() => sendControl(signal), delay);
  }

  function attachSelectedIfReady() {
    if (closed || !selectedPath) return false;
    const candidate = candidates.get(selectedPath);
    if (!candidate?.durableChannel || candidate.closed) return false;

    if (!selectedAttached) {
      selectedAttached = true;
      clearDeadline();
      clearPrimaryTimer();
      clearControlTimers();
      try { onSelectedChannel(candidate.durableChannel, selectedPath); }
      catch (error) { failPair(error); return false; }
      try { onSelectedPath(selectedPath); } catch (error) { reportError(error); }
      try { onState('connected', selectedPath); } catch { /* observer */ }
    }

    if (candidate.liveChannel && !selectedLiveAttached && enableLiveChannel) {
      selectedLiveAttached = true;
      try { onSelectedLiveChannel(candidate.liveChannel, selectedPath); } catch (error) { reportError(error); }
    }
    return true;
  }

  function selectPath(path, { notify = role === 'owner' } = {}) {
    const resolved = safePath(path);
    if (!resolved || closed) return false;
    if (selectedPath && selectedPath !== resolved) return false;
    if (resolved !== activePath) return false;

    const candidate = candidates.get(resolved);
    if (!candidate?.durableChannel) {
      pendingSelectedPath = resolved;
      return true;
    }

    pendingSelectedPath = '';
    selectedPath = resolved;
    if (notify) {
      replayControl({
        type: 'path-select',
        path: resolved,
        ...(candidate.negotiationId ? { negotiationId: candidate.negotiationId } : {}),
      });
    }
    return attachSelectedIfReady() || true;
  }

  function createCandidate(path) {
    const resolved = safePath(path);
    if (!resolved) throw new Error('Unsupported WebRTC path');
    const existing = candidates.get(resolved);
    if (existing && !existing.closed) return existing;

    const initiator = resolved === localInitiatedPath;
    const candidate = {
      path: resolved,
      initiator,
      connection: null,
      durableChannel: null,
      liveChannel: null,
      negotiationId: '',
      started: false,
      failed: false,
      closed: false,
      disconnectTimer: null,
    };

    const connection = createConnection({
      initiator,
      enableLiveChannel: Boolean(enableLiveChannel),
      assistSignaling: true,
      rtcConfig,
      sendSignal: (signal) => {
        const negotiationId = signalingNegotiationId(signal);
        if (negotiationId) candidate.negotiationId = negotiationId;
        return signaling.send(remoteId, { ...signal, path: resolved });
      },
      onChannel: (channel) => handleDurableOpen(candidate, channel),
      onLiveChannel: (channel) => handleLiveOpen(candidate, channel),
      onConnectionState: (state) => handleConnectionState(candidate, state),
      onError: reportError,
    });
    candidate.connection = connection;
    candidates.set(resolved, candidate);
    return candidate;
  }

  function startCandidate(candidate) {
    if (!candidate || candidate.started || candidate.closed) return;
    candidate.started = true;
    Promise.resolve(candidate.connection?.start?.()).catch((error) => {
      reportError(error);
      if (candidate.durableChannel) return;
      handleCandidateFailure(candidate, error);
    });
  }

  function activatePath(path) {
    const resolved = safePath(path);
    if (!resolved || closed || selectedAttached) return null;
    if (activePath !== resolved) {
      removeCandidate(activePath);
      activePath = resolved;
      pendingSelectedPath = '';
    }
    const candidate = createCandidate(resolved);
    startCandidate(candidate);
    return candidate;
  }

  function switchToStudentPath({ notify = role === 'owner' } = {}) {
    if (closed || selectedAttached) return false;
    if (activePath === STUDENT_INITIATED_PATH && fallbackStarted) return true;

    fallbackStarted = true;
    clearPrimaryTimer();
    clearControlTimers();
    removeCandidate(OWNER_INITIATED_PATH);
    activePath = STUDENT_INITIATED_PATH;
    pendingSelectedPath = '';

    const candidate = createCandidate(STUDENT_INITIATED_PATH);
    startCandidate(candidate);

    if (notify) {
      replayControl({ type: 'path-switch', path: STUDENT_INITIATED_PATH });
    }
    return true;
  }

  function handleDurableOpen(candidate, channel) {
    if (closed || candidate.closed || candidate.path !== activePath) {
      try { channel?.close?.(); } catch { /* stale */ }
      return;
    }
    candidate.durableChannel = channel;
    candidate.failed = false;

    // Sequential probing guarantees there is only one active native path.
    // Therefore an open durable channel is itself the selection proof; never block
    // editing on a second Ably control message after SCTP is already usable.
    selectPath(candidate.path, { notify: role === 'owner' });
  }

  function handleLiveOpen(candidate, channel) {
    if (closed || candidate.closed || candidate.path !== activePath || !enableLiveChannel) {
      try { channel?.close?.(); } catch { /* unused */ }
      return;
    }
    candidate.liveChannel = channel;
    if (selectedPath === candidate.path) attachSelectedIfReady();
  }

  function handleCandidateFailure(candidate, error) {
    if (!candidate || candidate.closed) return;
    candidate.failed = true;
    clearTimeout(candidate.disconnectTimer);
    candidate.disconnectTimer = null;

    if (selectedPath === candidate.path) {
      failPair(error ?? new Error('Selected WebRTC path failed'));
      return;
    }

    if (candidate.path === OWNER_INITIATED_PATH && !fallbackStarted) {
      removeCandidate(OWNER_INITIATED_PATH);
      if (role === 'owner') switchToStudentPath({ notify: true });
      else switchToStudentPath({ notify: false });
      return;
    }

    removeCandidate(candidate.path);
    failPair(error ?? new Error('Fallback WebRTC path failed'));
  }

  function handleConnectionState(candidate, state) {
    if (closed || candidate.closed) return;
    const normalized = String(state ?? 'unknown');

    if (selectedPath === candidate.path) {
      try { onState(normalized, candidate.path); } catch { /* observer */ }
    }

    if (normalized === 'disconnected') {
      if (!candidate.disconnectTimer) {
        candidate.disconnectTimer = setTimeout(() => {
          candidate.disconnectTimer = null;
          if (!closed && !candidate.closed) {
            handleCandidateFailure(candidate, new Error('WebRTC path remained disconnected'));
          }
        }, positiveTimeout(disconnectGraceMs, DEFAULT_DISCONNECT_GRACE_MS));
        candidate.disconnectTimer?.unref?.();
      }
      return;
    }

    clearTimeout(candidate.disconnectTimer);
    candidate.disconnectTimer = null;

    if (normalized === 'failed' || normalized === 'closed') {
      handleCandidateFailure(candidate, new Error('WebRTC path ' + normalized));
    }
  }

  function candidateForNegotiationId(negotiationId) {
    if (!negotiationId) return null;
    for (const candidate of candidates.values()) {
      if (candidate.negotiationId === negotiationId) return candidate;
    }
    return null;
  }

  function inferSignalPath(signal) {
    const explicit = safePath(signal?.path);
    if (explicit) return explicit;
    const negotiationId = signalingNegotiationId(signal);
    const matched = candidateForNegotiationId(negotiationId);
    if (matched) return matched.path;
    if (signal?.type === 'offer') return remoteInitiatedPath;
    return activePath;
  }

  function armPrimaryTimer() {
    clearPrimaryTimer();
    primaryTimer = setTimeout(() => {
      primaryTimer = null;
      if (closed || selectedAttached || fallbackStarted) return;
      if (role === 'owner') switchToStudentPath({ notify: true });
      else switchToStudentPath({ notify: false });
    }, positiveTimeout(primaryPathTimeoutMs, DEFAULT_PRIMARY_PATH_TIMEOUT_MS));
    primaryTimer?.unref?.();
  }

  function armDeadline() {
    clearDeadline();
    deadlineTimer = setTimeout(() => {
      deadlineTimer = null;
      if (closed || selectedAttached) return;
      if (!fallbackStarted) {
        switchToStudentPath({ notify: role === 'owner' });
        // Give the fallback a small final window even if the custom total timeout
        // was shorter than the normal primary+fallback budget.
        deadlineTimer = setTimeout(() => {
          deadlineTimer = null;
          if (!closed && !selectedAttached) failPair(new Error('WebRTC connection timed out: no path became usable'));
        }, 3_000);
        deadlineTimer?.unref?.();
        return;
      }
      failPair(new Error('WebRTC connection timed out: no path became usable'));
    }, positiveTimeout(connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS));
    deadlineTimer?.unref?.();
  }

  return {
    start() {
      if (closed) return Promise.reject(new Error('Dual-path peer pair is closed'));
      if (started) return Promise.resolve();
      started = true;
      activePath = OWNER_INITIATED_PATH;
      // Both browsers own exactly one RTCPeerConnection for the active direction:
      // owner starts as initiator, student starts as a silent responder.
      activatePath(OWNER_INITIATED_PATH);
      armPrimaryTimer();
      armDeadline();
      return Promise.resolve();
    },

    async handleSignal(signal) {
      if (closed || !signal || typeof signal !== 'object') return false;
      const type = String(signal.type ?? '');

      if (type === 'path-switch') {
        const path = safePath(signal.path);
        if (path !== STUDENT_INITIATED_PATH) return false;
        if (role === 'student') {
          switchToStudentPath({ notify: false });
          return true;
        }
        return false;
      }

      if (type === 'path-select') {
        if (role !== 'student') return false;
        const path = safePath(signal.path);
        if (!path) return false;
        if (selectedPath === path) return true;
        if (path === STUDENT_INITIATED_PATH && activePath !== STUDENT_INITIATED_PATH) {
          switchToStudentPath({ notify: false });
        }
        selectPath(path, { notify: false });
        return true;
      }

      if (type === 'path-select-request') {
        if (role !== 'owner') return false;
        if (selectedPath) {
          replayControl({
            type: 'path-select',
            path: selectedPath,
            ...(candidates.get(selectedPath)?.negotiationId
              ? { negotiationId: candidates.get(selectedPath).negotiationId }
              : {}),
          });
          return true;
        }
        if (activePath === OWNER_INITIATED_PATH && signal.path === STUDENT_INITIATED_PATH) {
          switchToStudentPath({ notify: true });
        }
        return true;
      }

      if (type === 'role-switch') {
        // Compatibility with the previous protocol: its meaning was "let owner
        // initiate". That is already the primary path in this state machine.
        return true;
      }

      if (type !== 'offer' && type !== 'answer' && type !== 'ice') return false;

      const negotiationId = signalingNegotiationId(signal);
      if (negotiationId && retiredNegotiations.has(negotiationId)) return false;
      const path = inferSignalPath(signal);
      if (!path) return false;

      if (path === STUDENT_INITIATED_PATH && activePath === OWNER_INITIATED_PATH) {
        // A real fallback offer is authoritative proof that the student switched.
        switchToStudentPath({ notify: false });
      }
      if (path !== activePath) return false;

      let candidate = candidates.get(path) ?? null;
      if (type === 'offer' && candidate && negotiationId && candidate.negotiationId
        && negotiationId !== candidate.negotiationId) {
        if (selectedPath === path || candidate.durableChannel) return false;
        removeCandidate(path);
        candidate = null;
      }
      candidate ??= createCandidate(path);
      if (candidate.closed) return false;
      if (negotiationId && !candidate.negotiationId) candidate.negotiationId = negotiationId;
      startCandidate(candidate);

      try {
        await candidate.connection.handleSignal(signal);
      } catch (error) {
        reportError(error);
        if (!candidate.durableChannel) handleCandidateFailure(candidate, error);
        return false;
      }
      return true;
    },

    getSelectedPath() { return selectedPath; },

    getCandidateCount() {
      return [...candidates.values()].filter((candidate) => !candidate.closed).length;
    },

    getCandidateState(path) {
      const candidate = candidates.get(safePath(path));
      if (!candidate) return null;
      return {
        path: candidate.path,
        initiator: candidate.initiator,
        hasDurableChannel: Boolean(candidate.durableChannel),
        hasLiveChannel: Boolean(candidate.liveChannel),
        negotiationId: candidate.negotiationId,
        failed: Boolean(candidate.failed),
        closed: Boolean(candidate.closed),
      };
    },

    close() {
      if (closed) return;
      closed = true;
      clearDeadline();
      clearPrimaryTimer();
      clearControlTimers();
      for (const candidate of candidates.values()) closeCandidate(candidate);
      candidates.clear();
    },
  };
}
