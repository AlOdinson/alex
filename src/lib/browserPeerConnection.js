import { randomToken } from './ids.js';
import { reportConnectionProgress } from './connectionProgress.js';
import { createPeerSignalingAssistance, signalingNegotiationId } from './peerSignalingAssistance.js';

export const BOARD_DURABLE_DATA_CHANNEL = 'alex-board-durable-v1';
export const BOARD_LIVE_DATA_CHANNEL = 'alex-board-live-v1';

export const DEFAULT_BROWSER_RTC_CONFIG = Object.freeze({
  iceCandidatePoolSize: 2,
  iceServers: Object.freeze([
    Object.freeze({ urls: Object.freeze(['stun:stun.cloudflare.com:3478']) }),
  ]),
});

function resolveRtcConfig(rtcConfig) {
  const source = rtcConfig && typeof rtcConfig === 'object' ? rtcConfig : {};
  const resolved = {
    iceCandidatePoolSize: DEFAULT_BROWSER_RTC_CONFIG.iceCandidatePoolSize,
    ...source,
  };
  if (Object.prototype.hasOwnProperty.call(source, 'iceServers')) return resolved;
  return {
    ...resolved,
    iceServers: DEFAULT_BROWSER_RTC_CONFIG.iceServers.map((server) => ({
      ...server,
      urls: Array.isArray(server.urls) ? [...server.urls] : server.urls,
    })),
  };
}

export function createBrowserPeerConnection({
  initiator = false,
  enableLiveChannel = false,
  rtcConfig = {},
  sendSignal,
  onChannel = () => {},
  onLiveChannel = () => {},
  onConnectionState = () => {},
  onError = () => {},
  onProgress = () => {},
  createPeerConnection,
  assistSignaling = false,
} = {}) {
  if (typeof sendSignal !== 'function') throw new Error('sendSignal is required');
  const factory = createPeerConnection ?? ((config) => new RTCPeerConnection(config));
  const peerConnection = factory(resolveRtcConfig(rtcConfig));
  if (!peerConnection) throw new Error('Could not create RTCPeerConnection');

  let dataChannel = null;
  let liveDataChannel = null;
  let started = false;
  let closed = false;
  const pendingIce = [];
  const addedIce = new Set();
  let negotiationId = initiator && assistSignaling ? randomToken(12) : '';
  let signalQueue = Promise.resolve();
  let iceRevision = 0;
  let restartPending = false;
  let lastReply = null;
  const futureIce = new Map();
  let lastRemoteOffer = null;
  let lastRemoteAnswer = null;
  const tagSignal = (signal) => ({ ...signal, ...(negotiationId ? { negotiationId } : {}), ...(iceRevision ? { iceRevision } : {}) });
  const candidateKey = (candidate) => JSON.stringify([
    candidate.candidate, candidate.sdpMid, candidate.sdpMLineIndex, candidate.usernameFragment,
  ]);

  const reportError = (error) => {
    try {
      onError(error);
    } catch {
      // Error observers must not break the peer connection lifecycle.
    }
  };

  const publishSignal = (signal) => Promise.resolve().then(() => {
    if (!closed) return sendSignal(signal);
  }).catch((error) => {
    reportError(error);
    throw error;
  });

  const makeAssistance = () => createPeerSignalingAssistance({
    enabled: assistSignaling, initiator, send: publishSignal,
    isOpen: () => iceRevision ? !restartPending : dataChannel?.readyState === 'open', isClosed: () => closed,
  });
  let assistance = makeAssistance();

  const attachDurableChannel = (channel) => {
    if (!channel || channel.label !== BOARD_DURABLE_DATA_CHANNEL || closed) return false;
    dataChannel = channel;
    const opened = () => {
      if (closed || dataChannel !== channel) return;
      assistance.stop();
      onChannel(channel);
    };
    if (channel.readyState === 'open') opened();
    else channel.onopen = opened;
    return true;
  };

  const attachLiveChannel = (channel) => {
    if (!channel || channel.label !== BOARD_LIVE_DATA_CHANNEL || closed) return false;
    if (liveDataChannel && liveDataChannel !== channel && liveDataChannel.readyState === 'open') {
      try { channel.close?.(); } catch { /* duplicate */ }
      return true;
    }
    liveDataChannel = channel;
    const opened = () => {
      if (closed || liveDataChannel !== channel) return;
      onLiveChannel(channel);
    };
    if (channel.readyState === 'open') opened();
    else channel.onopen = opened;
    return true;
  };

  const attachChannel = (channel) => {
    if (attachDurableChannel(channel) || attachLiveChannel(channel)) return true;
    try { channel?.close?.(); } catch (error) { reportError(error); }
    return false;
  };

  const queueIce = (candidate) => {
    if (pendingIce.some((item) => candidateKey(item) === candidateKey(candidate))) return;
    // Ably can deliver a previous attempt's ICE after a fresh peer was created.
    // Keep a bounded queue, also preserving candidates for a future SDP/restart.
    if (pendingIce.length >= 256) pendingIce.shift();
    pendingIce.push(candidate);
  };

  const addRemoteIce = async (candidate) => {
    if (closed) return;
    const key = candidateKey(candidate);
    if (addedIce.has(key)) return;
    const description = peerConnection.remoteDescription;
    const fragment = String(candidate?.usernameFragment
      ?? String(candidate?.candidate ?? '').match(/\bufrag\s+(\S+)/)?.[1] ?? '').trim();
    const fragments = [...String(description?.sdp ?? '').matchAll(/^a=ice-ufrag:([^\r\n]+)/gm)]
      .map((match) => match[1].trim());
    if (!description || (fragment && fragments.length && !fragments.includes(fragment))) {
      queueIce(candidate);
      return;
    }
    // Do not suppress other ICE errors: malformed current-generation candidates
    // must still be reported. Legacy candidates without ufrag remain supported.
    await peerConnection.addIceCandidate(candidate);
    if (addedIce.size >= 256) addedIce.delete(addedIce.values().next().value);
    addedIce.add(key);
  };

  const flushPendingIce = async () => {
    if (!peerConnection.remoteDescription) return;
    const queued = pendingIce.splice(0);
    for (const candidate of queued) {
      // eslint-disable-next-line no-await-in-loop
      await addRemoteIce(candidate);
    }
  };

  peerConnection.onicecandidate = (event) => {
    if (closed || !event?.candidate) return;
    const signal = tagSignal({ type: 'ice', candidate: event.candidate });
    reportConnectionProgress(onProgress, 3, 'candidate');
    assistance.rememberCandidate(signal);
    publishSignal(signal).catch(() => undefined);
  };

  peerConnection.ondatachannel = (event) => {
    attachChannel(event?.channel);
  };

  peerConnection.oniceconnectionstatechange = () => {
    if (peerConnection.iceConnectionState === 'checking') reportConnectionProgress(onProgress, 3, 'route');
  };

  peerConnection.onconnectionstatechange = () => {
    if (peerConnection.connectionState === 'connected') reportConnectionProgress(onProgress, 4, 'channel');
    onConnectionState(peerConnection.connectionState ?? 'unknown');
  };

  const processSignal = async (signal) => {
    if (closed || !signal || typeof signal !== 'object') return null;
    const incomingId = signalingNegotiationId(signal);
    if (signal.negotiationId != null && !incomingId) return null;
    // An earlier attempt's delayed answer/candidates must never poison this one.
    // Untagged legacy peers remain compatible during a rolling update.
    if (incomingId && negotiationId && incomingId !== negotiationId) return null;
    const revision = Number(signal.iceRevision ?? 0);
    if (!Number.isSafeInteger(revision) || revision < iceRevision || revision < 0) return null;
    if (revision > iceRevision) {
      if (signal.type === 'ice') {
        if (revision <= iceRevision + 1 && signal.candidate) {
          const queued = futureIce.get(revision) ?? [];
          if (queued.length < 256) queued.push(signal.candidate);
          futureIce.set(revision, queued);
        }
        return null;
      }
      if (signal.type !== 'offer' || initiator || revision !== iceRevision + 1) return null;
      iceRevision = revision; restartPending = true; addedIce.clear();
      assistance.stop(); assistance = makeAssistance();
      pendingIce.push(...(futureIce.get(revision) ?? [])); futureIce.clear();
    }
    if (signal.type === 'ice') {
      if (signal.candidate) await addRemoteIce(signal.candidate);
      return null;
    }
    if (signal.type === 'offer') {
      if (!signal.description) throw new Error('WebRTC offer has no description');
      if (initiator) return null; // Only the student offers in the board protocol.
      const fingerprint = JSON.stringify(signal.description);
      if (lastRemoteOffer === fingerprint) {
        if (iceRevision && lastReply) return lastReply;
        assistance.replay(); return null;
      }
      if (incomingId) negotiationId = incomingId;
      await peerConnection.setRemoteDescription(signal.description);
      if (closed) return null;
      await flushPendingIce();
      const answer = await peerConnection.createAnswer();
      if (closed) return null;
      await peerConnection.setLocalDescription(answer);
      if (closed) return null;
      lastRemoteOffer = fingerprint;
      const reply = tagSignal({ type: 'answer', description: peerConnection.localDescription ?? answer });
      lastReply = reply;
      assistance.rememberDescription(reply);
      reportConnectionProgress(onProgress, 3, 'answer');
      return reply;
    }
    if (signal.type === 'answer') {
      if (!signal.description) throw new Error('WebRTC answer has no description');
      if (!initiator) return null;
      // Native remoteDescription may grow when trickle ICE is added. Compare
      // the originally received answer, not that evolving browser SDP.
      const fingerprint = JSON.stringify(signal.description);
      if (lastRemoteAnswer === fingerprint) return null;
      await peerConnection.setRemoteDescription(signal.description);
      if (!closed) { lastRemoteAnswer = fingerprint; restartPending = false; if (iceRevision) assistance.stop(); await flushPendingIce(); }
      if (!closed) reportConnectionProgress(onProgress, 3, 'route');
    }
    return null;
  };

  return {
    async start() {
      if (closed) throw new Error('Peer connection is closed');
      if (started) return;
      started = true;
      if (!initiator) return;

      attachDurableChannel(peerConnection.createDataChannel(BOARD_DURABLE_DATA_CHANNEL, {
        ordered: true,
      }));
      if (enableLiveChannel) {
        attachLiveChannel(peerConnection.createDataChannel(BOARD_LIVE_DATA_CHANNEL, {
          ordered: false,
          maxRetransmits: 0,
        }));
      }
      const offer = await peerConnection.createOffer();
      if (closed) return;
      await peerConnection.setLocalDescription(offer);
      if (closed) return;
      const signal = tagSignal({ type: 'offer', description: peerConnection.localDescription ?? offer });
      assistance.rememberDescription(signal);
      await publishSignal(signal);
      if (!closed && !lastRemoteAnswer && dataChannel?.readyState !== 'open') reportConnectionProgress(onProgress, 3, 'offer');
    },

    handleSignal(signal) {
      // Serialize native SDP/ICE state transitions, NOT Ably publish receipts.
      // Otherwise an unanswered receipt could block the very replay that repairs it.
      const task = signalQueue.then(() => processSignal(signal));
      signalQueue = task.then(() => undefined, () => undefined);
      return task.then((outgoing) => outgoing ? publishSignal(outgoing) : undefined);
    },

    restartIce() {
      if (closed || !initiator || restartPending || !peerConnection.remoteDescription) return Promise.resolve(false);
      restartPending = true;
      const task = signalQueue.then(async () => {
        if (closed) return null;
        iceRevision += 1; addedIce.clear(); lastRemoteAnswer = null;
        assistance.stop(); assistance = makeAssistance();
        peerConnection.restartIce?.();
        const offer = await peerConnection.createOffer({ iceRestart: true });
        if (closed) return null;
        await peerConnection.setLocalDescription(offer);
        if (closed) return null;
        const signal = tagSignal({ type: 'offer', description: peerConnection.localDescription ?? offer });
        assistance.rememberDescription(signal);
        return signal;
      });
      signalQueue = task.then(() => undefined, () => undefined);
      return task.then(async signal => { if (!signal) return false; await publishSignal(signal); return true; })
        .catch(error => { restartPending = false; throw error; });
    },

    recoverLiveChannel() {
      if (closed || !initiator || !enableLiveChannel || dataChannel?.readyState !== 'open') return false;
      if (liveDataChannel && ['open', 'connecting'].includes(liveDataChannel.readyState)) return false;
      return attachLiveChannel(peerConnection.createDataChannel(BOARD_LIVE_DATA_CHANNEL, { ordered: false, maxRetransmits: 0 }));
    },

    async getDiagnostics() {
      const result = { connectionState: peerConnection.connectionState ?? 'unknown',
        iceState: peerConnection.iceConnectionState ?? 'unknown', iceRevision,
        durableState: dataChannel?.readyState ?? 'missing', liveState: liveDataChannel?.readyState ?? 'missing' };
      try {
        const stats = await peerConnection.getStats?.();
        if (stats) for (const stat of stats.values()) {
          if (stat.type !== 'candidate-pair' || stat.state !== 'succeeded' || !stat.nominated) continue;
          const local = stats.get(stat.localCandidateId); const remote = stats.get(stat.remoteCandidateId);
          result.route = { localType: local?.candidateType, remoteType: remote?.candidateType,
            protocol: local?.protocol, rttMs: Number.isFinite(stat.currentRoundTripTime) ? Math.round(stat.currentRoundTripTime * 1000) : null };
          break;
        }
      } catch { /* browser may be closing */ }
      return result;
    },

    resendSignaling() { return assistance.replay(); },

    getDataChannel() {
      return dataChannel;
    },

    getLiveDataChannel() {
      return liveDataChannel;
    },

    getPeerConnection() {
      return peerConnection;
    },

    close() {
      if (closed) return;
      closed = true;
      assistance.stop();
      pendingIce.length = 0;
      addedIce.clear();
      futureIce.clear();
      try {
        dataChannel?.close?.();
      } catch (error) {
        reportError(error);
      }
      dataChannel = null;
      try {
        liveDataChannel?.close?.();
      } catch (error) {
        reportError(error);
      }
      liveDataChannel = null;
      try {
        peerConnection.close?.();
      } catch (error) {
        reportError(error);
      }
    },
  };
}
