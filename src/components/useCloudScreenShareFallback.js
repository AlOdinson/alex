import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createCloudflarePublisher,
  createCloudflareScreenShareApi,
  createCloudflareSubscriber,
} from '../lib/cloudflareScreenShare.js';
import {
  normalizeCloudScreenShareRoute,
  normalizeScreenShareSignal,
  SCREEN_SHARE_PROFILES,
  SCREEN_SHARE_PROTOCOL,
  screenShareCloudTrackName,
  screenSharePermissionCanHost,
} from '../lib/screenShare.js';
import { isSupabaseConfigured, supabase } from '../lib/supabase.js';

export const CLOUD_SCREEN_SHARE_STATE_EVENT = 'alex-screen-share-cloud-state';
export const CLOUD_SCREEN_SHARE_TOGGLE_EVENT = 'alex-screen-share-cloud-toggle';

const CLOUD_SIGNAL_EVENT = 'screen-share-cloud';
const CLOUD_SIGNAL_TYPES = new Set(['cloud-track', 'cloud-disable', 'cloud-viewer-ready']);
const CLOUD_TRACK_REPEAT_MS = 4_000;
const CLOUD_DISABLE_GRACE_MS = 250;

function wait(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function cloudErrorMessage(error) {
  const message = String(error?.message ?? error ?? '');
  if (/not configured|не настро/i.test(message)) return 'Cloud relay не настроен.';
  if (/permission|access|403/i.test(message)) return 'Нет доступа к Cloud relay.';
  return 'Cloud relay не подключился.';
}

async function applyCloudSenderProfile(sender, profile, degraded) {
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
    // Keep the Cloud peer alive on browsers that reject runtime encoding changes.
  }
}

function defaultCloudState() {
  return {
    transport: 'p2p',
    cloudPhase: 'off',
    cloudError: '',
    cloudViewerCount: 0,
  };
}

export function useCloudScreenShareFallback({
  boardId,
  boardKey,
  boardRealtimeKey,
  clientId,
  participantName,
  isOwner,
  canEdit,
  sessionId,
  hostId,
  role,
  sourceMode,
  p2pStream,
  profileId,
  networkDegraded,
}) {
  const [cloudStream, setCloudStream] = useState(null);
  const [cloudState, setCloudState] = useState(defaultCloudState);

  const mountedRef = useRef(true);
  const publisherRef = useRef(null);
  const subscriberRef = useRef(null);
  const cloudViewerIdsRef = useRef(new Set());
  const channelRef = useRef(null);
  const processSignalRef = useRef(() => undefined);
  const toggleBusyRef = useRef(false);
  const sessionContextRef = useRef(null);

  sessionContextRef.current = {
    boardId,
    sessionId,
    hostId,
    role,
    sourceMode,
  };

  const patchCloudState = useCallback((patch) => {
    if (!mountedRef.current) return;
    setCloudState((current) => ({ ...current, ...patch }));
  }, []);

  const clearCloudPublisher = useCallback(() => {
    const publisher = publisherRef.current;
    publisherRef.current = null;
    cloudViewerIdsRef.current.clear();
    if (!publisher?.close) return Promise.resolve();
    return Promise.resolve(publisher.close()).catch((error) => {
      console.warn('Could not clean Cloud publisher', error);
    });
  }, []);

  const clearCloudSubscriber = useCallback(() => {
    const subscriber = subscriberRef.current;
    subscriberRef.current = null;
    if (mountedRef.current) setCloudStream(null);
    if (!subscriber?.close) return Promise.resolve();
    return Promise.resolve(subscriber.close()).catch((error) => {
      console.warn('Could not clean Cloud subscriber', error);
    });
  }, []);

  const cloudApi = useCallback((screenShareSessionId) => createCloudflareScreenShareApi({
    supabase,
    boardId,
    boardKey,
    screenShareSessionId,
  }), [boardId, boardKey]);

  const sendCloudSignal = useCallback(async (type, details = {}) => {
    const currentSessionId = String(details.sessionId ?? sessionContextRef.current?.sessionId ?? '');
    if (!currentSessionId || !CLOUD_SIGNAL_TYPES.has(type)) return 'ignored';
    const channelEntry = channelRef.current;
    if (!channelEntry) throw new Error('Cloud signaling is unavailable');
    await channelEntry.ready;
    await channelEntry.channel.send({
      type: 'broadcast',
      event: CLOUD_SIGNAL_EVENT,
      payload: {
        protocol: SCREEN_SHARE_PROTOCOL,
        type,
        sessionId: currentSessionId,
        ...details,
        clientId,
        name: participantName,
        permission: isOwner ? 'owner' : (canEdit ? 'edit' : 'view'),
        timestamp: Date.now(),
      },
    });
    return 'sent';
  }, [canEdit, clientId, isOwner, participantName]);

  const announceCloudTrack = useCallback(() => {
    const publisher = publisherRef.current;
    const current = sessionContextRef.current;
    if (!publisher || current?.role !== 'host' || current.hostId !== clientId) {
      return Promise.resolve('ignored');
    }
    return sendCloudSignal('cloud-track', {
      sessionId: current.sessionId,
      publisherSessionId: publisher.sessionId,
      trackName: publisher.trackName,
    });
  }, [clientId, sendCloudSignal]);

  const setCloudEnabled = useCallback(async (enabled) => {
    const current = sessionContextRef.current;
    if (!current?.sessionId
      || current.sourceMode !== 'screen'
      || current.role !== 'host'
      || current.hostId !== clientId
      || !canEdit
      || toggleBusyRef.current) return false;

    if (enabled) {
      if (publisherRef.current) return true;
      const videoTrack = p2pStream?.getVideoTracks?.()[0];
      if (!videoTrack) {
        patchCloudState({
          transport: 'p2p',
          cloudPhase: 'error',
          cloudError: 'Нет активного видеопотока для Cloud relay.',
        });
        return false;
      }

      toggleBusyRef.current = true;
      patchCloudState({ transport: 'p2p', cloudPhase: 'connecting', cloudError: '' });
      let publisher = null;
      try {
        const trackName = screenShareCloudTrackName(boardId, current.sessionId);
        if (!trackName) throw new Error('Invalid Cloud screen-share route');
        publisher = await createCloudflarePublisher({
          track: videoTrack,
          trackName,
          api: cloudApi(current.sessionId),
        });

        const latest = sessionContextRef.current;
        if (latest?.sessionId !== current.sessionId
          || latest?.role !== 'host'
          || latest.hostId !== clientId) {
          await publisher.close();
          return false;
        }

        publisherRef.current = publisher;
        const profile = SCREEN_SHARE_PROFILES[profileId] ?? SCREEN_SHARE_PROFILES.idle;
        await applyCloudSenderProfile(publisher.sender, profile, Boolean(networkDegraded));
        await announceCloudTrack();
        patchCloudState({
          transport: 'cloud',
          cloudPhase: 'on',
          cloudError: '',
          cloudViewerCount: 0,
        });
        return true;
      } catch (error) {
        if (publisher && publisherRef.current !== publisher) {
          await Promise.resolve(publisher.close()).catch(() => undefined);
        }
        await clearCloudPublisher();
        patchCloudState({
          transport: 'p2p',
          cloudPhase: 'error',
          cloudError: cloudErrorMessage(error),
          cloudViewerCount: 0,
        });
        return false;
      } finally {
        toggleBusyRef.current = false;
      }
    }

    if (!publisherRef.current) {
      patchCloudState(defaultCloudState());
      return true;
    }

    toggleBusyRef.current = true;
    patchCloudState({ cloudPhase: 'disconnecting', cloudError: '' });
    try {
      await sendCloudSignal('cloud-disable', { sessionId: current.sessionId }).catch(() => undefined);
      await wait(CLOUD_DISABLE_GRACE_MS);
      await clearCloudPublisher();
      patchCloudState(defaultCloudState());
      return true;
    } finally {
      toggleBusyRef.current = false;
    }
  }, [
    announceCloudTrack,
    boardId,
    canEdit,
    clearCloudPublisher,
    clientId,
    cloudApi,
    networkDegraded,
    p2pStream,
    patchCloudState,
    profileId,
    sendCloudSignal,
  ]);

  processSignalRef.current = async (rawPayload) => {
    const signal = normalizeScreenShareSignal(rawPayload);
    if (!signal || !CLOUD_SIGNAL_TYPES.has(signal.type)) return;
    if (signal.clientId === clientId) return;
    if (signal.targetId && signal.targetId !== clientId) return;

    const current = sessionContextRef.current;
    const currentSessionId = String(current?.sessionId ?? '');
    if (!currentSessionId || signal.sessionId !== currentSessionId) return;
    const sessionId = currentSessionId;
    if (signal.sessionId !== sessionId) return;
    if (current.sourceMode !== 'screen') return;

    if (signal.type === 'cloud-track') {
      if (current.role !== 'viewer'
        || signal.clientId !== current.hostId
        || !screenSharePermissionCanHost(signal.permission)) return;
      const route = normalizeCloudScreenShareRoute(signal, {
        boardId: current.boardId,
        screenShareSessionId: sessionId,
      });
      if (!route) return;

      const existing = subscriberRef.current;
      if (existing?.publisherSessionId === route.publisherSessionId
        && existing?.trackName === route.trackName) {
        await sendCloudSignal('cloud-viewer-ready', {
          sessionId,
          targetId: current.hostId,
        }).catch(() => undefined);
        return;
      }

      await clearCloudSubscriber();
      patchCloudState({ cloudPhase: 'connecting', cloudError: '' });
      try {
        const subscriber = await createCloudflareSubscriber({
          publisherSessionId: route.publisherSessionId,
          trackName: route.trackName,
          api: cloudApi(sessionId),
        });
        const latest = sessionContextRef.current;
        if (latest?.sessionId !== sessionId
          || latest?.role !== 'viewer'
          || latest.hostId !== current.hostId) {
          await subscriber.close();
          return;
        }
        subscriberRef.current = subscriber;
        if (mountedRef.current) setCloudStream(subscriber.stream);
        patchCloudState({ transport: 'cloud', cloudPhase: 'on', cloudError: '' });
        await sendCloudSignal('cloud-viewer-ready', {
          sessionId,
          targetId: current.hostId,
        }).catch(() => undefined);
      } catch (error) {
        await clearCloudSubscriber();
        patchCloudState({
          transport: 'p2p',
          cloudPhase: 'error',
          cloudError: cloudErrorMessage(error),
        });
      }
      return;
    }

    if (signal.type === 'cloud-disable') {
      if (current.role !== 'viewer'
        || signal.clientId !== current.hostId
        || !screenSharePermissionCanHost(signal.permission)) return;
      await clearCloudSubscriber();
      patchCloudState(defaultCloudState());
      return;
    }

    if (signal.type === 'cloud-viewer-ready') {
      if (current.role !== 'host' || current.hostId !== clientId || !publisherRef.current) return;
      cloudViewerIdsRef.current.add(signal.clientId);
      patchCloudState({ cloudViewerCount: cloudViewerIdsRef.current.size });
    }
  };

  useEffect(() => {
    if (!boardId || !boardRealtimeKey || !isSupabaseConfigured || !supabase) {
      channelRef.current = null;
      return undefined;
    }
    let disposed = false;
    const channel = supabase.channel(`screen-share-cloud-v1:${boardId}:${boardRealtimeKey}`, {
      config: { broadcast: { self: false } },
    });
    channel.on('broadcast', { event: CLOUD_SIGNAL_EVENT }, ({ payload }) => {
      if (!disposed) Promise.resolve(processSignalRef.current(payload)).catch(() => undefined);
    });
    const ready = new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('Cloud signaling timed out')), 12_000);
      channel.subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          window.clearTimeout(timer);
          resolve();
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          window.clearTimeout(timer);
          reject(new Error(`Cloud signaling: ${status}`));
        }
      });
    });
    channelRef.current = { channel, ready };
    return () => {
      disposed = true;
      if (channelRef.current?.channel === channel) channelRef.current = null;
      supabase.removeChannel(channel);
    };
  }, [boardId, boardRealtimeKey]);

  useEffect(() => {
    cloudViewerIdsRef.current.clear();
    setCloudStream(null);
    setCloudState(defaultCloudState());
    return () => {
      clearCloudPublisher();
      clearCloudSubscriber();
      cloudViewerIdsRef.current.clear();
    };
  }, [clearCloudPublisher, clearCloudSubscriber, sessionId, sourceMode]);

  useEffect(() => {
    const publisher = publisherRef.current;
    if (!publisher?.sender) return;
    const profile = SCREEN_SHARE_PROFILES[profileId] ?? SCREEN_SHARE_PROFILES.idle;
    applyCloudSenderProfile(publisher.sender, profile, Boolean(networkDegraded)).catch(() => undefined);
  }, [networkDegraded, profileId]);

  useEffect(() => {
    if (cloudState.transport !== 'cloud' || cloudState.cloudPhase !== 'on' || role !== 'host') {
      return undefined;
    }
    const timer = window.setInterval(() => {
      announceCloudTrack().catch(() => undefined);
    }, CLOUD_TRACK_REPEAT_MS);
    return () => window.clearInterval(timer);
  }, [announceCloudTrack, cloudState.cloudPhase, cloudState.transport, role]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const visible = Boolean(
      sessionId
      && sourceMode === 'screen'
      && role === 'host'
      && hostId === clientId,
    );
    window.dispatchEvent(new CustomEvent(CLOUD_SCREEN_SHARE_STATE_EVENT, {
      detail: {
        sessionId,
        visible,
        transport: cloudState.transport,
        cloudPhase: cloudState.cloudPhase,
        cloudError: cloudState.cloudError,
      },
    }));
    return undefined;
  }, [clientId, cloudState, hostId, role, sessionId, sourceMode]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const handleToggle = (event) => {
      const detail = event?.detail ?? {};
      if (String(detail.sessionId ?? '') !== String(sessionId ?? '')) return;
      if (role !== 'host' || hostId !== clientId || sourceMode !== 'screen') return;
      setCloudEnabled(Boolean(detail.enabled));
    };
    window.addEventListener(CLOUD_SCREEN_SHARE_TOGGLE_EVENT, handleToggle);
    return () => window.removeEventListener(CLOUD_SCREEN_SHARE_TOGGLE_EVENT, handleToggle);
  }, [clientId, hostId, role, sessionId, setCloudEnabled, sourceMode]);

  useEffect(() => () => {
    mountedRef.current = false;
    clearCloudPublisher();
    clearCloudSubscriber();
  }, [clearCloudPublisher, clearCloudSubscriber]);

  return {
    stream: cloudStream ?? p2pStream,
    transport: cloudState.transport,
    cloudPhase: cloudState.cloudPhase,
    cloudError: cloudState.cloudError,
    cloudViewerCount: cloudState.cloudViewerCount,
    setCloudEnabled,
  };
}
