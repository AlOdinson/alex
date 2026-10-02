# Empty-board screen-share receiver audit — 2026-10-03

Production source: main `d3f04e21b38472e33ec49f371fce2aca14bcd06a`, version 1.43.2. No runtime source change or deployment was made during this audit. All receiver scenes had exactly one Fabric object: the received video, enforced by assertion.

## Final evidence

Diagnostic source commit: `a1cb2dbfe406418f4f6d9603ee5e09b63e06c81e`.
Actions run: https://github.com/AlOdinson/alex/actions/runs/37060666221
All four native-browser measurement jobs completed. Each produced nine scenarios with no recorded page errors. Successful measurement completion is NOT an FPS pass criterion or a shipped fix.

Artifacts: `11251280037` (same Chromium), `11250910422` (same WebKit), `11250466242` (WebKit sender/Chromium receiver), `11250701031` (Chromium sender/WebKit receiver).

Measurements use inbound RTP framesDecoded deltas and actual per-video drawImage(video) calls, not object.render counts or the requested sender FPS. The latter counts could include repeated passes. No physical display FPS is claimed.

## Confirmed receiving-side slowdown

On macOS, WebKit sender -> Chromium receiver, the same incoming connection and Ultra profile gave:

| Receiver-only configuration | Decoded frames/s | Video-to-canvas copies/s | Mean synchronous frame callback work, ms |
|---|---:|---:|---:|
| Current fast compositor, viewport 1200x900 DPR2 | 30.63 | 9.00 | 49.07 |
| Ordinary render fallback, same viewport | 30.22 | 18.17 | 9.26 |
| Fast compositor restored, same viewport | 30.09 | 15.24 | 26.84 |
| Current fast compositor, viewport 1920x1080 DPR2 | 29.99 | 10.38 | 33.27 |
| Ordinary render fallback, same larger viewport | 29.66 | 18.47 | 9.72 |
| Fast compositor with an empty rAF heartbeat, larger viewport | 31.02 | 14.53 | 30.23 |

Packet-loss and decoder-dropped-frame deltas were zero in all these intervals. Switching the receiving render path caused substantial improvements without changing the sender profile or reconnecting. Therefore receiver rendering can itself discard much of the available cadence on an empty scene.

This is not universal across engines. Same-engine Chromium on Ubuntu showed 26.90 copies/s initially versus 21.63 on fallback, with decoder cadence also changing. Same-engine WebKit showed 23.59 versus 27.79; mixed Chromium -> WebKit showed 21.66 versus 24.04. The path should not be blindly replaced everywhere based on the worst case. Sequential short windows have warm-up and CI load variability.

## Code mechanism and causal limits

`src/lib/boardScreenShare.js`, drawVideoFrame/startFrameLoop: copying the received video to an intermediate canvas and calling compositor.present() happen synchronously inside requestVideoFrameCallback. The next callback is registered afterwards.

`src/lib/boardScreenShareCompositor.js`, present(): even an otherwise empty scene copies full-viewport lower and upper bitmaps around the video. Upper is transparent when no foreground objects exist. The pixel cost depends on the receiver's physical canvas size, not just the incoming 720/1080 video dimensions.

The A/B probe uses a visually transparent overlayColor to select the existing ordinary rendering fallback. It changes both compositing work and requestAnimationFrame scheduling. It establishes the effect of the whole path; it does NOT precisely separate GPU-copy cost from scheduling effects.

## Missing recovery when receiver callbacks slow down

The app falls back to an interval only if requestVideoFrameCallback is absent, not if it exists but runs slowly. There is no comparison of incoming decoded progress against canvas presentation progress.

In a clearly labelled FAULT-INJECTION experiment, only the receiver callback delivery was changed to one callback every 500ms. WebKit -> Chromium still decoded 30.21 frames/s in Ultra and 30.18 frames/s in Ultra+720, but canvas copies stayed at 1.95 and 1.75/s. Receiver-only rAF polling removed this injected ceiling on the same connection, producing 37.74 copies/s with 28.61 decoded frames/s. Extra copies may repeat frames; this is NOT 37.74 unique video FPS or a production-ready patch.

Crucially: natural Ultra scenarios did NOT reproduce the user's exact persistent 2fps. The injection proves the missing-recovery failure mode, not that the user's browser actually entered it. The user's real session/hardware/network/Cloud path was not observed.

## Separate compatibility limit

If the video callback API is unavailable, the fallback uses a 66ms interval unless local ultraState.enabled is true. The viewer's local flag does not represent the sender's mode. Earlier empty-scene probes demonstrated roughly 15 canvas copies/s while decoding about 29-35/s. This explains a separate 15fps ceiling, not the reported 2fps.

## Probe limitations and exclusions

Real Board UI and real RTCPeerConnections were used, but getDisplayMedia was replaced by a moving generated canvas, and signaling was bridged in the test process. There was no production Cloud/Ably connection or physical Apple-device test. Mac and Linux CI machines cannot establish the user's device performance.

WebKit playback-quality counters were zero in this environment, so RTP counters were used. Initial exploratory FAULT/PROBE results are excluded because unbound timer cancellation could leave overlapping loops; the final run uses bound cancellation wrappers. DOM append/remove experiments are not used as evidence that detached video inherently runs at 2fps.

## Correct fix targets

Separate frame notification from expensive drawing; coalesce to the newest available frame. Recover when decoding advances but presentation stalls. Avoid mandatory full-window layer copying for empty/simple scenes, with measured path selection or a bounded redraw region. Do not tie a viewer fallback to sender-only local UI flags. Add empty-board, mixed-browser and stalled-callback cadence regressions measuring received/decoded/presented frames and pauses rather than merely total decoded frames.

No claim of complete root-cause attribution for the user's precise 2fps, and no claim of a deployed fix.
