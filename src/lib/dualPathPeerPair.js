import { randomToken } from './ids.js';
import { createBrowserPeerConnection } from './browserPeerConnection.js';
import { signalingNegotiationId } from './peerSignalingAssistance.js';
import { reportConnectionProgress } from './connectionProgress.js';

export const OWNER_INITIATED_PATH = 'owner-initiated';
export const STUDENT_INITIATED_PATH = 'student-initiated';

const VALID_PATHS = new Set([OWNER_INITIATED_PATH, STUDENT_INITIATED_PATH]);
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_DISCONNECT_GRACE_MS = 3_500;
// Probe directions sequentially so a dead ICE route cannot interfere with the viable route.
const DEFAULT_PRIMARY_PATH_TIMEOUT_MS = 5_000;
const STUDENT_FALLBACK_REQUEST_DELAY_MS = 6_000;
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
  recoveryTimeoutMs = 8_000,
  // Kept for rolling compatibility with callers from the parallel-race release.
  ownerPreferenceGraceMs: _ownerPreferenceGraceMs = null,
  createConnection = createBrowserPeerConnection,
  onSelectedChannel = () => {},
  onSelectedLiveChannel = () => {},
  onSelectedPath = () => {},
  onState = () => {},
  onFatal = () => {},
  onError = () => {},
  onProgress = () => {},
  checkHealth = () => false,
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

  let attemptId = role === 'owner' ? randomToken(12) : '';
  const retiredAttempts = new Set();
  let primaryStartedAt = 0;
  let remoteRecovery = false;
  let remoteLiveEnabled = null;
  const recoveryRequests = new Set();
  let switchedFromId = '';
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
    clearTimeout(candidate.recoveryTimer);
    clearTimeout(candidate.liveRepairTimer);
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

  function failPair(error, failedNegotiationId = '') {
    if (closed || fatal) return;
    fatal = true;
    clearDeadline();
    clearPrimaryTimer();
    clearControlTimers();
    if (role === 'student' && !selectedAttached) {
      const negotiationId = failedNegotiationId || candidates.get(activePath)?.negotiationId;
      // A watchdog request alone is not failure proof: its channel may open
      // while Ably is delivering it. Announce abandonment only AFTER closing
      // our native attempt, and identify exactly which generation was closed.
      for (const candidate of candidates.values()) closeCandidate(candidate);
      if (negotiationId) sendControl({ type: 'path-select-request', path: STUDENT_INITIATED_PATH,
        negotiationId, abandoned: true });
    }
    try { onState('failed', selectedPath || activePath); } catch { /* observer */ }
    try { onFatal(error instanceof Error ? error : new Error(String(error))); } catch { /* observer */ }
  }

  function tagControl(signal) {
    return { ...signal,
      ...(attemptId ? { attemptId } : {}), recoveryVersion: 1, liveVersion: enableLiveChannel ? 1 : 0,
      pathSequence: activePath === STUDENT_INITIATED_PATH ? 1 : 0,
    };
  }

  function sendControl(signal) {
    Promise.resolve(signaling.send(remoteId, tagControl(signal))).catch(reportError);
  }

  function replayControl(signal) {
    // A replay belongs to the generation that scheduled it, even if the pair
    // adopts a new owner attempt before its timer runs.
    const tagged = tagControl(signal);
    const send = () => Promise.resolve(signaling.send(remoteId, tagged)).catch(reportError);
    send();
    for (const delay of CONTROL_REPLAY_DELAYS_MS) later(send, delay);
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
      recoveryTimer: null,
      recoveryEpoch: 0,
      liveRepairTimer: null,
      progressStep: 3,
    };

    const connection = createConnection({
      onProgress: (event) => {
        if (!closed && !candidate.closed && candidate.path === activePath && !selectedAttached) {
          if (event.step < candidate.progressStep) return;
          const progressed = event.step > candidate.progressStep || event.detail !== candidate.progressDetail;
          candidate.progressStep = event.step;
          candidate.progressDetail = event.detail;
          if (progressed && role === 'owner' && !fallbackStarted) armPrimaryTimer();
          reportConnectionProgress(onProgress, event.step, event.detail, { path: resolved });
        }
      },
      initiator,
      enableLiveChannel: Boolean(enableLiveChannel),
      assistSignaling: true,
      rtcConfig,
      sendSignal: (signal) => {
        const negotiationId = signalingNegotiationId(signal);
        if (negotiationId) candidate.negotiationId = negotiationId;
        return signaling.send(remoteId, { ...signal, path: resolved, recoveryVersion: 1, liveVersion: enableLiveChannel ? 1 : 0, ...(attemptId ? { attemptId } : {}),
          pathSequence: resolved === STUDENT_INITIATED_PATH ? 1 : 0 });
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
    reportConnectionProgress(onProgress, 3, 'negotiating', { path: candidate.path, retrying: false, restart: true });
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
    switchedFromId = candidates.get(OWNER_INITIATED_PATH)?.negotiationId || switchedFromId;
    clearPrimaryTimer();
    clearControlTimers();
    removeCandidate(OWNER_INITIATED_PATH);
    activePath = STUDENT_INITIATED_PATH;
    pendingSelectedPath = '';

    const candidate = createCandidate(STUDENT_INITIATED_PATH);
    startCandidate(candidate);
    armDeadline();

    if (notify) {
      replayControl({ type: 'path-switch', path: STUDENT_INITIATED_PATH, ...(switchedFromId ? { negotiationId: switchedFromId } : {}) });
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
    if (candidate.liveChannel !== channel) selectedLiveAttached = false;
    candidate.liveChannel = channel;
    clearTimeout(candidate.liveRepairTimer); candidate.liveRepairTimer = null;
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
      if (role === 'owner') {
        switchToStudentPath({ notify: true });
      } else {
        // Owner coordinates direction changes. Student never unilaterally flips
        // roles, which avoids timer skew killing a primary path that is opening
        // successfully on the owner side.
        replayControl({ type: 'path-select-request', path: STUDENT_INITIATED_PATH, abandoned: true,
          ...(candidate.negotiationId ? { negotiationId: candidate.negotiationId } : {}),
        });
      }
      return;
    }

    removeCandidate(candidate.path);
    failPair(error ?? new Error('Fallback WebRTC path failed'), candidate.negotiationId);
  }

  function recoverCandidate(candidate, mode = 'ice') {
    if (closed || fatal || !candidate || candidate.closed || !selectedAttached) return false;
    if (mode === 'live' && (!enableLiveChannel || remoteLiveEnabled !== true || !remoteRecovery)) return false;
    const timerKey = mode === 'live' ? 'liveRepairTimer' : 'recoveryTimer';
    if (candidate[timerKey]) return true;
    if (mode === 'live' && candidate.liveChannel?.readyState === 'open') return true;
    if (!remoteRecovery) { failPair(new Error('Peer requires full reconnection')); return false; }
    const epoch = mode === 'ice' ? ++candidate.recoveryEpoch : null;
    candidate[timerKey] = setTimeout(async () => {
      // A suspended tab may resume after this timer expired while its data
      // channel already works again. Confirm actual health before teardown.
      let healthy = false;
      if (mode === 'ice') {
        try { healthy = await checkHealth(); } catch { /* failed probe */ }
        if (candidate.recoveryEpoch !== epoch) return;
      }
      if (closed || candidate.closed) return;
      if (healthy === true) confirmCandidateHealthy(candidate);
      else {
        candidate[timerKey] = null;
        failPair(new Error(mode === 'live' ? 'Live channel recovery timed out' : 'ICE recovery timed out'));
      }
    }, positiveTimeout(recoveryTimeoutMs, 8_000));
    candidate[timerKey]?.unref?.();
    if (mode === 'ice') { try { onState('recovering', candidate.path); } catch { /* observer */ } }
    if (candidate.initiator) {
      Promise.resolve().then(() => mode === 'live'
        ? candidate.connection.recoverLiveChannel?.()
        : candidate.connection.restartIce?.()).catch(error => failPair(error));
    } else {
      replayControl({ type: 'connection-recover', mode, path: candidate.path,
        negotiationId: candidate.negotiationId, requestId: randomToken(12) });
    }
    return true;
  }

  function confirmCandidateHealthy(candidate) {
    if (closed || fatal || !candidate || candidate.closed) return false;
    const wasRecovering = Boolean(candidate.recoveryTimer);
    candidate.recoveryEpoch += 1;
    clearTimeout(candidate.recoveryTimer); candidate.recoveryTimer = null;
    clearTimeout(candidate.disconnectTimer); candidate.disconnectTimer = null;
    if (wasRecovering) { try { onState('connected', candidate.path); } catch { /* observer */ } }
    return true;
  }

  function handleConnectionState(candidate, state) {
    if (closed || candidate.closed) return;
    const normalized = String(state ?? 'unknown');
    if (selectedPath === candidate.path && normalized === 'failed') { recoverCandidate(candidate); return; }
    if (normalized === 'connected') {
      confirmCandidateHealthy(candidate);
    }

    if (selectedPath === candidate.path) {
      try { onState(normalized, candidate.path); } catch { /* observer */ }
    }

    if (normalized === 'disconnected') {
      if (!candidate.disconnectTimer) {
        candidate.disconnectTimer = setTimeout(() => {
          candidate.disconnectTimer = null;
          if (!closed && !candidate.closed) {
            if (selectedPath === candidate.path) recoverCandidate(candidate);
            else handleCandidateFailure(candidate, new Error('WebRTC path remained disconnected'));
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
    const primaryBudget = positiveTimeout(connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS) * 0.8;
    const remaining = Math.max(1, primaryBudget - (Date.now() - primaryStartedAt));
    const delay = role === 'owner'
      ? Math.min(positiveTimeout(primaryPathTimeoutMs, DEFAULT_PRIMARY_PATH_TIMEOUT_MS), remaining)
      : Math.max(
        positiveTimeout(primaryPathTimeoutMs, DEFAULT_PRIMARY_PATH_TIMEOUT_MS) + 1_000,
        STUDENT_FALLBACK_REQUEST_DELAY_MS,
      );
    primaryTimer = setTimeout(() => {
      primaryTimer = null;
      if (closed || selectedAttached || fallbackStarted) return;
      if (role === 'owner') {
        switchToStudentPath({ notify: true });
      } else {
        // Coordination watchdog only: ask owner to switch/replay; never change
        // the student's native role without an owner decision.
        const negotiationId = candidates.get(OWNER_INITIATED_PATH)?.negotiationId;
        replayControl({ type: 'path-select-request', path: STUDENT_INITIATED_PATH,
          ...(negotiationId ? { negotiationId } : {}),
        });
      }
    }, delay);
    primaryTimer?.unref?.();
  }

  function armDeadline() {
    clearDeadline();
    deadlineTimer = setTimeout(() => {
      deadlineTimer = null;
      if (closed || selectedAttached) return;
      failPair(new Error('WebRTC connection timed out: no path became usable'));
    }, positiveTimeout(connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS));
    deadlineTimer?.unref?.();
  }

  return {
    start() {
      if (closed) return Promise.reject(new Error('Dual-path peer pair is closed'));
      if (started) return Promise.resolve();
      started = true;
      primaryStartedAt = Date.now();
      // Buffered signaling can already have switched or opened the fallback
      // before the session calls start(). Preserve that negotiated direction:
      // resetting it here creates a competing primary and rejects fallback opens.
      if (selectedAttached || fatal) return Promise.resolve();
      activatePath(activePath);
      if (!fallbackStarted) armPrimaryTimer();
      if (!deadlineTimer) armDeadline();
      return Promise.resolve();
    },

    async handleSignal(signal) {
      if (closed || !signal || typeof signal !== 'object') return false;
      const type = String(signal.type ?? '');
      const incomingAttempt = typeof signal.attemptId === 'string' && signal.attemptId.length <= 128 ? signal.attemptId : '';
      if (signal.attemptId != null && !incomingAttempt) return false;
      if (incomingAttempt && retiredAttempts.has(incomingAttempt)) return false;
      if (incomingAttempt && attemptId && incomingAttempt !== attemptId) {
        if (role !== 'student' || type !== 'offer' || signal.path !== OWNER_INITIATED_PATH || selectedAttached) return false;
        if (retiredAttempts.size >= 64) retiredAttempts.delete(retiredAttempts.values().next().value);
        retiredAttempts.add(attemptId);
        clearControlTimers(); clearPrimaryTimer(); clearDeadline();
        removeCandidate(activePath); activePath = OWNER_INITIATED_PATH; fallbackStarted = false;
        switchedFromId = ''; pendingSelectedPath = ''; remoteRecovery = false; remoteLiveEnabled = null;
        recoveryRequests.clear(); primaryStartedAt = Date.now();
        attemptId = incomingAttempt;
        if (started) { armPrimaryTimer(); armDeadline(); }
      }
      if (incomingAttempt && !attemptId) attemptId = incomingAttempt;
      if (type.startsWith('path-')) {
        const id = signalingNegotiationId(signal);
        const current = candidates.get(activePath)?.negotiationId;
        if (id && current && id !== current && id !== switchedFromId) return false;
        if (incomingAttempt && type === 'path-switch' && signal.pathSequence !== 1) return false;
        if (incomingAttempt && type === 'path-select'
          && signal.pathSequence !== (signal.path === STUDENT_INITIATED_PATH ? 1 : 0)) return false;
        if (incomingAttempt && type === 'path-select-request' && current
          && signal.pathSequence !== (activePath === STUDENT_INITIATED_PATH && id !== switchedFromId ? 1 : 0)) return false;
        if (type === 'path-select' && id && candidates.get(safePath(signal.path))?.negotiationId
          && candidates.get(safePath(signal.path)).negotiationId !== id) return false;
        if ((type === 'path-switch' || (incomingAttempt && type === 'path-select-request')) && current && !id) return false;
      }

      if (signal.recoveryVersion === 1) remoteRecovery = true;
      if (signal.liveVersion === 0 || signal.liveVersion === 1) remoteLiveEnabled = signal.liveVersion === 1;
      if (type === 'connection-recover') {
        const candidate = candidates.get(selectedPath);
        if (!selectedAttached || !candidate?.initiator || signal.path !== selectedPath
          || signal.negotiationId !== candidate.negotiationId
          || !['ice', 'live'].includes(signal.mode)
          || typeof signal.requestId !== 'string' || !signal.requestId || signal.requestId.length > 128) return false;
        if (recoveryRequests.has(signal.requestId)) return true;
        if (recoveryRequests.size >= 64) recoveryRequests.delete(recoveryRequests.values().next().value);
        recoveryRequests.add(signal.requestId);
        return recoverCandidate(candidate, signal.mode);
      }

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
        // A fresh student may have missed the original offer. Remember the
        // owner's advertised generation so a failed attempt can retire it.
        const candidate = candidates.get(path);
        const negotiationId = signalingNegotiationId(signal);
        if (candidate && !candidate.negotiationId && negotiationId) candidate.negotiationId = negotiationId;
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
        if (signal.path === STUDENT_INITIATED_PATH) {
          if (activePath === OWNER_INITIATED_PATH) {
            switchToStudentPath({ notify: true });
          } else if (activePath === STUDENT_INITIATED_PATH && !selectedAttached) {
            replayControl({ type: 'path-switch', path: STUDENT_INITIATED_PATH, ...(switchedFromId ? { negotiationId: switchedFromId } : {}) });
          }
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

    canProbe() { return remoteRecovery && selectedAttached && !closed; },
    getAttemptId() { return attemptId; },
    isLiveExpected() { return Boolean(enableLiveChannel) && remoteLiveEnabled !== false; },
    confirmHealthy() { return confirmCandidateHealthy(candidates.get(selectedPath)); },
    recover() { return recoverCandidate(candidates.get(selectedPath)); },
    repairLiveChannel() { return recoverCandidate(candidates.get(selectedPath), 'live'); },
    async getDiagnostics() {
      const candidate = candidates.get(selectedPath || activePath);
      return { attemptId, path: selectedPath || activePath, selected: selectedAttached,
        recovering: Boolean(candidate?.recoveryTimer), repairingLive: Boolean(candidate?.liveRepairTimer),
        ...(await candidate?.connection?.getDiagnostics?.() ?? {}) };
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
