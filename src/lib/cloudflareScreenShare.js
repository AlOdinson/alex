const CLOUDFLARE_STUN_CONFIGURATION = Object.freeze({
  iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }],
  bundlePolicy: 'max-bundle',
});

const ICE_GATHER_TIMEOUT_MS = 5_000;
const VIDEO_TRACK_TIMEOUT_MS = 12_000;

function normalizeFunctionError(error, data) {
  if (data?.error) return new Error(String(data.error));
  const message = String(error?.message ?? error ?? 'Cloud relay request failed');
  return new Error(message || 'Cloud relay request failed');
}

function requireText(value, label) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function firstTrackMid(response, fallback = '') {
  const tracks = Array.isArray(response?.tracks) ? response.tracks : [];
  const mid = String(tracks[0]?.mid ?? fallback ?? '').trim();
  return mid;
}

function serializableDescription(description) {
  if (!description) return null;
  return {
    type: String(description.type ?? ''),
    sdp: String(description.sdp ?? ''),
  };
}

export function cloudflareScreenShareRtcConfiguration() {
  return {
    iceServers: [{ urls: [...CLOUDFLARE_STUN_CONFIGURATION.iceServers[0].urls] }],
    bundlePolicy: CLOUDFLARE_STUN_CONFIGURATION.bundlePolicy,
  };
}

export function createCloudflareScreenShareApi({
  supabase,
  boardId,
  boardKey,
  screenShareSessionId,
}) {
  if (!supabase?.functions?.invoke) throw new Error('Supabase Functions are unavailable');
  const base = {
    boardId: requireText(boardId, 'boardId'),
    boardKey: requireText(boardKey, 'boardKey'),
    screenShareSessionId: requireText(screenShareSessionId, 'screenShareSessionId'),
  };

  const invoke = async (operation, details = {}) => {
    const { data, error } = await supabase.functions.invoke('cloudflare-realtime', {
      body: {
        ...base,
        operation,
        ...details,
      },
    });
    if (error || data?.error) throw normalizeFunctionError(error, data);
    if (!data || typeof data !== 'object') throw new Error('Cloud relay returned no data');
    return data;
  };

  return {
    createPublisherSession() {
      return invoke('create-publisher-session');
    },
    publishTrack(details) {
      return invoke('publish-track', details);
    },
    createViewerSession() {
      return invoke('create-viewer-session');
    },
    subscribeTrack(details) {
      return invoke('subscribe-track', details);
    },
    renegotiateViewer(details) {
      return invoke('renegotiate-viewer', details);
    },
    closeTrack(details) {
      return invoke('close-track', details);
    },
  };
}

export function waitForIceGatheringComplete(peer, timeoutMs = ICE_GATHER_TIMEOUT_MS) {
  if (!peer) return Promise.reject(new Error('Cloud peer is missing'));
  if (peer.iceGatheringState === 'complete') return Promise.resolve();

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      peer.removeEventListener?.('icegatheringstatechange', onStateChange);
      if (error) reject(error);
      else resolve();
    };
    const onStateChange = () => {
      if (peer.iceGatheringState === 'complete') finish();
    };
    const timer = setTimeout(
      () => finish(new Error('Cloud ICE gathering timed out')),
      Math.max(250, Number(timeoutMs) || ICE_GATHER_TIMEOUT_MS),
    );
    peer.addEventListener?.('icegatheringstatechange', onStateChange);
    onStateChange();
  });
}

function waitForVideoStream(peer, MediaStreamImpl, timeoutMs = VIDEO_TRACK_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const previous = peer.ontrack;
    const finish = (stream, error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (peer.ontrack === onTrack) peer.ontrack = previous ?? null;
      if (error) reject(error);
      else resolve(stream);
    };
    const onTrack = (event) => {
      if (event?.track?.kind && event.track.kind !== 'video') return;
      const stream = event?.streams?.[0]
        ?? (MediaStreamImpl && event?.track ? new MediaStreamImpl([event.track]) : null);
      if (stream) finish(stream);
    };
    const timer = setTimeout(
      () => finish(null, new Error('Cloud video track timed out')),
      Math.max(500, Number(timeoutMs) || VIDEO_TRACK_TIMEOUT_MS),
    );
    peer.ontrack = onTrack;
  });
}

function closePeer(peer) {
  if (!peer) return;
  peer.ontrack = null;
  try {
    peer.close();
  } catch {
    // A partially negotiated peer may already be closed.
  }
}

function validateCloudAnswer(response) {
  const description = serializableDescription(response?.sessionDescription);
  if (!description || description.type !== 'answer' || !description.sdp) {
    throw new Error('Cloud publisher returned no SDP answer');
  }
  return description;
}

function validateCloudOffer(response) {
  const description = serializableDescription(response?.sessionDescription);
  if (!description || description.type !== 'offer' || !description.sdp) {
    throw new Error('Cloud subscriber returned no SDP offer');
  }
  return description;
}

export async function createCloudflarePublisher({
  track,
  trackName,
  api,
  RTCPeerConnectionImpl = globalThis.RTCPeerConnection,
  iceGatherTimeoutMs = ICE_GATHER_TIMEOUT_MS,
}) {
  void iceGatherTimeoutMs;
  if (!track) throw new Error('A capture track is required');
  if (!api?.createPublisherSession || !api?.publishTrack) {
    throw new Error('Cloud publisher API is unavailable');
  }
  if (typeof RTCPeerConnectionImpl !== 'function') {
    throw new Error('RTCPeerConnection is unavailable');
  }

  const routeTrackName = requireText(trackName, 'trackName');
  const session = await api.createPublisherSession();
  const sessionId = requireText(session?.sessionId, 'publisher sessionId');
  const sessionLease = requireText(session?.sessionLease, 'publisher sessionLease');
  const peer = new RTCPeerConnectionImpl(cloudflareScreenShareRtcConfiguration());
  let mid = '';
  let closed = false;

  try {
    const transceiver = peer.addTransceiver(track, { direction: 'sendonly' });
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    mid = requireText(transceiver?.mid, 'publisher track mid');
    const offerDescription = serializableDescription(offer);
    if (!offerDescription?.sdp) throw new Error('Cloud publisher has no local SDP offer');

    const response = await api.publishTrack({
      sessionId,
      sessionLease,
      mid,
      sdp: offerDescription.sdp,
    });
    await peer.setRemoteDescription(validateCloudAnswer(response));
    mid = firstTrackMid(response, mid) || mid;

    const close = async () => {
      if (closed) return;
      closed = true;
      if (mid) {
        try {
          await api.closeTrack?.({ sessionId, sessionLease, mid });
        } catch (error) {
          console.warn('Could not close Cloud publisher track', error);
        }
      }
      closePeer(peer);
    };

    return {
      sessionId,
      sessionLease,
      trackName: routeTrackName,
      mid,
      peer,
      sender: transceiver.sender,
      close,
    };
  } catch (error) {
    closePeer(peer);
    throw error;
  }
}

export async function createCloudflareSubscriber({
  publisherSessionId,
  trackName,
  api,
  RTCPeerConnectionImpl = globalThis.RTCPeerConnection,
  MediaStreamImpl = globalThis.MediaStream,
  iceGatherTimeoutMs = ICE_GATHER_TIMEOUT_MS,
  trackTimeoutMs = VIDEO_TRACK_TIMEOUT_MS,
}) {
  void iceGatherTimeoutMs;
  if (!api?.createViewerSession || !api?.subscribeTrack || !api?.renegotiateViewer) {
    throw new Error('Cloud subscriber API is unavailable');
  }
  if (typeof RTCPeerConnectionImpl !== 'function') {
    throw new Error('RTCPeerConnection is unavailable');
  }

  const sourceSessionId = requireText(publisherSessionId, 'publisherSessionId');
  const routeTrackName = requireText(trackName, 'trackName');
  const session = await api.createViewerSession();
  const sessionId = requireText(session?.sessionId, 'viewer sessionId');
  const sessionLease = requireText(session?.sessionLease, 'viewer sessionLease');
  const peer = new RTCPeerConnectionImpl(cloudflareScreenShareRtcConfiguration());
  const streamPromise = waitForVideoStream(peer, MediaStreamImpl, trackTimeoutMs);
  let mid = '';
  let closed = false;

  try {
    const response = await api.subscribeTrack({
      sessionId,
      sessionLease,
      publisherSessionId: sourceSessionId,
    });
    mid = firstTrackMid(response);
    const offer = validateCloudOffer(response);
    await peer.setRemoteDescription(offer);
    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);
    const answerDescription = serializableDescription(answer);
    if (!answerDescription?.sdp) throw new Error('Cloud subscriber has no local SDP answer');

    if (response?.requiresImmediateRenegotiation !== false) {
      await api.renegotiateViewer({
        sessionId,
        sessionLease,
        sdp: answerDescription.sdp,
      });
    }

    const stream = await streamPromise;
    const close = async () => {
      if (closed) return;
      closed = true;
      if (mid) {
        try {
          await api.closeTrack?.({ sessionId, sessionLease, mid });
        } catch (error) {
          console.warn('Could not close Cloud viewer track', error);
        }
      }
      closePeer(peer);
    };

    return {
      sessionId,
      sessionLease,
      publisherSessionId: sourceSessionId,
      trackName: routeTrackName,
      mid,
      peer,
      stream,
      close,
    };
  } catch (error) {
    closePeer(peer);
    throw error;
  }
}
