// Video notifications are signals, not a place to do synchronous canvas/GPU
// work. A single display-clock pump coalesces them and samples playback progress
// independently, so a stalled requestVideoFrameCallback cannot pin a receiver to
// 2 FPS. It has no dependency on the presenter's local Ultra checkbox.
const CALLBACK_GRACE_MS = 100;
const DISPLAY_INTERVAL_MS = 1000 / 60;

function playbackProgress(video) {
  // A detached MediaStream video can count frames as DOM-display drops while
  // the decoded pixels are available to drawImage. Never subtract that counter:
  // total-dropped can stay at 1 while decoding and rVFC both continue normally.
  const decoded = Number(video.webkitDecodedFrameCount);
  if (Number.isFinite(decoded) && decoded > 0) return { kind: 'decoded', value: decoded };
  try {
    const total = Number(video.getVideoPlaybackQuality?.().totalVideoFrames);
    if (Number.isFinite(total) && total > 0) return { kind: 'frames', value: total };
  } catch { /* Older/partial implementations can throw. */ }
  const time = Number(video.currentTime);
  return Number.isFinite(time) ? { kind: 'time', value: time } : null;
}

export function createScreenShareFramePump({ video, drawFrame, isVisible = () => true }) {
  const clock = globalThis;
  const now = () => clock.performance?.now?.() ?? Date.now();
  const request = typeof clock.requestAnimationFrame === 'function'
    ? clock.requestAnimationFrame.bind(clock)
    : callback => clock.setTimeout(() => callback(now()), DISPLAY_INTERVAL_MS);
  const cancel = typeof clock.cancelAnimationFrame === 'function'
    ? clock.cancelAnimationFrame.bind(clock) : clock.clearTimeout.bind(clock);
  let running = false, generation = 0, animationId = null, videoId = null;
  let signal = 0, paintedSignal = 0, lastNotificationAt = -Infinity;
  let lastProgress = null, lastWidth = 0, lastHeight = 0, wasVisible = false;
  const stats = { notifications: 0, presentations: 0, progressRecoveries: 0, errors: 0 };

  const armVideo = token => {
    if (!running || token !== generation || typeof video.requestVideoFrameCallback !== 'function') return;
    try {
      videoId = video.requestVideoFrameCallback(() => {
        if (!running || token !== generation) return;
        videoId = null;
        signal++; stats.notifications++; lastNotificationAt = now();
        // Re-arm before ANY rendering. A burst never creates a render queue.
        armVideo(token);
      });
    } catch { videoId = null; /* The progress pump remains usable. */ }
  };

  const tick = token => {
    if (!running || token !== generation) return;
    animationId = null;
    try {
      const visible = isVisible() && Number(video.readyState) >= 2 && !video.paused && !video.ended;
      if (!visible) { wasVisible = false; return; }
      const resumed = !wasVisible;
      wasVisible = true;
      const progress = playbackProgress(video);
      const newProgress = progress && (progress.kind !== lastProgress?.kind || progress.value !== lastProgress?.value);
      const notified = signal !== paintedSignal;
      const frameCounter = progress && progress.kind !== 'time';
      const needsFrame = resumed || video.videoWidth !== lastWidth || video.videoHeight !== lastHeight
        || (frameCounter ? newProgress : notified || (
          newProgress && (videoId == null || now() - lastNotificationAt >= CALLBACK_GRACE_MS)
        ));
      if (!needsFrame) return;
      // Returning false (not ready/temporarily unavailable) must leave progress
      // unconsumed so the same newest frame is retried, even with no new signal.
      if (drawFrame() === false) return;
      stats.presentations++;
      if (!notified && newProgress && lastProgress) stats.progressRecoveries++;
      paintedSignal = signal;
      lastProgress = progress;
      lastWidth = video.videoWidth; lastHeight = video.videoHeight;
    } catch {
      // A transient rendering exception must not kill the only frame loop.
      stats.errors++;
    } finally {
      if (running && token === generation) animationId = request(() => tick(token));
    }
  };

  const stop = () => {
    running = false; generation++;
    if (animationId != null) cancel(animationId);
    if (videoId != null) {
      try { video.cancelVideoFrameCallback?.(videoId); } catch { /* Already cancelled. */ }
    }
    animationId = videoId = null;
    lastProgress = null; wasVisible = false;
  };
  return {
    start() {
      if (running) return; // loadedmetadata + playing must not double the loops.
      running = true; const token = ++generation;
      signal = paintedSignal = 0; lastNotificationAt = -Infinity;
      lastProgress = null; lastWidth = lastHeight = 0; wasVisible = false;
      armVideo(token); animationId = request(() => tick(token));
    },
    stop,
    getStats: () => ({ ...stats, running }),
  };
}
