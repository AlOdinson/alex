# Cloudflare Screen Share Fallback Design

## Goal

Add a host-controlled `Cloud` transport switch to the existing normal screen-share object. Normal screen sharing continues to use the current direct WebRTC P2P path by default. When the host enables `Cloud`, the already-captured screen track is published through Cloudflare Realtime SFU and viewers switch their displayed media to the Cloudflare-routed track without asking the host to choose the screen again. Disabling `Cloud` switches viewers back to the still-live P2P path and tears down Cloudflare media resources.

This applies only to normal `sourceMode: 'screen'`. The existing remote-browser path is out of scope.

## Confirmed UX

- Starting screen share behaves exactly as today: `getDisplayMedia()` runs once and P2P WebRTC is the initial transport.
- The live board-native screen object shows a compact host-only control in its upper-right corner: `Cloud ☐`.
- Viewers do not see or control the switch.
- Clicking `Cloud ☐` shows `Cloud …` while the existing P2P stream remains active.
- Cloud mode becomes active as soon as the host Cloudflare publisher is connected and its routing identifiers are announced; viewer acknowledgements are diagnostic only.
- On success the control becomes `Cloud ☑`; the exact existing capture `MediaStreamTrack` is also routed through Cloudflare Realtime SFU.
- No second screen picker is shown and capture is not restarted.
- If Cloud setup fails, the control shows an error state and P2P remains untouched.
- While Cloud is enabled, the P2P peer connections remain warm in the background. This intentionally uses some duplicate upstream bandwidth in exchange for an immediate and reliable return path.
- Clicking `Cloud ☑` to disable Cloud broadcasts `cloud-disable`; viewers immediately prefer their already-live P2P stream and Cloudflare peers are then closed.
- If a viewer's P2P connection independently failed while Cloud was active, removing the Cloud check may remove that viewer's picture again; this is expected and does not stop host capture.
- Stopping screen share closes both P2P and Cloudflare resources.

## Existing P2P baseline

The existing capture/render boundaries remain authoritative:

1. `navigator.mediaDevices.getDisplayMedia()` captures one video track.
2. The host creates the existing P2P `RTCPeerConnection` per viewer.
3. A viewer receives a `MediaStream` through WebRTC.
4. `src/lib/boardScreenShare.js` renders the selected stream into the transient Fabric screen-share object.

Cloud mode adds another transport but does not duplicate capture and does not change persistence, history, export, geometry, or session arbitration.

## Cloudflare transport

`src/lib/cloudflareScreenShare.js` owns the Cloudflare WebRTC transport. It creates host/viewer Cloudflare peer connections, publishes the existing capture track as send-only, subscribes viewers to the host track, completes SDP negotiation through the backend proxy, exposes the viewer `MediaStream`, and never contains the Cloudflare App Secret.

Cloudflare peers use `stun:stun.cloudflare.com:3478`. Existing P2P peers keep their existing Google STUN configuration.

## Backend credential boundary

Cloudflare Realtime App ID and App Secret must never be shipped in Vite/browser code. The Supabase Edge Function `cloudflare-realtime`, version-controlled at `supabase/functions/cloudflare-realtime/index.ts`, is the only component that reads:

- `CLOUDFLARE_REALTIME_APP_ID`
- `CLOUDFLARE_REALTIME_APP_SECRET`

The function validates `boardId`, `boardKey`, and `screenShareSessionId`; SHA-256 hashes the board key; calls `get_board_access_v4` with the existing `get_board_access` compatibility fallback; rejects closed/invalid board access; enforces operation-specific permissions; verifies signed Cloud session leases; builds only fixed Cloudflare API requests; and returns `Cache-Control: no-store` without exposing the secret.

Permission rules:

- `owner` or `edit`: may create/publish/close a host publisher session and may also create a viewer subscription.
- `view`: may create, subscribe, renegotiate, and close only its own leased viewer session.
- `closed` or missing access: denied.

The function uses explicit board-key authorization and is deployed with `verify_jwt: false`, matching the existing publishable-key Edge Function model used by the project.

## Server-issued session leases

A Cloudflare `sessionId` is not sufficient authorization. Every created publisher/viewer session receives an opaque `sessionLease` signed server-side with HMAC-SHA-256. The signed payload binds board ID, screen-share session ID, Cloudflare session ID, role (`publisher` or `viewer`), and expiry (maximum two hours).

Every post-creation mutation verifies the lease signature, expiry, board/session binding, Cloudflare session ID, and role. The publisher lease is never broadcast to viewers. A viewer receives only the publisher session ID and expected track name needed to request that remote source into the viewer's own leased session.

## Fixed backend operations

The browser can request only this enum:

- `create-publisher-session`;
- `publish-track`;
- `create-viewer-session`;
- `subscribe-track`;
- `renegotiate-viewer`;
- `close-track`.

The server constructs paths under `https://rtc.live.cloudflare.com/v1/apps/{appId}` itself. It does not accept arbitrary URLs or HTTP methods. Teardown uses Cloudflare `PUT /tracks/close` with `{ tracks: [{ mid }], force: true }`, then closes the local peer.

## Cloud signaling

A dedicated Supabase Realtime broadcast channel carries only application routing state, never media or secrets. Supported Cloud signals are:

- `cloud-track` — host announces publisher session ID + expected track name for the active screen-share session;
- `cloud-disable` — host announces return to P2P;
- `cloud-viewer-ready` — viewer reports a successful Cloud subscription for diagnostics.

The host repeats the current `cloud-track` announcement periodically so a late/reconnecting viewer can subscribe. Stale signals whose `sessionId` does not match the currently accepted screen-share session are ignored.

## Host enable flow

When the host clicks `Cloud`:

1. Keep all P2P peer connections alive.
2. Create a leased Cloudflare publisher session through the Edge Function.
3. Create the Cloudflare host `RTCPeerConnection` and attach the exact existing capture video track with a send-only transceiver.
4. Create/set the local offer, wait for ICE gathering, and send the gathered SDP to the backend `publish-track` operation.
5. Apply Cloudflare's SDP answer.
6. Broadcast `cloud-track` with publisher session ID + track name only.
7. Set host UI to `Cloud ☑` after publisher negotiation succeeds.
8. Viewers create their leased Cloudflare subscriber sessions and switch displayed media only after the Cloud video track arrives.
9. `cloud-viewer-ready` updates diagnostics only.
10. Keep P2P peers warm for the entire Cloud interval; do not close them on viewer readiness.

If any host-side Cloud setup step fails, clean up partial Cloud resources and leave P2P unchanged.

## Viewer Cloud flow

On a valid `cloud-track` for the current session:

1. Create a leased Cloudflare viewer session.
2. Create a receive-capable Cloudflare peer.
3. Request the expected host track by publisher session ID + track name.
4. Apply Cloudflare's offer/answer sequence and `/renegotiate` when required.
5. Build a `MediaStream` from the received video track.
6. Replace only the displayed media source; keep the existing P2P peer alive in the background.
7. Send `cloud-viewer-ready` for diagnostics.

If Cloud subscription fails, the viewer continues to display/use P2P when available. The Fabric object and all of its collaboration/persistence rules remain unchanged.

## Disable Cloud / return to P2P

When the host clears the switch:

1. Set Cloud state to disconnecting and broadcast `cloud-disable` while Cloud media is still alive.
2. Viewers immediately select their already-live P2P stream; no new screen capture and normally no new P2P negotiation is required.
3. After a short handback grace period, close viewer Cloud subscriptions and the host Cloud publisher through their own signed leases.
4. Return the host UI to `Cloud ☐`.
5. If an individual P2P peer died independently during Cloud mode, that viewer may have no picture after Cloud is disabled; the host may re-enable Cloud without restarting capture.

## Media quality

Cloud reuses the existing capture/activity policy rather than defining a second quality model:

- capture ideal: 1280x720;
- capture maximum: 1920x1080;
- capture frame rate ideal 10, maximum 15;
- idle: up to 2 FPS / 280 kbps;
- active: up to 10 FPS / 850 kbps;
- motion: up to 15 FPS / 1.25 Mbps;
- degraded host uplink: existing reduced frame rate, bitrate multiplier, and resolution downscale behavior.

The current profile is applied to both the Cloud publisher sender and the warm P2P senders while Cloud is active. Host Cloud stats describe the host-to-Cloudflare leg, not an individual viewer's downstream quality.

## State model

Cloud state is separate from capture source:

- `transport: 'p2p' | 'cloud'`;
- `cloudPhase: 'off' | 'connecting' | 'on' | 'disconnecting' | 'error'`;
- `cloudError` for host-visible failure state.

`sourceMode` remains `screen`. There is still exactly one normal screen-share session per board.

## UI placement

The primary switch is a real accessible DOM button overlaid on the transient Fabric screen-share object. It is anchored to the object's upper-right screen-space corner and repositions on Fabric render/viewport changes. It is not a Fabric object and therefore cannot be serialized, copied, exported, persisted, or entered into undo/redo.

Requirements:

- host only;
- `Cloud ☐`, `Cloud …`, `Cloud ☑`, `Cloud ⚠` states;
- compact and unobtrusive;
- pointer interaction does not select/move the Fabric object;
- follows object movement/resizing and board zoom/pan;
- hidden and removed immediately when the screen-share controller is disposed;
- keyboard-accessible button semantics.

A state-request/replay event handles React/Fabric effect ordering so an overlay created after the first Cloud state publication still receives the current state.

## Error handling

- Backend unavailable/unconfigured: remain on P2P and show Cloud error.
- Publisher negotiation failure: clean partial Cloud state and remain on P2P.
- One viewer subscription failure: successful viewers stay on Cloud and failed viewer keeps P2P when available.
- Late/reconnecting viewer: periodic `cloud-track` announcement allows a fresh subscription.
- Host stop/browser-ended capture/session arbitration: appropriate Cloud and P2P resources are cleaned up.
- Invalid, expired, or mismatched session lease: backend rejects the mutation.
- Stale Cloud signal from an older screen-share session: ignored.
- Cleanup request failure is logged but does not block local shutdown.

## Security invariants

- App Secret exists only in Supabase Edge Function secrets.
- Frontend never receives/stores App Secret or publisher lease.
- Backend is not a generic Cloudflare proxy.
- Every backend operation verifies current board access.
- Every post-creation Cloudflare session mutation requires a valid signed lease bound to board, screen-share session, Cloudflare session, role, and expiry.
- Publisher mutations additionally require `owner` or `edit` permission.
- Viewer routing identifiers are accepted only for the current preferred screen-share session.
- No Cloudflare state becomes durable board state.

## Code scope

Primary implementation files:

- `src/components/ScreenShare.jsx` — composes the existing P2P hook with Cloud fallback state.
- `src/components/useCloudScreenShareFallback.js` — Cloud lifecycle, signaling, stream selection, and manual toggle handling.
- `src/lib/screenShare.js` — Cloud signal validation/route helpers.
- `src/lib/cloudflareScreenShare.js` — focused Cloudflare WebRTC transport.
- `src/lib/boardScreenShare.js` — host-only ephemeral `Cloud` overlay anchored to the Fabric object.
- `supabase/functions/cloudflare-realtime/index.ts` — narrow backend proxy/lease authority.
- regression scripts under `scripts/`.

Avoid unrelated drawing, persistence, board schema, remote-browser, game, or general realtime refactors.

## Verification requirements

Deterministic coverage includes:

1. P2P remains default and no Cloud call happens until manually enabled.
2. Host-only Cloud control and non-host invisibility.
3. Enabling Cloud reuses the exact capture track; no second `getDisplayMedia()`.
4. App Secret never appears in frontend code.
5. View permission cannot mutate publisher sessions.
6. Signed lease requirements protect session mutation.
7. Viewer Cloud MediaStream replaces only the displayed stream.
8. Cloud failure preserves P2P.
9. P2P remains warm while Cloud is active.
10. Disabling Cloud returns display to P2P before Cloud teardown.
11. Stop/session replacement cleans Cloud resources.
12. Stale Cloud signals are rejected.
13. Late viewers can subscribe from repeated announcements.
14. Existing board-screen-share persistence/export/layout tests remain green.
15. Existing P2P and remote-browser screen-share tests remain green.
16. Edge Function passes Deno type-check and frontend passes production Vite build.

Live Cloudflare E2E is a separate deployment check and must not be claimed until real Realtime App credentials are configured and the host/viewer flow is exercised.

## Deployment prerequisites

Production Cloud mode requires one Cloudflare Realtime SFU Application and its App ID/App Secret stored only as Supabase Edge Function secrets. The Edge Function may be deployed before secrets exist; in that state it fails closed for Cloud requests while ordinary P2P remains usable.

## Non-goals

- Replacing P2P with Cloudflare by default.
- Sending screen video through Ably or Supabase Realtime.
- Adding audio capture.
- Changing remote-browser relay behavior.
- Persisting screen-share media/Cloud identifiers in board snapshots.
- Building a general video-meeting subsystem.
