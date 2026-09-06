# Cloudflare Screen Share Fallback Design

## Goal

Add a host-controlled `Cloud` transport switch to the existing normal screen-share object. Normal screen sharing continues to use the current direct WebRTC P2P path by default. When the host enables `Cloud`, the already-captured screen track is published through Cloudflare Realtime SFU and viewers switch to the Cloudflare-routed track without asking the host to choose the screen again. Disabling `Cloud` restores the existing P2P path and then tears down the Cloudflare media sessions.

This change applies only to normal `sourceMode: 'screen'`. The existing remote-browser path is out of scope.

## Confirmed UX

- Starting screen share behaves exactly as today: `getDisplayMedia()` runs once and P2P WebRTC is the initial transport.
- The live board-native screen object shows a compact host-only control in its upper-right corner: `Cloud ☐`.
- Viewers do not see or control the checkbox.
- Clicking `Cloud ☐` enters a short connecting state (`Cloud …`) while the existing P2P stream remains active.
- Cloud mode becomes active only after the host Cloudflare publisher is connected and the current viewers have been told how to subscribe.
- On success the control becomes `Cloud ☑`; the same captured `MediaStreamTrack` is routed through Cloudflare Realtime SFU.
- No second screen picker is shown and capture is not restarted.
- If Cloud setup fails, the checkbox returns to off, the P2P session remains untouched, and the host receives a small non-blocking error/status indication.
- Clicking `Cloud ☑` to disable Cloud first resumes/rebuilds the existing P2P viewer connections, then closes the Cloudflare viewer/publisher sessions. The host remains on the same capture track throughout.
- If P2P is still impossible for a viewer after Cloud is disabled, that viewer may lose the picture again; this is expected and does not stop the host capture.
- Stopping screen share closes both P2P and any Cloudflare resources.

## Architecture

### Existing P2P path remains the baseline

The current screen-share flow remains authoritative for capture and board rendering:

1. `navigator.mediaDevices.getDisplayMedia()` captures one video track.
2. The host normally creates one P2P `RTCPeerConnection` per viewer.
3. A viewer receives a `MediaStream` through WebRTC.
4. `src/lib/boardScreenShare.js` renders that stream into the transient Fabric screen-share object.

Cloud mode adds a second media transport but does not duplicate capture or change Fabric persistence/lifecycle rules.

### Cloudflare transport module

Add a focused client module, proposed path:

`src/lib/cloudflareScreenShare.js`

Responsibilities:

- create and close the host Cloudflare `RTCPeerConnection`;
- publish the existing screen `MediaStreamTrack` as a send-only local track;
- create and close a viewer Cloudflare `RTCPeerConnection`;
- subscribe to the host's published track using the host Cloudflare session/track identifiers;
- complete Cloudflare SDP negotiation through the backend proxy;
- expose connection state and a viewer `MediaStream` to `useAdaptiveScreenShare`;
- never contain the Cloudflare App Secret.

The module uses `stun:stun.cloudflare.com:3478` for Cloudflare peer connections, matching Cloudflare's current official SFU examples. Existing Google STUN configuration remains unchanged for P2P.

### Backend credential boundary

Cloudflare Realtime App ID and App Secret must not be shipped in Vite/browser code. Add one Supabase Edge Function, proposed slug:

`cloudflare-realtime`

The function acts as a narrow authenticated proxy for the Cloudflare Realtime SFU HTTPS API. It stores these environment secrets:

- `CLOUDFLARE_REALTIME_APP_ID`
- `CLOUDFLARE_REALTIME_APP_SECRET`

The function accepts the existing board credentials (`boardId`, `boardKey`) and verifies access using the same pattern as the deployed `ably-token` function:

1. validate input shapes;
2. SHA-256 the board key;
3. call `get_board_access_v4(p_id, p_key_hash)`, with the existing legacy fallback only if needed;
4. reject closed or invalid board access;
5. perform only the requested Cloudflare session/track operation;
6. return `Cache-Control: no-store` and never return the Cloudflare secret.

The browser calls this Edge Function with the existing Supabase publishable client. The Edge Function may keep `verify_jwt: false` only because board access is explicitly authenticated by possession of the board key, matching the current `ably-token` model. No service-role or Cloudflare secret is exposed to the browser.

### Narrow backend operations

The first version supports only operations required for screen sharing:

- create Cloudflare session;
- publish a local video track (`tracks/new` with host SDP offer);
- subscribe a viewer session to one published track;
- renegotiate a viewer session when Cloudflare requests immediate renegotiation;
- close the published track/session when Cloud mode or screen share stops.

The endpoint does not expose an unrestricted pass-through URL or arbitrary HTTP method. The client sends a small operation enum and validated identifiers/SDP; the server constructs the Cloudflare API path itself.

### Cloud transport signaling

The existing screen-share signaling channel continues to carry application state. Add signal types dedicated to Cloud mode, for example:

- `cloud-enable` — host announces Cloud activation attempt/state;
- `cloud-track` — host publishes the Cloudflare publisher session ID and track name needed by viewers;
- `cloud-disable` — host announces return to P2P;
- `cloud-viewer-ready` — optional acknowledgement used only for status/diagnostics, not as a media transport.

The Cloudflare App Secret is never sent in signaling. Cloudflare session IDs and track names are routing identifiers and may be shared with authorized board participants; backend access checks still gate all Cloudflare API mutations.

### Host enable flow

When the host clicks `Cloud`:

1. Keep all existing P2P peer connections alive.
2. Create a Cloudflare publisher session through the Edge Function.
3. Create a Cloudflare host `RTCPeerConnection` and attach the existing captured video track using a send-only transceiver.
4. Create/set the SDP offer locally and proxy the publish request to Cloudflare.
5. Apply Cloudflare's SDP answer to the host peer.
6. Obtain the published track identifier from the Cloudflare response.
7. Broadcast `cloud-track` for the active screen-share `sessionId`.
8. Viewers create their Cloudflare subscriber sessions and receive the host track.
9. Once Cloud mode is established, viewers prefer the Cloudflare `MediaStream` for the board object. Existing P2P peers may be closed after a short grace period to avoid needless duplicate upstream traffic.
10. Update host UI to `Cloud ☑`.

If any host-side step before track publication fails, Cloud mode is aborted and P2P continues unchanged.

### Viewer Cloud flow

On `cloud-track` for the currently accepted screen-share session:

1. Create a Cloudflare viewer session through the Edge Function.
2. Create a receive-capable Cloudflare `RTCPeerConnection`.
3. Request the host's track by publisher session ID + track name.
4. Apply Cloudflare's SDP offer/answer sequence, including `/renegotiate` when `requiresImmediateRenegotiation` is true.
5. Build a `MediaStream` from the received video track.
6. Replace only the media source passed to the existing board screen-share controller.

The Fabric object, its layout, selection behavior, transient flags, export exclusion, and collaboration geometry remain unchanged.

### Disable Cloud / return to P2P

When the host clears the checkbox:

1. Broadcast that Cloud mode is being disabled while keeping Cloudflare media temporarily alive.
2. Re-announce the normal host P2P session and allow viewers to recreate/re-negotiate their existing P2P peer connection using the current capture track.
3. Viewers switch their board media source back to the P2P stream as soon as it is available.
4. After the transition grace period, close Cloudflare viewer subscriptions and the host publisher session/track.
5. Set UI back to `Cloud ☐`.

Failure to restore P2P for one viewer does not stop the host capture. The host may immediately re-enable Cloud.

## Media quality

Cloud mode should preserve the existing capture and adaptive quality policy rather than create a second quality model:

- capture ideal: 1280x720;
- capture maximum: 1920x1080;
- capture frame rate ideal 10, maximum 15;
- idle profile: up to 2 FPS / 280 kbps;
- active profile: up to 10 FPS / 850 kbps;
- motion profile: up to 15 FPS / 1.25 Mbps;
- degraded-network profile retains the current reduced frame rate, bitrate multiplier and resolution downscale behavior where Cloudflare sender stats support the same observation.

`applySenderProfile` must apply to whichever host sender is currently carrying the screen track. During the brief transition where both P2P and Cloud are alive, both senders receive the same profile.

## State model

Extend screen-share view/session state with a transport state rather than overloading `sourceMode`:

- `transport: 'p2p' | 'cloud'`
- `cloudPhase: 'off' | 'connecting' | 'on' | 'disconnecting' | 'error'`
- Cloudflare publisher routing identifiers only while Cloud is active.

`sourceMode` remains `screen` because the capture source has not changed.

Session arbitration remains unchanged: there is still exactly one normal screen-share host per board. Cloud mode belongs to that existing screen-share session and cannot create a competing share.

## UI placement

The requested `Cloud` checkbox belongs visually to the screen-share object, not the global toolbar. Because the live image itself is a Fabric object, implement the host-only control as a small DOM overlay anchored to the object's upper-right screen-space corner. The overlay follows object move/resize/zoom/pan but is not serialized into Fabric.

Requirements:

- host only;
- label `Cloud` plus checkbox/status mark;
- compact and unobtrusive;
- clickable without selecting/moving the Fabric object;
- hidden immediately when screen share ends;
- no board persistence/history/export effects;
- accessible label and keyboard activation.

If the existing panel is visible for a transitional/error state, it may repeat Cloud status text, but the primary control remains on the board object as requested.

## Error handling

- Cloudflare backend unavailable: remain on P2P and show `Cloud error` to host.
- Cloudflare publisher negotiation fails: clean up partial Cloud resources and remain on P2P.
- One viewer fails Cloud subscription: other viewers remain on Cloud; host UI may show a degraded/partial viewer count but does not tear down the successful viewers.
- Viewer joins late while Cloud mode is active: repeated `host-start`/Cloud routing announcement lets the new viewer subscribe directly to Cloud.
- Viewer reconnects: stale Cloud viewer session is discarded and a fresh one is created.
- Host stops capture/browser ends track: both P2P and Cloud resources are cleaned up, then `host-stop` follows existing semantics.
- Stale Cloud signals from an older screen-share `sessionId` are ignored.

## Security invariants

- Cloudflare App Secret exists only in Supabase Edge Function secrets.
- The frontend never receives or stores the App Secret.
- The backend does not expose a generic Cloudflare proxy.
- Every backend operation verifies current board access using `boardId + boardKey` before touching Cloudflare.
- Cloud host lifecycle signals retain the existing `owner`/`edit` host authorization rules.
- Viewer routing identifiers are accepted only for the currently preferred screen-share session.
- No Cloudflare state becomes a durable board object or snapshot field.

## Expected code scope

Primary files:

- `src/components/ScreenShare.jsx` — Cloud lifecycle/state and media-source switching.
- `src/lib/screenShare.js` — Cloud signal normalization/state helpers.
- `src/lib/cloudflareScreenShare.js` — focused Cloudflare WebRTC client transport.
- `src/components/Board.jsx` and/or the existing board screen-share integration point — host-only overlay anchor/state plumbing.
- screen-share CSS file(s) — compact `Cloud` overlay styling.
- `supabase/functions/cloudflare-realtime/index.ts` if Edge Functions are versioned into the repository; otherwise deploy the same reviewed source to the connected Supabase project and retain a repository copy under an infrastructure/source directory.
- screen-share regression scripts under `scripts/`.

Avoid unrelated board, persistence, drawing, remote-browser, or realtime refactors.

## Tests

Add regression coverage for at least:

1. P2P remains default and existing screen share starts without Cloudflare calls.
2. Host-only `Cloud` control visibility.
3. Enabling Cloud reuses the existing capture track; `getDisplayMedia()` is not called again.
4. Cloud publisher negotiation uses the backend proxy and never references a frontend Cloudflare secret.
5. Viewer Cloud subscription yields a MediaStream that replaces the displayed media source.
6. Cloud enable failure preserves the current P2P stream.
7. Disabling Cloud restores P2P before Cloud teardown.
8. Stopping share always tears down Cloud publisher/viewer resources.
9. Stale Cloud signals from a previous session are ignored.
10. Late viewer can join an already-active Cloud share.
11. Existing board-native screen object layout/persistence/export tests continue to pass.
12. Existing remote-browser tests continue to pass unchanged.

Run the existing `npm run test:screen-share`, relevant board-screen-share scripts, the new Cloud tests, and `npm run build`. Any live Cloudflare end-to-end test requiring production App credentials must be reported separately from deterministic local tests.

## Deployment prerequisites

Before Cloud mode can work in production, the Cloudflare account must have a Realtime SFU Application with an App ID and App Secret. The Supabase project must then receive those two values as Edge Function secrets. These are deployment configuration, not frontend environment variables.

Until those secrets exist, the feature should fail closed: ordinary P2P screen share continues to work, while attempting `Cloud` reports that Cloud relay is not configured.

## Non-goals

- Replacing all screen sharing with Cloudflare by default.
- Sending screen video through Ably or Supabase Realtime.
- Adding audio capture.
- Changing remote-browser relay behavior.
- Persisting screen-share media or Cloudflare identifiers in board snapshots.
- Building a general video meeting/conferencing subsystem.
