import { createBrowserPeerConnection } from './browserPeerConnection.js';
import { signalingNegotiationId } from './peerSignalingAssistance.js';

export const OWNER_INITIATED_PATH = 'owner-initiated';
export const STUDENT_INITIATED_PATH = 'student-initiated';

const VALID_PATHS = new Set([OWNER_INITIATED_PATH, STUDENT_INITIATED_PATH]);
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_DISCONNECT_GRACE_MS = 3_500;
const DEFAULT_OWNER_PREFERENCE_GRACE_MS = 1_500;
const SELECT_REPLAY_DELAYS_MS = Object.freeze([500, 1_500]);
const REQUEST_REPLAY_DELAYS_MS = Object.freeze([700, 2_000]);

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
  ownerPreferenceGraceMs = DEFAULT_OWNER_PREFERENCE_GRACE_MS,
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
  const selectionTimers = new Set();
  const requestTimers = new Set();

  let started = false;
  let closed = false;
  let fatal = false;
  let selectedPath = '';
  let pendingSelectedPath = '';
  let selectedAttached = false;
  let selectedLiveAttached = false;
  let remoteDualPathSeen = false;
  let deadlineTimer = null;
  let preferenceTimer = null;

  const reportError = (error) => {
    try { onError(error instanceof Error ? error : new Error(String(error))); } catch { /* observer */ }
  };

  const later = (set, fn, delay) => {
    const timer = setTimeout(() => {
      set.delete(timer);
      if (!closed) fn();
    }, delay);
    timer?.unref?.();
    set.add(timer);
    return timer;
  };

  const clearTimerSet = (set) => {
    for (const timer of set) clearTimeout(timer);
    set.clear();
  };

  const clearPreferenceTimer = () => {
    clearTimeout(preferenceTimer);
    preferenceTimer = null;
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

  function closeLoser() {
    if (!selectedPath) return;
    const loserPath = selectedPath === OWNER_INITIATED_PATH ? STUDENT_INITIATED_PATH : OWNER_INITIATED_PATH;
    closeCandidate(candidates.get(loserPath));
  }

  function failPair(error) {
    if (closed || fatal) return;
    fatal = true;
    clearDeadline();
    clearPreferenceTimer();
    clearTimerSet(selectionTimers);
    clearTimerSet(requestTimers);
    try { onState('failed', selectedPath || ''); } catch { /* observer */ }
    try { onFatal(error instanceof Error ? error : new Error(String(error))); } catch { /* observer */ }
  }

  function attachSelectedIfReady() {
    if (closed || !selectedPath) return false;
    const candidate = candidates.get(selectedPath);
    if (!candidate?.durableChannel || candidate.closed) return false;

    if (!selectedAttached) {
      selectedAttached = true;
      clearDeadline();
      clearPreferenceTimer();
      clearTimerSet(requestTimers);
      try {
        onSelectedChannel(candidate.durableChannel, selectedPath);
      } catch (error) {
        failPair(error);
        return false;
      }
      try { onSelectedPath(selectedPath); } catch (error) { reportError(error); }
      try { onState('connected', selectedPath); } catch { /* observer */ }
      closeLoser();
    }

    if (candidate.liveChannel && !selectedLiveAttached && enableLiveChannel) {
      selectedLiveAttached = true;
      try { onSelectedLiveChannel(candidate.liveChannel, selectedPath); } catch (error) { reportError(error); }
    }
    return true;
  }

  function sendSelection(path) {
    const candidate = candidates.get(path);
    const negotiationId = String(candidate?.negotiationId ?? '');
    const signal = {
      type: 'path-select',
      path,
      ...(negotiationId ? { negotiationId } : {}),
    };
    Promise.resolve(signaling.send(remoteId, signal)).catch(reportError);
  }

  function replaySelection(path) {
    sendSelection(path);
    for (const delay of SELECT_REPLAY_DELAYS_MS) {
      later(selectionTimers, () => {
        if (!closed && selectedPath === path) sendSelection(path);
      }, delay);
    }
  }

  function selectPath(path, { notify = role === 'owner' } = {}) {
    const resolved = safePath(path);
    if (!resolved || closed) return false;
    if (selectedPath && selectedPath !== resolved) return false;
    if (pendingSelectedPath && pendingSelectedPath !== resolved) return false;

    const candidate = candidates.get(resolved);
    if (role === 'student' && !candidate?.durableChannel) {
      pendingSelectedPath = resolved;
      return true;
    }

    pendingSelectedPath = '';
    selectedPath = resolved;
    if (notify) replaySelection(resolved);
    return attachSelectedIfReady() || true;
  }

  function requestSelection() {
    if (closed || role !== 'student' || selectedPath || !remoteDualPathSeen) return;
    const send = () => Promise.resolve(signaling.send(remoteId, { type: 'path-select-request' })).catch(reportError);
    send();
    if (requestTimers.size) return;
    for (const delay of REQUEST_REPLAY_DELAYS_MS) later(requestTimers, send, delay);
  }

  function preferredOwnerCandidate() {
    return candidates.get(OWNER_INITIATED_PATH) ?? null;
  }

  function chooseOwnerPath() {
    if (closed || role !== 'owner' || selectedPath) return false;
    const owner = candidates.get(OWNER_INITIATED_PATH);
    const student = candidates.get(STUDENT_INITIATED_PATH);

    if (owner?.durableChannel && !owner.closed) return selectPath(OWNER_INITIATED_PATH, { notify: true });
    if (!student?.durableChannel || student.closed) return false;

    if (!started || owner?.failed || owner?.closed) {
      return selectPath(STUDENT_INITIATED_PATH, { notify: true });
    }

    if (!preferenceTimer) {
      preferenceTimer = setTimeout(() => {
        preferenceTimer = null;
        if (closed || selectedPath) return;
        const preferred = candidates.get(OWNER_INITIATED_PATH);
        if (preferred?.durableChannel && !preferred.closed) {
          selectPath(OWNER_INITIATED_PATH, { notify: true });
          return;
        }
        const fallback = candidates.get(STUDENT_INITIATED_PATH);
        if (fallback?.durableChannel && !fallback.closed) selectPath(STUDENT_INITIATED_PATH, { notify: true });
      }, positiveTimeout(ownerPreferenceGraceMs, DEFAULT_OWNER_PREFERENCE_GRACE_MS));
      preferenceTimer?.unref?.();
    }
    return true;
  }

  function handleDurableOpen(candidate, channel) {
    if (closed || candidate.closed) {
      try { channel?.close?.(); } catch { /* stale */ }
      return;
    }
    candidate.durableChannel = channel;
    candidate.failed = false;

    if (selectedPath) {
      if (selectedPath === candidate.path) attachSelectedIfReady();
      else closeCandidate(candidate);
      return;
    }

    if (pendingSelectedPath) {
      if (pendingSelectedPath === candidate.path) selectPath(candidate.path, { notify: false });
      return;
    }

    if (role === 'owner') {
      chooseOwnerPath();
      return;
    }

    if (!remoteDualPathSeen && candidate.path === STUDENT_INITIATED_PATH) {
      // Rolling compatibility: an older owner never sends path-select and never
      // tags answer/ICE with a path. In that case keep the historical student-
      // initiated connection behavior.
      selectPath(STUDENT_INITIATED_PATH, { notify: false });
      return;
    }

    requestSelection();
  }

  function handleLiveOpen(candidate, channel) {
    if (closed || candidate.closed || !enableLiveChannel) {
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

    closeCandidate(candidate);

    if (role === 'owner') {
      chooseOwnerPath();
    } else if (!selectedPath) {
      requestSelection();
    }
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

  function ensureCandidate(path) {
    const resolved = safePath(path);
    if (!resolved) throw new Error('Unsupported WebRTC path');
    const existing = candidates.get(resolved);
    if (existing) return existing;

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
      // A publish receipt may fail after the remote browser already received the
      // offer and opened SCTP. Never let a late signaling receipt destroy a
      // proven usable DataChannel.
      if (candidate.durableChannel) return;
      handleCandidateFailure(candidate, error);
    });
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
    if (explicit) {
      remoteDualPathSeen = true;
      return explicit;
    }

    const negotiationId = signalingNegotiationId(signal);
    const matched = candidateForNegotiationId(negotiationId);
    if (matched) return matched.path;

    if (signal?.type === 'offer') return remoteInitiatedPath;
    if (signal?.type === 'answer') return localInitiatedPath;
    if (signal?.type === 'ice') {
      const local = candidates.get(localInitiatedPath);
      const remote = candidates.get(remoteInitiatedPath);
      if (local && !local.closed && (!remote || remote.closed)) return localInitiatedPath;
      if (remote && !remote.closed && (!local || local.closed)) return remoteInitiatedPath;
      return localInitiatedPath;
    }
    return '';
  }

  function armDeadline() {
    clearDeadline();
    deadlineTimer = setTimeout(() => {
      deadlineTimer = null;
      if (closed || selectedAttached) return;

      if (role === 'owner') {
        const owner = candidates.get(OWNER_INITIATED_PATH);
        const student = candidates.get(STUDENT_INITIATED_PATH);
        if (owner?.durableChannel && !owner.closed) {
          selectPath(OWNER_INITIATED_PATH, { notify: true });
          return;
        }
        if (student?.durableChannel && !student.closed) {
          selectPath(STUDENT_INITIATED_PATH, { notify: true });
          return;
        }
      } else {
        // Deterministic last-resort if path-select itself was lost.
        const owner = candidates.get(OWNER_INITIATED_PATH);
        const student = candidates.get(STUDENT_INITIATED_PATH);
        if (owner?.durableChannel && !owner.closed) {
          selectPath(OWNER_INITIATED_PATH, { notify: false });
          return;
        }
        if (student?.durableChannel && !student.closed) {
          selectPath(STUDENT_INITIATED_PATH, { notify: false });
          return;
        }
      }

      failPair(new Error('WebRTC connection timed out: no path became usable'));
    }, positiveTimeout(connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS));
    deadlineTimer?.unref?.();
  }

  return {
    start() {
      if (closed) return Promise.reject(new Error('Dual-path peer pair is closed'));
      if (!started) {
        started = true;
        if (!selectedAttached) {
          const candidate = ensureCandidate(localInitiatedPath);
          startCandidate(candidate);
          armDeadline();
        }
      }
      return Promise.resolve();
    },

    async handleSignal(signal) {
      if (closed || !signal || typeof signal !== 'object') return false;
      const type = String(signal.type ?? '');

      if (type === 'path-select') {
        remoteDualPathSeen = true;
        if (role !== 'student') return false;
        const path = safePath(signal.path);
        if (!path) return false;
        clearTimerSet(requestTimers);
        selectPath(path, { notify: false });
        return true;
      }

      if (type === 'path-select-request') {
        remoteDualPathSeen = true;
        if (role !== 'owner') return false;
        if (selectedPath) replaySelection(selectedPath);
        else chooseOwnerPath();
        return true;
      }

      if (type === 'role-switch') {
        // Compatibility with the previous recovery protocol. The owner path is
        // already a first-class candidate now; just make sure it exists/replays.
        if (role === 'owner') {
          const candidate = ensureCandidate(OWNER_INITIATED_PATH);
          startCandidate(candidate);
          candidate.connection?.resendSignaling?.();
          return true;
        }
        return false;
      }

      if (type !== 'offer' && type !== 'answer' && type !== 'ice') return false;

      const negotiationId = signalingNegotiationId(signal);
      if (negotiationId && retiredNegotiations.has(negotiationId)) return false;
      const path = inferSignalPath(signal);
      if (!path) return false;

      let candidate = candidates.get(path) ?? null;
      if (type === 'offer' && candidate && negotiationId && candidate.negotiationId
        && negotiationId !== candidate.negotiationId) {
        // A retry of one direction is a new native negotiation for that direction
        // only. Replace the stale candidate without disturbing the other path.
        if (selectedPath === path || candidate.durableChannel) return false;
        closeCandidate(candidate);
        candidates.delete(path);
        candidate = null;
      }
      if (candidate?.closed && type === 'offer') {
        candidates.delete(path);
        candidate = null;
      }
      candidate ??= ensureCandidate(path);
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

    getSelectedPath() {
      return selectedPath;
    },

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
      clearPreferenceTimer();
      clearTimerSet(selectionTimers);
      clearTimerSet(requestTimers);
      for (const candidate of candidates.values()) closeCandidate(candidate);
      candidates.clear();
    },
  };
}
