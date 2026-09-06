# Cloudflare Screen Share Fallback Design

## Goal

Add a host-controlled `Cloud` transport switch to the existing normal screen-share object. Normal screen sharing continues to use the current direct WebRTC P2P path by default. When the host enables `Cloud`, the already-captured screen track is published through Cloudflare Realtime SFU and viewers switch to the Cloudflare-routed track without asking the host to choose the screen again. Disabling `Cloud` restores the existing P2P path and then tears down the Cloudflare media sessions.

This change applies only to normal `sourceMode: 'screen'`. The existing remote-browser path is out of scope.

## Confirmed UX

- Starting screen share behaves exactly as today: `getDisplayMedia()` runs once and P2P WebRTC is the initial transport.
- The live board-native screen object shows a compact host-only control in its upper-right corner: `Cloud ☐`.
- Viewers do not see or control the checkbox.
- Clicking `Cloud ☐` enters a short connecting state (`Cloud …`) while the existing P2P stream remains active.
- Cloud mode becomes active as soon as the host Cloudflare publisher is successfully connected and its routing identifiers are announced. Viewer acknowledgements are diagnostic only and never block activation.
- On success the control becomes `Cloud ☑`; the same captured `MediaStreamTrack` is routed through Cloudflare Realtime SFU.
- No second screen picker is shown and capture is not restarted.
- If Cloud setup fails, the checkbox returns to off, the P2P session remains untouched, and the host receives a small non-blocking error/status indication.
- Clicking `Cloud ☑` to disable Cloud first resumes/rebuilds the existing P2P viewer connections, then closes the Cloudflare media sessions. The host remains on the same capture track throughout.
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

Add `src/lib/cloudflareScreenShare.js`.

Responsibilities:

- create and close the host Cloudflare `RTCPeerConnection`;
- publish the existing screen `MediaStreamTrack` as a send-only local track;
- create and close a viewer Cloudflare `RTCPeerConnection`;
- subscribe to the host's published track using the host Cloudflare session/track identifiers;
- complete Cloudflare SDP negotiation through the backend proxy;
- expose connection state and a viewer `MediaStream` to `useAdaptiveScreenShare`;
- never contain the Cloudflare App Secret.

The module uses `stun:stun.cloudflare.com:3478` for Cloudflare peer connections, matching Cloudflare's official SFU examples. Existing Google STUN configuration remains unchanged for P2P.

### Backend credential boundary

Cloudflare Realtime App ID and App Secret must not be shipped in Vite/browser code. Add one Supabase Edge Function with slug `cloudflare-realtime` and keep a version-controlled source copy under `supabase/functions/cloudflare-realtime/index.ts`.

The function is a narrow board-authorized proxy for the Cloudflare Realtime SFU HTTPS API. It stores these environment secrets:

- `CLOUDFLARE_REALTIME_APP_ID`
- `CLOUDFLARE_REALTIME_APP_SECRET`

The function accepts the existing board credentials (`boardId`, `boardKey`) and verifies access using the same pattern as the deployed `ably-token` function:

1. validate input shapes;
2. SHA-256 the board key;
3. call `get_board_access_v4(p_id, p_key_hash)`, using the existing legacy `get_board_access` fallback only when the v4 RPC is absent;
4. reject closed or invalid board access;
5. enforce operation-specific permission;
6. perform only the requested Cloudflare session/track operation;
7. return `Cache-Control: no-store` and never return the Cloudflare secret.

Permission rules:

- `owner` or `edit`: may create/publish/renegotiate/close a host publisher session/track and may create/renegotiate a viewer subscription;
- `view`: may create/renegotiate a viewer subscription only;
- `closed` or missing access: denied.

The browser calls this Edge Function with the existing Supabase publishable client. The Edge Function keeps `verify_jwt: false` because board access is explicitly authenticated by possession of the board key, matching the deployed `ably-token` model. No service-role or Cloudflare secret is exposed to the browser.

### Narrow backend operations

The first version exposes a fixed operation enum rather than a generic proxy:

- `create-publisher-session`;
- `publish-track`;
- `create-viewer-session`;
- `subscribe-track`;
- `renegotiate-viewer`;
- `close-track`.

The server constructs every Cloudflare API path itself and validates session IDs, track names, SDP type/length, and operation permissions. The client cannot provide an arbitrary URL or HTTP method.

### Cloud transport signaling

The existing screen-share signaling channel continues to carry application state. Add these signal types:

- `cloud-track` — host publishes the Cloudflare publisher session ID and track name for the active screen-share session;
- `cloud-disable` — host announces return to P2P;
- `cloud-viewer-ready` — viewer reports successful Cloud subscription for host diagnostics only.

No separate `cloud-enable` signal is needed: the presence of a valid `cloud-track` for the currently accepted screen-share `sessionId` is the authoritative Cloud-on announcement.

The Cloudflare App Secret is never sent in signaling. Cloudflare session IDs and track names are routing identifiers shared only within the current board signaling context; backend access checks still gate Cloudflare API operations.

### Host enable flow

When the host clicks `Cloud`:

1. Keep all existing P2P peer connections alive.
2. Create a Cloudflare publisher session through the Edge Function.
3. Create a Cloudflare host `RTCPeerConnection` and attach the existing captured video track using a send-only transceiver.
4. Create/set the SDP offer locally and proxy the publish request to Cloudflare.
5. Apply Cloudflare's SDP answer to the host peer.
6. Obtain the published track identifier from the Cloudflare response.
7. Broadcast `cloud-track` for the active screen-share `sessionId`.
8. Set host UI to `Cloud ☑` immediately after successful publisher negotiation/announcement; viewer-ready acknowledgements update diagnostics only.
9. Viewers create Cloudflare subscriber sessions and switch their displayed media source when their Cloud track arrives.
10. Close each viewer's redundant P2P peer two seconds after that viewer reports/observes successful Cloud media, avoiding duplicate upstream longer than needed while keeping transition continuity.

If any host-side step before track publication fails, Cloud mode is aborted, partial Cloud resources are cleaned up, and P2P continues unchanged.

### Viewer Cloud flow

On `cloud-track` for the currently accepted screen-share session:

1. Create a Cloudflare viewer session through the Edge Function.
2. Create a receive-capable Cloudflare `RTCPeerConnection`.
3. Request the host's track by publisher session ID + track name.
4. Apply Cloudflare's SDP offer/answer sequence, including `/renegotiate` when `requiresImmediateRenegotiation` is true.
5. Build a `MediaStream` from the received video track.
6. Replace only the media source passed to the existing board screen-share controller.
7. Send `cloud-viewer-ready` to the host for status/cleanup accounting.

The Fabric object, its layout, selection behavior, transient flags, export exclusion, and collaboration geometry remain unchanged.

### Disable Cloud / return to P2P

When the host clears the checkbox:

1. Broadcast `cloud-disable` while keeping Cloudflare media temporarily alive.
2. Re-announce the normal host P2P session immediately instead of waiting for the periodic host announcement.
3. Viewers recreate/re-negotiate their normal P2P peer connection using the existing capture track.
4. Each viewer switches the board media source back to P2P as soon as a P2P video track arrives.
5. Keep Cloud media alive for up to three seconds as a transition grace period, then close Cloud viewer peer connections and the host published track/session resources.
6. Set UI back to `Cloud ☐` after teardown is requested; failure to restore P2P for one viewer does not re-enable Cloud automatically.

The host may immediately enable Cloud again if a viewer still cannot receive P2P.

## Media quality

Cloud mode reuses the existing capture and activity profiles rather than defining a second quality model:

- capture ideal: 1280x720;
- capture maximum: 1920x1080;
- capture frame rate ideal 10, maximum 15;
- idle profile: up to 2 FPS / 280 kbps;
- active profile: up to 10 FPS / 850 kbps;
- motion profile: up to 15 FPS / 1.25 Mbps;
- degraded host uplink profile: current reduced frame rate, bitrate multiplier and resolution downscale behavior.

`applySenderProfile` applies to the active Cloudflare publisher sender as well as P2P senders during transition. In Cloud mode, host-side stats measure the host-to-Cloudflare leg rather than every viewer's downstream leg; Cloudflare/WebRTC handles downstream congestion separately. The UI must not claim that host stats represent a specific viewer's Cloud downstream quality.

## State model

Extend screen-share view/session state with transport state rather than overloading `sourceMode`:

- `transport: 'p2p' | 'cloud'`;
- `cloudPhase: 'off' | 'connecting' | 'on' | 'disconnecting' | 'error'`;
- `cloudPublisherSessionId` and `cloudTrackName` only while Cloud is active.

`sourceMode` remains `screen` because the capture source has not changed.

Session arbitration remains unchanged: there is still exactly one normal screen-share host per board. Cloud mode belongs to that existing screen-share session and cannot create a competing share.

## UI placement

The requested `Cloud` checkbox belongs visually to the screen-share object, not the global toolbar. Implement the host-only control as a small DOM overlay anchored to the transient Fabric object's upper-right screen-space corner. The overlay follows object move/resize and viewport zoom/pan but is not serialized into Fabric.

Requirements:

- host only;
- label `Cloud` plus checkbox/status mark;
- compact and unobtrusive;
- `Cloud ☐`, `Cloud …`, `Cloud ☑`, and an error indication are visually distinguishable;
- clickable without selecting/moving the Fabric object;
- hidden immediately when screen share ends;
- no board persistence/history/export effects;
- accessible label and keyboard activation.

The existing floating screen-share panel may repeat Cloud status text during connection/error states, but the primary switch remains attached to the board object.

## Error handling

- Cloudflare backend unavailable or unconfigured: remain on P2P and show a host-only Cloud error.
- Cloudflare publisher negotiation fails: clean up partial Cloud resources and remain on P2P.
- One viewer fails Cloud subscription: successful viewers remain on Cloud; the failed viewer can continue on P2P until its Cloud attempt is retried or the host disables Cloud.
- Viewer joins late while Cloud mode is active: repeated `host-start` plus current `cloud-track` routing announcement lets the new viewer subscribe directly to Cloud.
- Viewer reconnects: stale Cloud viewer peer/session is discarded and a fresh viewer session is created.
- Host stops capture/browser ends track: both P2P and Cloud resources are cleaned up, then `host-stop` follows existing semantics.
- Stale Cloud signals from an older screen-share `sessionId` are ignored.
- A Cloud cleanup request failure is logged but does not resurrect or block local screen-share shutdown.

## Security invariants

- Cloudflare App Secret exists only in Supabase Edge Function secrets.
- The frontend never receives or stores the App Secret.
- The backend does not expose a generic Cloudflare proxy.
- Every backend operation verifies current board access using `boardId + boardKey` before touching Cloudflare.
- Publisher-mutating backend operations require `owner` or `edit` permission; `view` may subscribe only.
- Cloud host lifecycle signals retain the existing `owner`/`edit` host authorization rules.
- Viewer routing identifiers are accepted only for the currently preferred screen-share session.
- No Cloudflare state becomes a durable board object or snapshot field.

## Expected code scope

Primary files:

- `src/components/ScreenShare.jsx` — Cloud lifecycle/state, P2P/Cloud transition, and media-source switching.
- `src/lib/screenShare.js` — Cloud signal normalization/state helpers.
- `src/lib/cloudflareScreenShare.js` — focused Cloudflare WebRTC client transport.
- `src/components/Board.jsx` and the existing board screen-share integration point — host-only overlay anchor/state plumbing.
- existing board/screen-share CSS — compact `Cloud` overlay styling.
- `supabase/functions/cloudflare-realtime/index.ts` — version-controlled Edge Function source matching the deployed function.
- screen-share regression scripts under `scripts/`.

Avoid unrelated board, persistence, drawing, remote-browser, or general realtime refactors.

## Tests

Add regression coverage for at least:

1. P2P remains default and existing screen share starts without Cloudflare calls.
2. Host-only `Cloud` control visibility and non-host invisibility.
3. Enabling Cloud reuses the existing capture track; `getDisplayMedia()` is not called again.
4. Cloud publisher negotiation uses the backend proxy and no frontend Cloudflare secret exists.
5. `view` permission cannot invoke publisher-mutating backend operations.
6. Viewer Cloud subscription yields a `MediaStream` that replaces the displayed media source.
7. Cloud enable failure preserves the current P2P stream.
8. A viewer that has not established Cloud keeps its P2P peer during transition.
9. Disabling Cloud initiates P2P restoration before Cloud teardown.
10. Stopping share always tears down Cloud publisher/viewer resources.
11. Stale Cloud signals from a previous session are ignored.
12. Late viewer can join an already-active Cloud share.
13. Existing board-native screen object layout/persistence/export tests continue to pass.
14. Existing remote-browser tests continue to pass unchanged.

Run the existing `npm run test:screen-share`, relevant board-screen-share scripts, the new Cloud tests, and `npm run build`. A live Cloudflare end-to-end verification requiring production Realtime App credentials must be reported separately from deterministic local tests; no live success is claimed until credentials are configured and the live path is actually exercised.

## Deployment prerequisites

Before Cloud mode can work in production, the Cloudflare account must have a Realtime SFU Application with an App ID and App Secret. The connected Supabase project must then receive those two values as Edge Function secrets. These are deployment configuration, not frontend environment variables.

Until those secrets exist, the feature fails closed: ordinary P2P screen share continues to work, while attempting `Cloud` reports that Cloud relay is not configured.

## Non-goals

- Replacing all screen sharing with Cloudflare by default.
- Sending screen video through Ably or Supabase Realtime.
- Adding audio capture.
- Changing remote-browser relay behavior.
- Persisting screen-share media or Cloudflare identifiers in board snapshots.
- Building a general video meeting/conferencing subsystem.
