import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { randomToken } from '../lib/ids.js';
import {
  MAX_SCREEN_SHARE_VIEWERS,
  normalizeRemoteBrowserState,
  normalizeScreenShareSignal,
  preferredScreenShareSession,
  REMOTE_BROWSER_AGENT_TTL_MS,
  REMOTE_BROWSER_DATA_CHANNEL,
  remoteBrowserPointerCoordinates,
  rtcConfiguration,
  SCREEN_SHARE_PROFILES,
  SCREEN_SHARE_PROTOCOL,
  screenShareCapability,
  screenShareNetworkIsDegraded,
  screenShareProfileForActivity,
} from '../lib/screenShare.js';

const HOST_SIGNAL_TYPES = new Set(['host-start', 'host-stop', 'host-paused', 'offer']);

function closePeer(entry) {
  const peer = entry?.peer ?? entry;
  if (!peer) return;
  const dataChannel = entry?.dataChannel;
  if (dataChannel) {
    dataChannel.onmessage = null;
    dataChannel.onopen = null;
    dataChannel.onclose = null;
    try { dataChannel.close(); } catch { /* Already closed. */ }
  }
  peer.ontrack = null;
  peer.ondatachannel = null;
  peer.onicecandidate = null;
  peer.onconnectionstatechange = null;
  try {
    peer.close();
  } catch {
    // A peer may already be closed after a mobile network handoff.
  }
}

function stopStream(stream) {
  stream?.getTracks?.().forEach((track) => {
    track.onended = null;
    track.onmute = null;
    track.onunmute = null;
    try {
      track.stop();
    } catch {
      // A browser-ended capture track does not need another successful stop.
    }
  });
}

function serializableDescription(description) {
  if (!description) return null;
  return { type: description.type, sdp: description.sdp };
}

function serializableCandidate(candidate) {
  if (!candidate) return null;
  if (typeof candidate.toJSON === 'function') return candidate.toJSON();
  return {
    candidate: candidate.candidate,
    sdpMid: candidate.sdpMid,
    sdpMLineIndex: candidate.sdpMLineIndex,
    usernameFragment: candidate.usernameFragment,
  };
}

function remoteBrowserRelayUrl(session, viewerId) {
  const rawUrl = String(session?.relayUrl ?? '');
  const token = String(session?.relayToken ?? '');
  if (!rawUrl || token.length < 20 || String(session?.sourceMode) !== 'remote-browser') return '';
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'wss:') return '';
    url.searchParams.set('session', String(session.sessionId ?? ''));
    url.searchParams.set('token', token);
    url.searchParams.set('viewer', String(viewerId ?? ''));
    return url.toString();
  } catch {
    return '';
  }
}

async function applySenderProfile(sender, profile, degraded) {
  if (!sender?.getParameters || !sender?.setParameters) return;
  const parameters = sender.getParameters();
  if (!Array.isArray(parameters.encodings) || !parameters.encodings.length) return;
  parameters.encodings = parameters.encodings.map((encoding) => ({
    ...encoding,
    maxBitrate: Math.max(160_000, Math.round(profile.maxBitrate * (degraded ? 0.68 : 1))),
    maxFramerate: degraded ? Math.min(8, profile.maxFrameRate) : profile.maxFrameRate,
    scaleResolutionDownBy: degraded ? 1.5 : 1,
  }));
  try {
    await sender.setParameters(parameters);
  } catch {
    // Safari versions differ in which encoding fields can be changed at runtime.
  }
}

async function peerNetworkSample(peer) {
  if (!peer?.getStats) return { fractionLost: 0, roundTripTime: 0 };
  const report = await peer.getStats();
  let fractionLost = 0;
  let roundTripTime = 0;
  report.forEach((entry) => {
    if (entry?.type !== 'remote-inbound-rtp' || entry?.kind === 'audio') return;
    fractionLost = Math.max(fractionLost, Number(entry.fractionLost ?? 0));
    roundTripTime = Math.max(roundTripTime, Number(entry.roundTripTime ?? 0));
  });
  return { fractionLost, roundTripTime };
}

export function useAdaptiveScreenShare({
  realtimeRef,
  users,
  isOwner,
  canEdit,
  clientId,
  participantName,
}) {
  const capability = useMemo(() => screenShareCapability(), []);
  const [stream, setStream] = useState(null);
  const [relayFrameUrl, setRelayFrameUrl] = useState('');
  const [minimized, setMinimized] = useState(false);
  const [view, setView] = useState({
    phase: 'idle',
    role: null,
    hostName: '',
    message: '',
    profileId: 'idle',
    viewerCount: 0,
    networkDegraded: false,
    sourceMode: null,
    remoteBrowserState: null,
  });
  const [remoteAgent, setRemoteAgent] = useState(null);

  const mountedRef = useRef(true);
  const activeSessionRef = useRef(null);
  const localStreamRef = useRef(null);
  const viewerPeerRef = useRef(null);
  const viewerRelayRef = useRef(null);
  const relayFrameUrlRef = useRef('');
  const pendingViewerIceRef = useRef([]);
  const hostPeersRef = useRef(new Map());
  const currentProfileRef = useRef(SCREEN_SHARE_PROFILES.idle);
  const networkDegradedRef = useRef(false);
  const startBusyRef = useRef(false);
  const stopHostingRef = useRef(() => undefined);
  const processSignalRef = useRef(() => undefined);
  const remoteControlChannelRef = useRef(null);

  const updateView = useCallback((patch) => {
    if (!mountedRef.current) return;
    setView((current) => ({ ...current, ...patch }));
  }, []);

  const sendSignal = useCallback((type, details = {}, explicitSession = null) => {
    const session = explicitSession ?? activeSessionRef.current;
    const sessionId = String(details.sessionId ?? session?.sessionId ?? '');
    if (!sessionId) return Promise.resolve('ignored');
    try {
      return Promise.resolve(realtimeRef.current?.sendScreenShareSignal?.({
        protocol: SCREEN_SHARE_PROTOCOL,
        type,
        sessionId,
        ...details,
      })).catch(() => 'unavailable');
    } catch {
      return Promise.resolve('unavailable');
    }
  }, [realtimeRef]);

  const applyCurrentProfile = useCallback(async () => {
    const profile = currentProfileRef.current;
    const degraded = networkDegradedRef.current;
    const track = localStreamRef.current?.getVideoTracks?.()[0];
    if (track?.applyConstraints) {
      try {
        await track.applyConstraints({
          frameRate: {
            ideal: degraded ? Math.min(8, profile.maxFrameRate) : profile.maxFrameRate,
            max: degraded ? Math.min(8, profile.maxFrameRate) : profile.maxFrameRate,
          },
        });
      } catch {
        // Some iOS capture sources expose a fixed frame rate. Sender limits still apply.
      }
    }
    await Promise.allSettled([...hostPeersRef.current.values()].map((entry) => (
      applySenderProfile(entry.sender, profile, degraded)
    )));
  }, []);

  const applyRemoteBrowserPayload = useCallback((rawData) => {
    let payload = null;
    try {
      payload = JSON.parse(String(rawData ?? ''));
    } catch {
      return;
    }
    if (payload?.type !== 'remote-state') return;
    const nextState = normalizeRemoteBrowserState(payload.state);
    if (!nextState) return;
    updateView({ remoteBrowserState: nextState });
  }, [updateView]);

  const releaseRelayFrame = useCallback(() => {
    const previous = relayFrameUrlRef.current;
    relayFrameUrlRef.current = '';
    setRelayFrameUrl('');
    if (previous) window.setTimeout(() => URL.revokeObjectURL(previous), 250);
  }, []);

  const clearViewerRelay = useCallback(() => {
    const entry = viewerRelayRef.current;
    viewerRelayRef.current = null;
    if (entry?.socket) {
      entry.closedByClient = true;
      entry.socket.onopen = null;
      entry.socket.onmessage = null;
      entry.socket.onerror = null;
      entry.socket.onclose = null;
      try { entry.socket.close(1000, 'viewer-left'); } catch { /* Already closed. */ }
    }
    releaseRelayFrame();
  }, [releaseRelayFrame]);

  const connectViewerRelay = useCallback((session) => {
    const url = remoteBrowserRelayUrl(session, clientId);
    if (!url) return false;
    const current = viewerRelayRef.current;
    if (current?.sessionId === session.sessionId
      && [WebSocket.OPEN, WebSocket.CONNECTING].includes(current.socket?.readyState)) return true;
    if (current) clearViewerRelay();

    const socket = new WebSocket(url);
    socket.binaryType = 'blob';
    const entry = { socket, sessionId: session.sessionId, hasFrame: false, closedByClient: false };
    viewerRelayRef.current = entry;
    socket.onopen = () => {
      if (viewerRelayRef.current !== entry) return;
      updateView({ message: 'Проверяю прямой и резервный каналы…' });
    };
    socket.onmessage = (event) => {
      if (viewerRelayRef.current !== entry) return;
      if (typeof event.data === 'string') {
        applyRemoteBrowserPayload(event.data);
        return;
      }
      const peerConnected = viewerPeerRef.current?.peer?.connectionState === 'connected';
      if (peerConnected) return;
      const blob = event.data instanceof Blob
        ? event.data
        : new Blob([event.data], { type: 'image/jpeg' });
      const nextUrl = URL.createObjectURL(blob);
      const previous = relayFrameUrlRef.current;
      relayFrameUrlRef.current = nextUrl;
      entry.hasFrame = true;
      setStream(null);
      setRelayFrameUrl(nextUrl);
      updateView({ phase: 'viewing', message: '', networkDegraded: false });
      if (previous) window.setTimeout(() => URL.revokeObjectURL(previous), 250);
    };
    socket.onerror = () => undefined;
    socket.onclose = () => {
      if (viewerRelayRef.current !== entry) return;
      viewerRelayRef.current = null;
      if (entry.closedByClient || viewerPeerRef.current?.peer?.connectionState === 'connected') return;
      updateView({
        phase: entry.hasFrame ? 'viewing' : 'connecting',
        message: entry.hasFrame
          ? 'Резервный канал переподключается…'
          : 'Устанавливается соединение с Mac…',
      });
    };
    return true;
  }, [applyRemoteBrowserPayload, clearViewerRelay, clientId, updateView]);

  const clearViewerPeer = useCallback((announce = false, keepRelay = false) => {
    const session = activeSessionRef.current;
    if (announce && session && session.hostId !== clientId) {
      sendSignal('viewer-leave', { targetId: session.hostId }, session);
    }
    closePeer(viewerPeerRef.current);
    viewerPeerRef.current = null;
    remoteControlChannelRef.current = null;
    pendingViewerIceRef.current = [];
    if (!keepRelay) clearViewerRelay();
  }, [clearViewerRelay, clientId, sendSignal]);

  const clearHostPeers = useCallback(() => {
    hostPeersRef.current.forEach(closePeer);
    hostPeersRef.current.clear();
  }, []);

  const stopHosting = useCallback(async (reason = 'user', announce = true) => {
    const session = activeSessionRef.current;
    if (!session || session.hostId !== clientId) return;
    if (announce) await sendSignal('host-stop', { reason }, session);
    clearHostPeers();
    stopStream(localStreamRef.current);
    localStreamRef.current = null;
    activeSessionRef.current = null;
    networkDegradedRef.current = false;
    currentProfileRef.current = SCREEN_SHARE_PROFILES.idle;
    if (mountedRef.current) {
      setStream(null);
      setMinimized(false);
      setView({
        phase: 'idle',
        role: null,
        hostName: '',
        message: '',
        profileId: 'idle',
        viewerCount: 0,
        networkDegraded: false,
        sourceMode: null,
        remoteBrowserState: null,
      });
    }
  }, [clearHostPeers, clientId, sendSignal]);
  stopHostingRef.current = stopHosting;

  const leaveViewerSession = useCallback((announce = true) => {
    const session = activeSessionRef.current;
    if (!session || session.hostId === clientId) return;
    clearViewerPeer(announce);
    activeSessionRef.current = null;
    if (mountedRef.current) {
      setStream(null);
      setMinimized(false);
      setView({
        phase: 'idle',
        role: null,
        hostName: '',
        message: '',
        profileId: 'idle',
        viewerCount: 0,
        networkDegraded: false,
        sourceMode: null,
        remoteBrowserState: null,
      });
    }
  }, [clearViewerPeer, clientId]);

  const announceHost = useCallback(() => {
    const session = activeSessionRef.current;
    if (!session || session.hostId !== clientId || !localStreamRef.current) return;
    sendSignal('host-start', {
      startedAt: session.startedAt,
      hostName: participantName,
      sourceMode: session.sourceMode ?? 'screen',
      paused: Boolean(localStreamRef.current.getVideoTracks?.()[0]?.muted),
    }, session);
  }, [clientId, participantName, sendSignal]);

  const createHostPeer = useCallback(async (viewerId) => {
    const session = activeSessionRef.current;
    const localStream = localStreamRef.current;
    if (!session || session.hostId !== clientId || !localStream) return;
    const safeViewerId = String(viewerId ?? '');
    if (!safeViewerId || safeViewerId === clientId) return;

    const existing = hostPeersRef.current.get(safeViewerId);
    if (existing?.creating) return;
    if (existing?.peer?.connectionState === 'connected'
      || existing?.peer?.connectionState === 'connecting') return;
    if (!existing && hostPeersRef.current.size >= MAX_SCREEN_SHARE_VIEWERS) {
      sendSignal('viewer-rejected', {
        targetId: safeViewerId,
        reason: 'room-full',
      }, session);
      return;
    }
    if (existing) closePeer(existing);

    const peer = new RTCPeerConnection(rtcConfiguration());
    const entry = { peer, sender: null, pendingIce: [], creating: true };
    hostPeersRef.current.set(safeViewerId, entry);
    localStream.getTracks().forEach((track) => {
      const sender = peer.addTrack(track, localStream);
      if (track.kind === 'video') entry.sender = sender;
    });

    peer.onicecandidate = (event) => {
      const candidate = serializableCandidate(event.candidate);
      if (!candidate) return;
      sendSignal('ice', { targetId: safeViewerId, candidate }, session);
    };
    peer.onconnectionstatechange = () => {
      const state = peer.connectionState;
      if (state === 'failed' || state === 'closed') {
        const current = hostPeersRef.current.get(safeViewerId);
        if (current?.peer === peer) {
          closePeer(current);
          hostPeersRef.current.delete(safeViewerId);
          updateView({ viewerCount: hostPeersRef.current.size });
        }
      }
    };

    try {
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      entry.creating = false;
      await applySenderProfile(
        entry.sender,
        currentProfileRef.current,
        networkDegradedRef.current,
      );
      updateView({ viewerCount: hostPeersRef.current.size });
      await sendSignal('offer', {
        targetId: safeViewerId,
        description: serializableDescription(peer.localDescription),
      }, session);
    } catch {
      closePeer(entry);
      hostPeersRef.current.delete(safeViewerId);
      updateView({ viewerCount: hostPeersRef.current.size });
    }
  }, [clientId, sendSignal, updateView]);

  const beginViewerSession = useCallback(async (candidate) => {
    const current = activeSessionRef.current;
    if (current?.sessionId === candidate.sessionId) {
      activeSessionRef.current = { ...current, ...candidate };
      if (viewerPeerRef.current?.peer?.connectionState !== 'connected') {
        connectViewerRelay(activeSessionRef.current);
      }
      if (candidate.paused) {
        updateView({
          phase: 'paused',
          message: 'Safari приостановил передачу, пока устройство ведущего находится в фоне.',
        });
      } else if (view.phase === 'paused') {
        updateView({ phase: stream ? 'viewing' : 'connecting', message: '' });
      }
      const state = viewerPeerRef.current?.peer?.connectionState;
      if (!['connected', 'connecting'].includes(state)) {
        await sendSignal('viewer-ready', { targetId: candidate.hostId }, candidate);
      }
      return;
    }

    if (current?.hostId === clientId) {
      const winner = preferredScreenShareSession(current, candidate);
      if (winner?.sessionId === current.sessionId) {
        announceHost();
        return;
      }
      await stopHosting('another-owner-started', true);
    } else if (current) {
      const winner = preferredScreenShareSession(current, candidate);
      if (winner?.sessionId === current.sessionId) return;
      clearViewerPeer(true);
    }

    activeSessionRef.current = candidate;
    pendingViewerIceRef.current = [];
    setStream(null);
    setMinimized(false);
    updateView({
      phase: candidate.paused ? 'paused' : 'connecting',
      role: 'viewer',
      hostName: candidate.hostName || 'Учитель',
      message: candidate.paused
        ? 'Safari приостановил передачу, пока устройство ведущего находится в фоне.'
        : 'Проверяю прямой и резервный каналы…',
      viewerCount: 0,
      networkDegraded: false,
      sourceMode: candidate.sourceMode === 'remote-browser' ? 'remote-browser' : 'screen',
      remoteBrowserState: candidate.remoteBrowserState ?? null,
    });
    connectViewerRelay(candidate);
    await sendSignal('viewer-ready', { targetId: candidate.hostId }, candidate);
  }, [announceHost, clearViewerPeer, clientId, connectViewerRelay, sendSignal, stopHosting, stream, updateView, view.phase]);

  const handleRemoteBrowserData = useCallback((event) => {
    applyRemoteBrowserPayload(event?.data);
  }, [applyRemoteBrowserPayload]);

  const acceptOffer = useCallback(async (signal) => {
    const session = activeSessionRef.current;
    if (!session || session.sessionId !== signal.sessionId || session.hostId !== signal.clientId) return;
    const earlyCandidates = pendingViewerIceRef.current.slice();
    clearViewerPeer(false, true);
    pendingViewerIceRef.current = earlyCandidates;

    const peer = new RTCPeerConnection(rtcConfiguration());
    const entry = { peer, sessionId: signal.sessionId, remoteStream: null };
    viewerPeerRef.current = entry;
    peer.ondatachannel = (event) => {
      const channel = event.channel;
      if (!channel || channel.label !== REMOTE_BROWSER_DATA_CHANNEL) return;
      entry.dataChannel = channel;
      remoteControlChannelRef.current = channel;
      channel.onmessage = handleRemoteBrowserData;
      channel.onclose = () => {
        if (remoteControlChannelRef.current === channel) remoteControlChannelRef.current = null;
      };
    };
    peer.onicecandidate = (event) => {
      const candidate = serializableCandidate(event.candidate);
      if (!candidate) return;
      sendSignal('ice', { targetId: signal.clientId, candidate }, session);
    };
    peer.ontrack = (event) => {
      const remoteStream = event.streams?.[0] ?? new MediaStream([event.track]);
      entry.remoteStream = remoteStream;
      event.track.onmute = () => updateView({
        phase: 'paused',
        message: 'Передача временно приостановлена. На iPhone и iPad она продолжится после возврата ведущего в Safari.',
      });
      event.track.onunmute = () => updateView({ phase: 'viewing', message: '' });
      if (peer.connectionState === 'connected') {
        setStream(remoteStream);
        clearViewerRelay();
        updateView({
          phase: event.track.muted ? 'paused' : 'viewing',
          message: event.track.muted ? 'Передача временно приостановлена.' : '',
        });
      }
    };
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === 'connected') {
        if (entry.remoteStream) setStream(entry.remoteStream);
        clearViewerRelay();
        updateView({ phase: 'viewing', message: '' });
      }
      if (peer.connectionState === 'failed') {
        setStream(null);
        const relayAvailable = connectViewerRelay(session);
        updateView(relayAvailable ? {
          phase: relayFrameUrlRef.current ? 'viewing' : 'connecting',
          message: relayFrameUrlRef.current ? '' : 'Прямой канал недоступен — подключаю резервный…',
        } : {
          phase: 'error',
          role: 'viewer',
          message: 'Прямое соединение не установилось, а резервный канал Mac недоступен.',
        });
      }
    };

    try {
      await peer.setRemoteDescription(signal.description);
      const queued = pendingViewerIceRef.current;
      pendingViewerIceRef.current = [];
      for (const candidate of queued) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await peer.addIceCandidate(candidate);
        } catch {
          // Continue with the remaining candidates.
        }
      }
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      await sendSignal('answer', {
        targetId: signal.clientId,
        description: serializableDescription(peer.localDescription),
      }, session);
    } catch {
      closePeer(entry);
      if (viewerPeerRef.current === entry) viewerPeerRef.current = null;
      updateView({
        phase: 'error',
        role: 'viewer',
        message: 'Не удалось открыть видеопоток. Обновите доску и повторите подключение.',
      });
    }
  }, [clearViewerPeer, clearViewerRelay, connectViewerRelay, handleRemoteBrowserData, sendSignal, updateView]);

  processSignalRef.current = async (rawPayload) => {
    const signal = normalizeScreenShareSignal(rawPayload);
    if (!signal || signal.clientId === clientId) return;
    if (signal.targetId && signal.targetId !== clientId) return;

    if (signal.type === 'remote-browser-available') {
      if (signal.permission !== 'owner') return;
      setRemoteAgent({
        clientId: signal.clientId,
        sessionId: signal.sessionId,
        name: signal.agentName || signal.name || 'Mac',
        expiresAt: Date.now() + REMOTE_BROWSER_AGENT_TTL_MS,
        busy: Boolean(signal.busy),
      });
      return;
    }
    if (signal.type === 'remote-browser-unavailable') {
      setRemoteAgent((current) => (
        current?.clientId === signal.clientId ? null : current
      ));
      return;
    }
    if (HOST_SIGNAL_TYPES.has(signal.type) && signal.permission !== 'owner') return;

    if (signal.type === 'host-start') {
      await beginViewerSession({
        sessionId: signal.sessionId,
        hostId: signal.clientId,
        hostName: signal.hostName || signal.name || 'Учитель',
        startedAt: Number(signal.startedAt ?? signal.timestamp),
        paused: Boolean(signal.paused),
        sourceMode: signal.sourceMode === 'remote-browser' ? 'remote-browser' : 'screen',
        remoteBrowserState: normalizeRemoteBrowserState(signal.remoteBrowserState),
        relayUrl: String(signal.relayUrl ?? ''),
        relayToken: String(signal.relayToken ?? ''),
      });
      return;
    }

    const session = activeSessionRef.current;
    if (!session || session.sessionId !== signal.sessionId) return;

    if (signal.type === 'host-stop' && signal.clientId === session.hostId) {
      leaveViewerSession(false);
      return;
    }
    if (signal.type === 'host-paused' && signal.clientId === session.hostId) {
      updateView({
        phase: signal.paused ? 'paused' : (stream ? 'viewing' : 'connecting'),
        message: signal.paused
          ? 'Safari приостановил передачу в фоне. Она продолжится после возврата ведущего.'
          : '',
      });
      return;
    }
    if (signal.type === 'viewer-ready' && session.hostId === clientId) {
      await createHostPeer(signal.clientId);
      return;
    }
    if (signal.type === 'viewer-leave' && session.hostId === clientId) {
      const entry = hostPeersRef.current.get(signal.clientId);
      closePeer(entry);
      hostPeersRef.current.delete(signal.clientId);
      updateView({ viewerCount: hostPeersRef.current.size });
      return;
    }
    if (signal.type === 'viewer-rejected' && session.hostId !== clientId) {
      if (signal.clientId !== session.hostId) return;
      clearViewerPeer(false);
      updateView({
        phase: 'error',
        role: 'viewer',
        message: 'К трансляции уже подключены три зрителя — достигнут лимит четырёх участников.',
      });
      return;
    }
    if (signal.type === 'offer' && session.hostId !== clientId && signal.description) {
      await acceptOffer(signal);
      return;
    }
    if (signal.type === 'answer' && session.hostId === clientId && signal.description) {
      const entry = hostPeersRef.current.get(signal.clientId);
      if (!entry?.peer) return;
      try {
        await entry.peer.setRemoteDescription(signal.description);
        const queued = entry.pendingIce.splice(0);
        for (const candidate of queued) {
          try {
            // eslint-disable-next-line no-await-in-loop
            await entry.peer.addIceCandidate(candidate);
          } catch {
            // Continue with the remaining candidates.
          }
        }
      } catch {
        closePeer(entry);
        hostPeersRef.current.delete(signal.clientId);
      }
      return;
    }
    if (signal.type === 'ice' && signal.candidate) {
      if (session.hostId === clientId) {
        const entry = hostPeersRef.current.get(signal.clientId);
        if (!entry?.peer) return;
        if (!entry.peer.remoteDescription) entry.pendingIce.push(signal.candidate);
        else {
          try {
            await entry.peer.addIceCandidate(signal.candidate);
          } catch {
            // One rejected candidate does not invalidate the entire connection.
          }
        }
      } else if (signal.clientId !== session.hostId) {
        return;
      } else if (!viewerPeerRef.current?.peer?.remoteDescription) {
        pendingViewerIceRef.current.push(signal.candidate);
      } else {
        try {
          await viewerPeerRef.current.peer.addIceCandidate(signal.candidate);
        } catch {
          // One rejected candidate does not invalidate the entire connection.
        }
      }
    }
  };

  const handleSignal = useCallback((payload) => {
    Promise.resolve(processSignalRef.current(payload)).catch(() => undefined);
  }, []);

  const start = useCallback(async () => {
    if (!isOwner || startBusyRef.current) return;
    const current = activeSessionRef.current;
    if (current && current.hostId !== clientId) {
      updateView({
        phase: 'error',
        role: 'viewer',
        message: 'На этой доске уже идёт одна демонстрация экрана.',
      });
      return;
    }
    if (!capability.supported) {
      updateView({ phase: 'unsupported', role: 'host', message: capability.advice });
      return;
    }

    startBusyRef.current = true;
    updateView({ phase: 'requesting', role: 'host', message: 'Выберите экран или вкладку для показа.' });
    try {
      const captured = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: { ideal: 10, max: 15 },
          width: { ideal: 1280, max: 1920 },
          height: { ideal: 720, max: 1080 },
        },
        audio: false,
      });
      const track = captured.getVideoTracks?.()[0];
      if (!track) throw new Error('capture-has-no-video');

      const session = {
        sessionId: randomToken(18),
        hostId: clientId,
        hostName: participantName,
        startedAt: Date.now(),
        sourceMode: 'screen',
      };
      activeSessionRef.current = session;
      localStreamRef.current = captured;
      currentProfileRef.current = SCREEN_SHARE_PROFILES.active;
      networkDegradedRef.current = false;
      track.onended = () => stopHostingRef.current('browser-ended', true);
      track.onmute = () => {
        updateView({
          phase: 'paused',
          message: 'iPhone или iPad приостановил передачу, пока Safari находится в фоне.',
        });
        sendSignal('host-paused', { paused: true }, session);
      };
      track.onunmute = () => {
        updateView({ phase: 'hosting', message: '' });
        sendSignal('host-paused', { paused: false }, session);
      };
      setStream(captured);
      setMinimized(false);
      updateView({
        phase: track.muted ? 'paused' : 'hosting',
        role: 'host',
        hostName: participantName,
        message: track.muted ? 'Передача временно приостановлена.' : '',
        profileId: 'active',
        viewerCount: 0,
        networkDegraded: false,
        sourceMode: 'screen',
        remoteBrowserState: null,
      });
      await applyCurrentProfile();
      announceHost();
    } catch (error) {
      stopStream(localStreamRef.current);
      localStreamRef.current = null;
      activeSessionRef.current = null;
      setStream(null);
      const denied = error?.name === 'NotAllowedError' || error?.name === 'AbortError';
      updateView({
        phase: 'error',
        role: 'host',
        message: denied
          ? 'Показ экрана не начат: выбор отменён или браузеру не выдано разрешение.'
          : 'Браузер не смог начать передачу экрана. Обновите страницу и попробуйте ещё раз.',
      });
    } finally {
      startBusyRef.current = false;
    }
  }, [announceHost, applyCurrentProfile, capability, clientId, isOwner, participantName, sendSignal, updateView]);

  const startRemoteBrowser = useCallback(async () => {
    if (!canEdit || startBusyRef.current) return;
    const current = activeSessionRef.current;
    if (current) {
      updateView({
        phase: 'error',
        role: current.hostId === clientId ? 'host' : 'viewer',
        message: 'На этой доске уже идёт одна трансляция.',
      });
      return;
    }
    const agent = remoteAgent?.expiresAt > Date.now() ? remoteAgent : null;
    if (!agent) {
      updateView({
        phase: 'remote-unavailable',
        role: 'viewer',
        sourceMode: 'remote-browser',
        message: 'Alex Browser Server не найден. Запустите его на Mac и подключите к этой учительской доске.',
      });
      return;
    }
    startBusyRef.current = true;
    updateView({
      phase: 'requesting',
      role: 'viewer',
      sourceMode: 'remote-browser',
      message: `Запускаю браузер на ${agent.name}…`,
    });
    try {
      await sendSignal('remote-browser-start', {
        targetId: agent.clientId,
        requestedByName: participantName,
      }, agent);
    } finally {
      window.setTimeout(() => { startBusyRef.current = false; }, 500);
    }
  }, [canEdit, clientId, participantName, remoteAgent, sendSignal, updateView]);

  const sendRemoteCommand = useCallback((command, options = {}) => {
    const session = activeSessionRef.current;
    const channel = remoteControlChannelRef.current;
    const relay = viewerRelayRef.current?.socket;
    if (!session || session.sourceMode !== 'remote-browser') return false;
    const transport = channel?.readyState === 'open'
      ? channel
      : (relay?.readyState === WebSocket.OPEN ? relay : null);
    if (!transport) return false;
    if (options.lossy && Number(transport.bufferedAmount ?? 0) > 96_000) return false;
    try {
      transport.send(JSON.stringify(command));
      return true;
    } catch {
      return false;
    }
  }, []);

  const requestRemoteControl = useCallback(() => sendRemoteCommand({
    type: 'control-request',
    takeover: Boolean(isOwner),
    name: participantName,
  }), [isOwner, participantName, sendRemoteCommand]);

  const releaseRemoteControl = useCallback(() => sendRemoteCommand({
    type: 'control-release',
  }), [sendRemoteCommand]);

  const stopRemoteBrowser = useCallback(async () => {
    const session = activeSessionRef.current;
    if (!isOwner || !session || session.sourceMode !== 'remote-browser') return;
    await sendSignal('remote-browser-stop', {
      targetId: session.hostId,
      reason: 'owner-stopped',
    }, session);
  }, [isOwner, sendSignal]);

  const toggle = useCallback(() => {
    const session = activeSessionRef.current;
    if (session?.hostId === clientId) stopHosting('user', true);
    else start();
  }, [clientId, start, stopHosting]);

  const dismiss = useCallback(() => {
    if (activeSessionRef.current?.hostId === clientId) return;
    if (activeSessionRef.current) leaveViewerSession(true);
    else updateView({ phase: 'idle', role: null, message: '' });
  }, [clientId, leaveViewerSession, updateView]);

  useEffect(() => {
    if (!remoteAgent) return undefined;
    const delay = Math.max(250, remoteAgent.expiresAt - Date.now() + 50);
    const timer = window.setTimeout(() => {
      setRemoteAgent((current) => (
        current?.expiresAt <= Date.now() ? null : current
      ));
    }, delay);
    return () => window.clearTimeout(timer);
  }, [remoteAgent]);

  useEffect(() => {
    const session = activeSessionRef.current;
    if (!session || session.hostId !== clientId || !localStreamRef.current) return undefined;

    const connectedIds = new Set((Array.isArray(users) ? users : [])
      .map((user) => String(user?.clientId ?? ''))
      .filter(Boolean));
    hostPeersRef.current.forEach((entry, viewerId) => {
      if (!connectedIds.has(viewerId)) {
        closePeer(entry);
        hostPeersRef.current.delete(viewerId);
      }
    });
    updateView({ viewerCount: hostPeersRef.current.size });
    announceHost();
    return undefined;
  }, [announceHost, clientId, updateView, users]);

  useEffect(() => {
    const session = activeSessionRef.current;
    if (!session || session.hostId !== clientId || !localStreamRef.current) return undefined;
    const timer = window.setInterval(announceHost, 4_000);
    return () => window.clearInterval(timer);
  }, [announceHost, clientId, view.role]);

  useEffect(() => {
    const session = activeSessionRef.current;
    if (!session || session.hostId !== clientId || !localStreamRef.current) return undefined;
    let lastMotionAt = performance.now();
    let lastInteractionAt = lastMotionAt;

    const noteInteraction = () => { lastInteractionAt = performance.now(); };
    const noteMotion = () => {
      lastMotionAt = performance.now();
      lastInteractionAt = lastMotionAt;
    };
    window.addEventListener('pointerdown', noteInteraction, { passive: true, capture: true });
    window.addEventListener('pointermove', noteMotion, { passive: true, capture: true });
    window.addEventListener('wheel', noteMotion, { passive: true, capture: true });
    window.addEventListener('keydown', noteInteraction, { capture: true });

    const timer = window.setInterval(() => {
      const profile = screenShareProfileForActivity({
        now: performance.now(),
        lastMotionAt,
        lastInteractionAt,
      });
      if (profile.id === currentProfileRef.current.id) return;
      currentProfileRef.current = profile;
      updateView({ profileId: profile.id });
      applyCurrentProfile();
    }, 250);

    return () => {
      window.clearInterval(timer);
      window.removeEventListener('pointerdown', noteInteraction, true);
      window.removeEventListener('pointermove', noteMotion, true);
      window.removeEventListener('wheel', noteMotion, true);
      window.removeEventListener('keydown', noteInteraction, true);
    };
  }, [applyCurrentProfile, clientId, updateView, view.role]);

  useEffect(() => {
    const session = activeSessionRef.current;
    if (!session || session.hostId !== clientId || !localStreamRef.current) return undefined;
    let disposed = false;
    const sample = async () => {
      const results = await Promise.allSettled([...hostPeersRef.current.values()].map((entry) => (
        peerNetworkSample(entry.peer)
      )));
      if (disposed) return;
      const degraded = results.some((result) => (
        result.status === 'fulfilled' && screenShareNetworkIsDegraded(result.value)
      ));
      if (degraded === networkDegradedRef.current) return;
      networkDegradedRef.current = degraded;
      updateView({ networkDegraded: degraded });
      applyCurrentProfile();
    };
    const timer = window.setInterval(() => sample().catch(() => undefined), 5_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [applyCurrentProfile, clientId, updateView, view.role]);

  useEffect(() => () => {
    mountedRef.current = false;
    const session = activeSessionRef.current;
    if (session?.hostId === clientId) {
      sendSignal('host-stop', { reason: 'page-closed' }, session);
    } else if (session) {
      sendSignal('viewer-leave', { targetId: session.hostId }, session);
    }
    clearHostPeers();
    clearViewerPeer(false);
    stopStream(localStreamRef.current);
    localStreamRef.current = null;
    activeSessionRef.current = null;
  }, [clearHostPeers, clearViewerPeer, clientId, sendSignal]);

  const isHosting = view.role === 'host'
    && ['requesting', 'hosting', 'paused'].includes(view.phase);
  const activeRemoteSession = Boolean(activeSessionRef.current && activeSessionRef.current.hostId !== clientId);
  const remoteBrowserActive = view.sourceMode === 'remote-browser'
    && Boolean(activeSessionRef.current);
  const remoteAvailable = Boolean(remoteAgent?.expiresAt > Date.now() && !remoteAgent.busy);

  return {
    ...view,
    stream,
    relayFrameUrl,
    minimized,
    setMinimized,
    capability,
    handleSignal,
    start,
    startRemoteBrowser,
    stop: () => stopHosting('user', true),
    stopRemoteBrowser,
    toggle,
    dismiss,
    sendRemoteCommand,
    requestRemoteControl,
    releaseRemoteControl,
    isHosting,
    activeRemoteSession,
    remoteBrowserActive,
    remoteAvailable,
    remoteAgentName: remoteAgent?.name ?? '',
    clientId,
    participantName,
    canEdit,
    isOwner,
    buttonDisabled: view.phase === 'requesting' || activeRemoteSession,
    profileLabel: SCREEN_SHARE_PROFILES[view.profileId]?.label ?? SCREEN_SHARE_PROFILES.idle.label,
  };
}

export function ScreenShareOverlay({ screenShare }) {
  const videoRef = useRef(null);
  const addressEditingRef = useRef(false);
  const [addressValue, setAddressValue] = useState('');
  const {
    phase,
    role,
    stream,
    relayFrameUrl,
    hostName,
    message,
    minimized,
    setMinimized,
    viewerCount,
    networkDegraded,
    profileLabel,
    stop,
    stopRemoteBrowser,
    dismiss,
    sourceMode,
    remoteBrowserState,
    sendRemoteCommand,
    requestRemoteControl,
    releaseRemoteControl,
    clientId,
    canEdit,
    isOwner,
  } = screenShare;

  const remoteBrowser = sourceMode === 'remote-browser';
  const hasRemoteControl = remoteBrowser
    && Boolean(remoteBrowserState?.controllerId)
    && remoteBrowserState.controllerId === clientId;

  useEffect(() => {
    if (!remoteBrowser || addressEditingRef.current) return;
    setAddressValue(remoteBrowserState?.url ?? '');
  }, [remoteBrowser, remoteBrowserState?.url]);

  useEffect(() => {
    const video = videoRef.current;
    if (!(video instanceof HTMLVideoElement)) return undefined;
    video.srcObject = stream ?? null;
    if (stream) video.play?.().catch(() => undefined);
    return () => {
      if (video.srcObject === stream) video.srcObject = null;
    };
  }, [stream, minimized]);

  if (phase === 'idle') return null;
  const present = role === 'host';
  const simpleNotice = phase === 'unsupported'
    || phase === 'remote-unavailable'
    || phase === 'error'
    || phase === 'requesting';
  const title = remoteBrowser
    ? 'Браузер на Mac'
    : (present ? 'Ваш экран' : `Экран: ${hostName || 'учитель'}`);

  const remotePoint = (event) => remoteBrowserPointerCoordinates({
    clientX: event.clientX,
    clientY: event.clientY,
    rect: videoRef.current?.getBoundingClientRect(),
    viewportWidth: remoteBrowserState?.width,
    viewportHeight: remoteBrowserState?.height,
  });

  const sendPointer = (event, action, lossy = false) => {
    if (!hasRemoteControl) return;
    const point = remotePoint(event);
    if (!point.inside && action === 'down') return;
    sendRemoteCommand({
      type: 'pointer',
      action,
      x: point.x,
      y: point.y,
      button: Number(event.button ?? 0),
      buttons: Number(event.buttons ?? 0),
      pointerType: String(event.pointerType ?? 'mouse'),
      pointerId: Number(event.pointerId ?? 1),
    }, { lossy });
  };

  const navigate = () => {
    const value = addressValue.trim();
    if (!value || !hasRemoteControl) return;
    sendRemoteCommand({ type: 'navigate', url: value });
  };

  return (
    <aside
      className={`screen-share-panel ${minimized ? 'is-minimized' : ''} ${simpleNotice ? 'is-notice' : ''}`.trim()}
      aria-live="polite"
      aria-label="Демонстрация экрана"
    >
      <div className="screen-share-header">
        <div className="screen-share-title">
          <span className={`screen-share-live-dot ${phase === 'paused' ? 'is-paused' : ''}`} aria-hidden="true" />
          <span>{title}</span>
        </div>
        <div className="screen-share-header-actions">
          {!simpleNotice && (
            <button
              type="button"
              title={minimized ? 'Развернуть трансляцию' : 'Свернуть трансляцию'}
              aria-label={minimized ? 'Развернуть трансляцию' : 'Свернуть трансляцию'}
              onClick={() => setMinimized(!minimized)}
            >
              {minimized ? '□' : '—'}
            </button>
          )}
          {remoteBrowser && isOwner && !simpleNotice ? (
            <button type="button" className="screen-share-stop" onClick={stopRemoteBrowser}>Стоп</button>
          ) : (present && ['hosting', 'paused'].includes(phase) ? (
            <button type="button" className="screen-share-stop" onClick={stop}>Стоп</button>
          ) : (simpleNotice && phase !== 'requesting' ? (
            <button type="button" aria-label="Закрыть" onClick={dismiss}>×</button>
          ) : null))}
        </div>
      </div>

      {!minimized && (
        <>
          {remoteBrowser && (stream || relayFrameUrl) && !simpleNotice && (
            <div className="remote-browser-toolbar">
              <button type="button" disabled={!hasRemoteControl || !remoteBrowserState?.canGoBack} onClick={() => sendRemoteCommand({ type: 'history', action: 'back' })} aria-label="Назад">←</button>
              <button type="button" disabled={!hasRemoteControl || !remoteBrowserState?.canGoForward} onClick={() => sendRemoteCommand({ type: 'history', action: 'forward' })} aria-label="Вперёд">→</button>
              <button type="button" disabled={!hasRemoteControl} onClick={() => sendRemoteCommand({ type: 'history', action: 'reload' })} aria-label="Обновить">↻</button>
              <form onSubmit={(event) => { event.preventDefault(); navigate(); }}>
                <input
                  value={addressValue}
                  disabled={!hasRemoteControl}
                  aria-label="Адрес сайта"
                  placeholder="Введите адрес сайта"
                  onFocus={() => { addressEditingRef.current = true; }}
                  onBlur={() => { addressEditingRef.current = false; }}
                  onChange={(event) => setAddressValue(event.target.value)}
                />
              </form>
              <span className={remoteBrowserState?.loading ? 'is-loading' : ''} title={remoteBrowserState?.title || ''}>
                {remoteBrowserState?.loading ? 'Загрузка…' : 'Готово'}
              </span>
            </div>
          )}

          {(stream || relayFrameUrl) && !simpleNotice ? (
            <div
              className={`screen-share-video-wrap ${remoteBrowser ? 'is-remote-browser' : ''}`}
              onPointerDown={(event) => {
                if (!remoteBrowser || !hasRemoteControl) return;
                event.preventDefault();
                event.currentTarget.setPointerCapture?.(event.pointerId);
                sendPointer(event, 'down');
              }}
              onPointerMove={(event) => {
                if (!remoteBrowser || !hasRemoteControl) return;
                event.preventDefault();
                sendPointer(event, 'move', true);
              }}
              onPointerUp={(event) => {
                if (!remoteBrowser || !hasRemoteControl) return;
                event.preventDefault();
                sendPointer(event, 'up');
                event.currentTarget.releasePointerCapture?.(event.pointerId);
              }}
              onPointerCancel={(event) => {
                if (!remoteBrowser || !hasRemoteControl) return;
                sendPointer(event, 'cancel');
              }}
              onWheel={(event) => {
                if (!remoteBrowser || !hasRemoteControl) return;
                event.preventDefault();
                const point = remotePoint(event);
                sendRemoteCommand({
                  type: 'wheel',
                  x: point.x,
                  y: point.y,
                  deltaX: event.deltaX,
                  deltaY: event.deltaY,
                }, { lossy: true });
              }}
              onContextMenu={(event) => remoteBrowser && event.preventDefault()}
            >
              {stream ? (
                <video ref={videoRef} autoPlay playsInline muted draggable={false} />
              ) : (
                <img ref={videoRef} src={relayFrameUrl} alt="Трансляция браузера" draggable={false} />
              )}
              {phase === 'paused' && <div className="screen-share-video-status">Пауза</div>}
              {remoteBrowser && !hasRemoteControl && (
                <div className="remote-browser-control-hint">
                  {remoteBrowserState?.controllerId
                    ? `Управляет: ${remoteBrowserState.controllerName || 'участник'}`
                    : 'Управление свободно'}
                </div>
              )}
            </div>
          ) : (
            <div className="screen-share-message">
              {phase === 'requesting' && <span className="screen-share-spinner" aria-hidden="true" />}
              <span>{message || 'Подключение к трансляции…'}</span>
            </div>
          )}

          {!simpleNotice && (
            remoteBrowser ? (
              <div className="screen-share-footer remote-browser-footer">
                <div className="remote-browser-control-row">
                  {hasRemoteControl ? (
                    <button type="button" onClick={releaseRemoteControl}>Освободить управление</button>
                  ) : (
                    <button
                      type="button"
                      disabled={!canEdit || (Boolean(remoteBrowserState?.controllerId) && !isOwner)}
                      onClick={requestRemoteControl}
                    >
                      {remoteBrowserState?.controllerId && isOwner ? 'Перехватить управление' : 'Управлять'}
                    </button>
                  )}
                  {hasRemoteControl && (
                    <input
                      className="remote-browser-keyboard-input"
                      inputMode="text"
                      placeholder="Текст на сайт"
                      aria-label="Ввод текста на сайт"
                      onBeforeInput={(event) => {
                        const text = event.nativeEvent?.data;
                        if (text) sendRemoteCommand({ type: 'text', text });
                      }}
                      onKeyDown={(event) => {
                        const special = new Set(['Enter', 'Backspace', 'Delete', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
                        if (!special.has(event.key)) return;
                        event.preventDefault();
                        sendRemoteCommand({ type: 'key', key: event.key });
                      }}
                      value=""
                      onChange={() => undefined}
                    />
                  )}
                </div>
                <span>{relayFrameUrl ? 'Резервный канал через Mac' : 'Прямое P2P'} · {Number(remoteBrowserState?.frameRate ?? 0).toFixed(0)} кадр/с</span>
                <span>{networkDegraded ? 'Сеть слабая · качество снижено' : 'Частота меняется автоматически'}</span>
                <small>Кадры создаются только при изменении страницы. Старые кадры не накапливаются.</small>
              </div>
            ) : (
              <div className="screen-share-footer">
                <span>{present ? `Зрителей: ${viewerCount}/${MAX_SCREEN_SHARE_VIEWERS}` : 'Прямое P2P-соединение'}</span>
                <span>{networkDegraded ? 'Сеть слабая · качество снижено' : profileLabel}</span>
                <small>На iPhone/iPad передача приостанавливается, если ведущий сворачивает Safari.</small>
              </div>
            )
          )}
        </>
      )}
    </aside>
  );
}
