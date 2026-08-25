import { useEffect, useRef, useState } from 'react';
import { randomToken } from '../lib/ids.js';
import { isSupabaseConfigured, supabase } from '../lib/supabase.js';
import {
  MAX_REMOTE_BROWSER_VIEWERS,
  normalizeRemoteBrowserState,
  normalizeScreenShareSignal,
  REMOTE_BROWSER_DATA_CHANNEL,
  rtcConfiguration,
  SCREEN_SHARE_PROTOCOL,
} from '../lib/screenShare.js';

const AGENT_HEARTBEAT_MS = 3_000;
const HOST_HEARTBEAT_MS = 4_000;

function serializableDescription(description) {
  return description ? { type: description.type, sdp: description.sdp } : null;
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

function closePeer(entry) {
  if (!entry) return;
  if (entry.dataChannel) {
    entry.dataChannel.onmessage = null;
    entry.dataChannel.onopen = null;
    try { entry.dataChannel.close(); } catch { /* Already closed. */ }
  }
  if (entry.peer) {
    entry.peer.onicecandidate = null;
    entry.peer.onconnectionstatechange = null;
    try { entry.peer.close(); } catch { /* Already closed. */ }
  }
}

async function connectSignalChannel({
  boardId,
  boardKey,
  realtimeKey,
  clientId,
  name,
  onSignal,
}) {
  if (!isSupabaseConfigured || !supabase) {
    throw new Error('Supabase не настроен в этой сборке доски.');
  }
  const topic = `board:${boardId}:${realtimeKey}`;
  const publishPayload = (signal) => ({
    ...signal,
    clientId,
    name,
    permission: 'owner',
    timestamp: Date.now(),
  });

  if (window.Ably?.Realtime) {
    let client = null;
    try {
      client = new window.Ably.Realtime({
        clientId,
        useTokenAuth: true,
        echoMessages: false,
        authCallback: async (_params, callback) => {
          try {
            const { data, error } = await supabase.functions.invoke('ably-token', {
              body: { boardId, boardKey, clientId },
            });
            if (error) throw error;
            if (!data?.token) throw new Error('Сервер не вернул токен Ably');
            callback(null, data);
          } catch (error) {
            callback(error, null);
          }
        },
        disconnectedRetryTimeout: 5_000,
        suspendedRetryTimeout: 15_000,
      });
      await new Promise((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error('Ably не подключился')), 12_000);
        client.connection.once('connected', () => {
          window.clearTimeout(timer);
          resolve();
        });
        client.connection.once('failed', (change) => {
          window.clearTimeout(timer);
          reject(change?.reason ?? new Error('Ably connection failed'));
        });
      });
      const channel = client.channels.get(topic);
      await channel.subscribe((message) => {
        if (message?.name === 'screen-share-signal') onSignal(message.data);
      });
      return {
        transport: 'ably',
        async publish(signal) {
          await channel.publish('screen-share-signal', publishPayload(signal));
        },
        async close() {
          try { await channel.unsubscribe(); } catch { /* Best effort. */ }
          client.close();
        },
      };
    } catch (error) {
      // The ordinary board already falls back to Supabase when Ably token
      // issuance is unavailable. The Mac agent must follow the same route or
      // the two participants silently end up on different transports.
      try { client?.close(); } catch { /* The failed client may already be closed. */ }
      console.warn('Ably unavailable for Mac browser; using Supabase Realtime', error);
    }
  }

  const channel = supabase.channel(topic, {
    config: { broadcast: { self: false } },
  });
  channel.on('broadcast', { event: 'screen-share-signal' }, ({ payload }) => onSignal(payload));
  await new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('Supabase Realtime не подключился')), 12_000);
    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        window.clearTimeout(timer);
        resolve();
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        window.clearTimeout(timer);
        reject(new Error(`Supabase Realtime: ${status}`));
      }
    });
  });
  return {
    transport: 'supabase',
    publish(signal) {
      return channel.send({
        type: 'broadcast',
        event: 'screen-share-signal',
        payload: publishPayload(signal),
      });
    },
    close() {
      return supabase.removeChannel(channel);
    },
  };
}

function bridgeUrlFromLocation() {
  const params = new URLSearchParams(window.location.search);
  const port = Number(params.get('alexBridgePort') ?? 0);
  const token = String(params.get('alexBridgeToken') ?? '');
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || token.length < 20) return '';
  return `ws://127.0.0.1:${port}/bridge?token=${encodeURIComponent(token)}`;
}

export function isMacBrowserHostMode() {
  return new URLSearchParams(window.location.search).get('alexMacHost') === '1';
}

export default function MacBrowserHost({
  boardId,
  boardKey,
  realtimeKey,
  participantName,
  permission,
}) {
  const canvasRef = useRef(null);
  const [status, setStatus] = useState('Подключение к локальному серверу…');
  const [details, setDetails] = useState('');

  useEffect(() => {
    let disposed = false;
    let bridge = null;
    let signalChannel = null;
    let stream = null;
    let track = null;
    let activeSession = null;
    let browserState = normalizeRemoteBrowserState({});
    let controllerId = '';
    let controllerName = '';
    let relayInfo = null;
    let drawBusy = false;
    let pendingFrame = null;
    const peers = new Map();
    const pendingSignals = [];
    let drainingSignals = false;
    const agentClientId = `mac-browser-${randomToken(10)}`;
    const agentSessionId = `agent-${randomToken(12)}`;
    let availabilityTimer = null;
    let hostTimer = null;

    const updateStatus = (next, extra = '') => {
      if (disposed) return;
      setStatus(next);
      setDetails(extra);
    };

    const sendBridge = (payload) => {
      if (bridge?.readyState !== WebSocket.OPEN) return false;
      bridge.send(JSON.stringify(payload));
      return true;
    };

    const publish = async (type, payload = {}, session = activeSession) => {
      if (!signalChannel) return;
      const sessionId = String(payload.sessionId ?? session?.sessionId ?? agentSessionId);
      await signalChannel.publish({
        protocol: SCREEN_SHARE_PROTOCOL,
        type,
        sessionId,
        ...payload,
      });
    };

    const stateForViewers = () => ({
      ...browserState,
      controllerId,
      controllerName,
    });

    const sendStateToPeer = (entry) => {
      if (entry?.dataChannel?.readyState !== 'open') return;
      try {
        entry.dataChannel.send(JSON.stringify({
          type: 'remote-state',
          state: stateForViewers(),
        }));
      } catch {
        // The next state update will retry after a short network handoff.
      }
    };

    const broadcastState = () => {
      peers.forEach(sendStateToPeer);
      sendBridge({ type: 'relay-state', state: stateForViewers() });
    };

    const announceAvailability = () => publish('remote-browser-available', {
      sessionId: agentSessionId,
      agentName: 'Mac M1',
      busy: Boolean(activeSession),
    }, { sessionId: agentSessionId }).catch(() => undefined);

    const announceHost = () => {
      if (!activeSession) return Promise.resolve();
      return publish('host-start', {
        startedAt: activeSession.startedAt,
        hostName: 'Браузер на Mac',
        sourceMode: 'remote-browser',
        paused: false,
        remoteBrowserState: stateForViewers(),
        relayUrl: relayInfo?.sessionId === activeSession.sessionId ? relayInfo.url : '',
        relayToken: relayInfo?.sessionId === activeSession.sessionId ? relayInfo.token : '',
      }, activeSession).catch(() => undefined);
    };

    const closeAllPeers = () => {
      peers.forEach(closePeer);
      peers.clear();
    };

    const stopSession = async (reason = 'stopped', announce = true) => {
      const previous = activeSession;
      if (!previous) return;
      activeSession = null;
      relayInfo = null;
      controllerId = '';
      controllerName = '';
      closeAllPeers();
      sendBridge({ type: 'stop-session', reason });
      if (announce) await publish('host-stop', { reason }, previous).catch(() => undefined);
      updateStatus('Mac подключён · браузер ожидает запуска');
      announceAvailability();
    };

    const handleRemoteData = (viewerId, rawData) => {
      const entry = peers.get(viewerId);
      if (!entry) return;
      let payload = rawData && typeof rawData === 'object' ? rawData : null;
      if (!payload) {
        try { payload = JSON.parse(String(rawData ?? '')); } catch { return; }
      }

      if (payload?.type === 'control-request') {
        const mayTake = !controllerId
          || controllerId === viewerId
          || (entry.permission === 'owner' && Boolean(payload.takeover));
        if (!mayTake) return;
        controllerId = viewerId;
        controllerName = String(entry.name || payload.name || 'Участник');
        broadcastState();
        return;
      }
      if (payload?.type === 'control-release') {
        if (controllerId !== viewerId) return;
        controllerId = '';
        controllerName = '';
        broadcastState();
        return;
      }
      if (controllerId !== viewerId) return;
      if (!['pointer', 'wheel', 'text', 'key', 'navigate', 'history'].includes(payload?.type)) return;
      sendBridge({ type: 'command', command: payload });
    };

    const createPeer = async (signal) => {
      if (!activeSession || signal.sessionId !== activeSession.sessionId || !track) return;
      const viewerId = String(signal.clientId ?? '');
      if (!viewerId || viewerId === agentClientId) return;
      const existing = peers.get(viewerId);
      if (existing) closePeer(existing);
      if (!existing && peers.size >= MAX_REMOTE_BROWSER_VIEWERS) {
        await publish('viewer-rejected', {
          targetId: viewerId,
          reason: 'room-full',
        }, activeSession);
        return;
      }

      const peer = new RTCPeerConnection(rtcConfiguration());
      const dataChannel = peer.createDataChannel(REMOTE_BROWSER_DATA_CHANNEL, { ordered: true });
      const entry = {
        peer,
        dataChannel,
        pendingIce: [],
        permission: signal.permission,
        name: signal.name || 'Участник',
      };
      peers.set(viewerId, entry);
      peer.addTrack(track, stream);
      dataChannel.onopen = () => {
        sendStateToPeer(entry);
        track?.requestFrame?.();
      };
      dataChannel.onmessage = (event) => handleRemoteData(viewerId, event.data);
      peer.onicecandidate = (event) => {
        const candidate = serializableCandidate(event.candidate);
        if (!candidate) return;
        publish('ice', { targetId: viewerId, candidate }, activeSession).catch(() => undefined);
      };
      peer.onconnectionstatechange = () => {
        if (peer.connectionState === 'connected') {
          track?.requestFrame?.();
          return;
        }
        if (!['failed', 'closed', 'disconnected'].includes(peer.connectionState)) return;
        const current = peers.get(viewerId);
        if (current?.peer !== peer) return;
        closePeer(current);
        current.peer = null;
        current.dataChannel = null;
        current.pendingIce = [];
      };

      try {
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        await publish('offer', {
          targetId: viewerId,
          description: serializableDescription(peer.localDescription),
        }, activeSession);
      } catch {
        closePeer(entry);
        peers.delete(viewerId);
      }
    };

    const processSignal = async (rawSignal) => {
      const signal = normalizeScreenShareSignal(rawSignal);
      if (!signal || signal.clientId === agentClientId) return;
      if (signal.targetId && signal.targetId !== agentClientId) return;

      if (signal.type === 'remote-browser-start') {
        if (!['owner', 'edit'].includes(signal.permission)) return;
        if (activeSession) {
          await announceHost();
          return;
        }
        activeSession = {
          sessionId: randomToken(18),
          hostId: agentClientId,
          startedAt: Date.now(),
          sourceMode: 'remote-browser',
        };
        controllerId = signal.clientId;
        controllerName = signal.requestedByName || signal.name || 'Участник';
        sendBridge({ type: 'start-session', sessionId: activeSession.sessionId });
        updateStatus('Удалённый браузер работает', `Управляет: ${controllerName}`);
        await announceHost();
        await announceAvailability();
        return;
      }

      if (!activeSession || signal.sessionId !== activeSession.sessionId) return;
      if (signal.type === 'remote-browser-stop') {
        if (signal.permission === 'owner') await stopSession(signal.reason || 'owner-stopped', true);
        return;
      }
      if (signal.type === 'viewer-ready') {
        await createPeer(signal);
        return;
      }
      if (signal.type === 'viewer-leave') {
        const entry = peers.get(signal.clientId);
        closePeer(entry);
        peers.delete(signal.clientId);
        if (controllerId === signal.clientId) {
          controllerId = '';
          controllerName = '';
          broadcastState();
        }
        return;
      }
      if (signal.type === 'answer' && signal.description) {
        const entry = peers.get(signal.clientId);
        if (!entry?.peer) return;
        try {
          await entry.peer.setRemoteDescription(signal.description);
          const queued = entry.pendingIce.splice(0);
          for (const candidate of queued) {
            try {
              // eslint-disable-next-line no-await-in-loop
              await entry.peer.addIceCandidate(candidate);
            } catch { /* Continue with the remaining candidates. */ }
          }
        } catch {
          closePeer(entry);
          peers.delete(signal.clientId);
        }
        return;
      }
      if (signal.type === 'ice' && signal.candidate) {
        const entry = peers.get(signal.clientId);
        if (!entry?.peer) return;
        if (!entry.peer.remoteDescription) entry.pendingIce.push(signal.candidate);
        else {
          try { await entry.peer.addIceCandidate(signal.candidate); } catch { /* Ignore one candidate. */ }
        }
      }
    };

    const drawFrame = async (frame) => {
      if (drawBusy) {
        pendingFrame = frame;
        return;
      }
      drawBusy = true;
      try {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const bitmap = await createImageBitmap(new Blob([frame], { type: 'image/jpeg' }));
        if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
        }
        const context = canvas.getContext('2d', { alpha: false });
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        bitmap.close?.();
        track?.requestFrame?.();
      } finally {
        drawBusy = false;
        const latest = pendingFrame;
        pendingFrame = null;
        if (latest) drawFrame(latest).catch(() => undefined);
      }
    };

    const drainSignals = async () => {
      if (drainingSignals || disposed) return;
      drainingSignals = true;
      try {
        while (pendingSignals.length && !disposed) {
          const next = pendingSignals.shift();
          // Keep signaling ordered: an answer must never overtake its offer.
          // eslint-disable-next-line no-await-in-loop
          await processSignal(next);
        }
      } finally {
        drainingSignals = false;
        if (pendingSignals.length && !disposed) drainSignals().catch(() => undefined);
      }
    };

    async function boot() {
      if (permission !== 'owner') {
        throw new Error('Для Mac-сервера нужна специальная учительская ссылка с ключом владельца.');
      }
      const url = bridgeUrlFromLocation();
      if (!url) throw new Error('Служебная ссылка Mac повреждена. Перезапустите Alex Browser Server.');
      const canvas = canvasRef.current;
      if (!canvas?.captureStream) throw new Error('Chrome не поддерживает поток Canvas.');
      stream = canvas.captureStream(0);
      track = stream.getVideoTracks()[0];

      bridge = new WebSocket(url);
      bridge.binaryType = 'arraybuffer';
      bridge.onmessage = (event) => {
        if (typeof event.data !== 'string') {
          drawFrame(event.data).catch(() => undefined);
          return;
        }
        let payload = null;
        try { payload = JSON.parse(event.data); } catch { return; }
        if (payload?.type === 'state') {
          browserState = normalizeRemoteBrowserState(payload.state) ?? browserState;
          broadcastState();
        } else if (payload?.type === 'relay-session') {
          const relay = payload.relay;
          const validUrl = String(relay?.url ?? '').startsWith('wss://');
          const validToken = String(relay?.token ?? '').length >= 20;
          if (validUrl && validToken && String(relay?.sessionId ?? '') === activeSession?.sessionId) {
            relayInfo = {
              url: String(relay.url),
              token: String(relay.token),
              sessionId: String(relay.sessionId),
            };
            announceHost();
          }
        } else if (payload?.type === 'relay-command') {
          handleRemoteData(String(payload.viewerId ?? ''), payload.command);
        } else if (payload?.type === 'session-stopped' && activeSession) {
          stopSession(payload.reason || 'mac-stopped', true);
        }
      };
      await new Promise((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error('Локальный Mac-сервис не ответил')), 10_000);
        bridge.onopen = () => {
          window.clearTimeout(timer);
          bridge.send(JSON.stringify({ type: 'agent-ready' }));
          resolve();
        };
        bridge.onerror = () => {
          window.clearTimeout(timer);
          reject(new Error('Не удалось открыть локальный канал Mac'));
        };
      });
      bridge.onclose = () => {
        if (!disposed) {
          stopSession('mac-disconnected', true);
          updateStatus('Связь с Alex Browser Server потеряна');
        }
      };

      signalChannel = await connectSignalChannel({
        boardId,
        boardKey,
        realtimeKey,
        clientId: agentClientId,
        name: 'Браузер на Mac',
        onSignal: (signal) => {
          pendingSignals.push(signal);
          drainSignals().catch(() => undefined);
        },
      });
      sendBridge({ type: 'signal-transport', transport: signalChannel.transport });
      await announceAvailability();
      availabilityTimer = window.setInterval(announceAvailability, AGENT_HEARTBEAT_MS);
      hostTimer = window.setInterval(announceHost, HOST_HEARTBEAT_MS);
      updateStatus('Mac подключён · браузер ожидает запуска', 'Откройте доску на iPad и нажмите «Браузер».');
    }

    boot().catch((error) => updateStatus('Mac-сервер не подключён', error.message));

    return () => {
      disposed = true;
      window.clearInterval(availabilityTimer);
      window.clearInterval(hostTimer);
      if (activeSession) publish('host-stop', { reason: 'agent-closed' }, activeSession).catch(() => undefined);
      publish('remote-browser-unavailable', { sessionId: agentSessionId }, { sessionId: agentSessionId }).catch(() => undefined);
      closeAllPeers();
      track?.stop?.();
      bridge?.close?.();
      signalChannel?.close?.();
    };
  }, [boardId, boardKey, participantName, permission, realtimeKey]);

  return (
    <main className="mac-browser-host-page">
      <section>
        <span className="mac-browser-host-dot" aria-hidden="true" />
        <h1>Alex Browser Server</h1>
        <p>{status}</p>
        {details && <small>{details}</small>}
        <canvas ref={canvasRef} width="1920" height="1080" aria-hidden="true" />
      </section>
    </main>
  );
}
