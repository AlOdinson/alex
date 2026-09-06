# Cloudflare Screen Share Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a host-controlled `Cloud` checkbox to normal board screen sharing so the existing captured screen can switch from direct P2P WebRTC to Cloudflare Realtime SFU and back without re-running the screen picker.

**Architecture:** Keep `getDisplayMedia()` and the board-native Fabric media object unchanged as the capture/render boundaries. Add a focused Cloudflare WebRTC client module and a narrow Supabase Edge Function that owns the Cloudflare App Secret and proxies only the SFU session/track operations needed by screen sharing. `useAdaptiveScreenShare` owns transport state and switches the displayed MediaStream while existing screen-share signaling carries only Cloud routing state.

**Tech Stack:** React 19, browser WebRTC, Fabric 7, Supabase JS/Edge Functions, Cloudflare Realtime SFU HTTPS API, existing Node regression scripts.

**Spec:** `docs/superpowers/specs/2026-09-06-cloudflare-screen-share-fallback-design.md`

## Global Constraints

- Normal screen sharing starts on existing P2P WebRTC and remains unchanged when `Cloud` is never enabled.
- `Cloud` applies only to `sourceMode: 'screen'`; remote-browser behavior is out of scope.
- Reuse the existing `MediaStreamTrack`; never call `getDisplayMedia()` a second time during transport switching.
- Preserve capture limits: ideal 1280x720, max 1920x1080, ideal 10 FPS, max 15 FPS.
- Preserve adaptive profiles: idle 2 FPS/280 kbps, active 10 FPS/850 kbps, motion 15 FPS/1.25 Mbps, including degraded-network reductions where sender stats permit.
- Cloudflare App Secret must exist only server-side and never be present in Vite/frontend environment variables or source.
- Existing board persistence, history, export, remote-browser, and screen-object geometry semantics must not change.
- If Cloud activation fails, P2P remains alive and usable.
- If Cloud is disabled, P2P must be restored before Cloud media is torn down.
- Cloudflare official API base is `https://rtc.live.cloudflare.com/v1`; relevant endpoints are `/apps/{appId}/sessions/new`, `/tracks/new`, `/renegotiate`, and `/tracks/close`.
- Cloudflare peer connections use `stun:stun.cloudflare.com:3478`; existing P2P Google STUN remains unchanged.

---

### Task 1: Extend the screen-share protocol with Cloud transport state

**Files:**
- Modify: `src/lib/screenShare.js`
- Create: `scripts/test-screen-share-cloud-protocol.mjs`

**Interfaces:**
- Produces: normalized signal types `cloud-track`, `cloud-disable`, `cloud-viewer-ready`.
- Produces: `normalizeCloudScreenShareRoute(route)` returning `{ publisherSessionId, trackName } | null`.
- Produces: `screenShareCloudTrackName(boardId, screenShareSessionId)` returning a deterministic validated track name.
- Existing `normalizeScreenShareSignal()` remains the single validator for signaling packets.

- [ ] **Step 1: Write the failing protocol regression test**

Create `scripts/test-screen-share-cloud-protocol.mjs` that imports `src/lib/screenShare.js` as text/module and asserts:

```js
assert.equal(
  screenShareCloudTrackName('boardABC', 'sessionXYZ'),
  'screen:boardABC:sessionXYZ',
);
assert.deepEqual(
  normalizeCloudScreenShareRoute({ publisherSessionId: 'pub_123456', trackName: 'screen:boardABC:sessionXYZ' }),
  { publisherSessionId: 'pub_123456', trackName: 'screen:boardABC:sessionXYZ' },
);
assert.equal(normalizeCloudScreenShareRoute({ publisherSessionId: '', trackName: 'x' }), null);
assert.equal(normalizeScreenShareSignal({ protocol: SCREEN_SHARE_PROTOCOL, type: 'cloud-track', sessionId: 'abc123', publisherSessionId: 'pub_123456', trackName: 'screen:boardABC:abc123' })?.type, 'cloud-track');
```

Also assert malformed/stale-looking payload shapes are rejected and existing `host-start`, `offer`, `answer`, `ice`, and remote-browser signals still normalize.

- [ ] **Step 2: Run the new test and verify it fails**

Run: `node scripts/test-screen-share-cloud-protocol.mjs`

Expected: FAIL because Cloud signal types/helpers do not exist yet.

- [ ] **Step 3: Add the minimal protocol helpers**

In `src/lib/screenShare.js`:

```js
export function screenShareCloudTrackName(boardId, sessionId) {
  const board = String(boardId ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 128);
  const session = String(sessionId ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 128);
  return board && session ? `screen:${board}:${session}` : '';
}

export function normalizeCloudScreenShareRoute(route) {
  const publisherSessionId = String(route?.publisherSessionId ?? '');
  const trackName = String(route?.trackName ?? '');
  if (!/^[A-Za-z0-9_-]{6,256}$/.test(publisherSessionId)) return null;
  if (!/^screen:[A-Za-z0-9_-]{6,128}:[A-Za-z0-9_-]{6,128}$/.test(trackName)) return null;
  return { publisherSessionId, trackName };
}
```

Extend valid signal types and make `normalizeScreenShareSignal()` retain only validated Cloud routing fields for the current packet.

- [ ] **Step 4: Run protocol and existing screen-share tests**

Run:

```bash
node scripts/test-screen-share-cloud-protocol.mjs
node scripts/test-screen-share.mjs
node scripts/test-screen-share-stun-retry.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/screenShare.js scripts/test-screen-share-cloud-protocol.mjs
git commit -m "test: define Cloud screen share signaling"
```

---

### Task 2: Add a narrow Supabase Edge Function proxy for Cloudflare Realtime

**Files:**
- Create: `supabase/functions/cloudflare-realtime/index.ts`
- Create: `scripts/test-cloudflare-realtime-edge-function.mjs`

**Interfaces:**
- Consumes request body fields: `boardId`, `boardKey`, `screenShareSessionId`, `operation`, plus operation-specific SDP/session fields.
- Operations: `create-session`, `publish-track`, `subscribe-track`, `renegotiate`, `close-track`.
- Returns Cloudflare JSON response unchanged only after successful validation; on failures returns `{ error }` with `Cache-Control: no-store`.
- Secrets: `CLOUDFLARE_REALTIME_APP_ID`, `CLOUDFLARE_REALTIME_APP_SECRET`.

- [ ] **Step 1: Write the failing source/security regression test**

Create `scripts/test-cloudflare-realtime-edge-function.mjs` that reads the Edge Function source and asserts:

```js
assert.match(source, /CLOUDFLARE_REALTIME_APP_ID/);
assert.match(source, /CLOUDFLARE_REALTIME_APP_SECRET/);
assert.match(source, /get_board_access_v4/);
assert.match(source, /https:\/\/rtc\.live\.cloudflare\.com\/v1/);
assert.match(source, /Authorization/);
assert.match(source, /Bearer/);
assert.doesNotMatch(source, /VITE_.*CLOUDFLARE/i);
assert.match(source, /create-session/);
assert.match(source, /publish-track/);
assert.match(source, /subscribe-track/);
assert.match(source, /renegotiate/);
assert.match(source, /close-track/);
```

Also assert the source has explicit permission checks that allow subscription for non-closed access but require `owner` or `edit` for publish/close operations.

- [ ] **Step 2: Run the test and verify it fails**

Run: `node scripts/test-cloudflare-realtime-edge-function.mjs`

Expected: FAIL because the function source does not exist.

- [ ] **Step 3: Implement board-authenticated operation routing**

Follow the deployed `ably-token` access pattern: validate `boardId`/`boardKey`, SHA-256 the key, call `get_board_access_v4`, fall back to `get_board_access` only for missing-function errors, reject closed boards, and derive the only allowed Cloud track name on the server:

```ts
const expectedTrackName = `screen:${boardId}:${screenShareSessionId}`;
```

Never accept an arbitrary Cloudflare URL or HTTP method from the browser. Map the enum to fixed endpoints:

```ts
const CF_BASE = `https://rtc.live.cloudflare.com/v1/apps/${encodeURIComponent(appId)}`;
```

Use:

```ts
headers: {
  Authorization: `Bearer ${appSecret}`,
  'Content-Type': 'application/json',
  Accept: 'application/json',
}
```

Require `owner|edit` for `create-session` when `role: 'publisher'`, `publish-track`, and publisher `close-track`; allow any non-closed board permission for viewer session creation, subscription, viewer renegotiation, and viewer close.

- [ ] **Step 4: Validate operation payloads narrowly**

For `publish-track`, construct Cloudflare payload server-side:

```ts
{
  sessionDescription: { type: 'offer', sdp },
  tracks: [{ location: 'local', mid, trackName: expectedTrackName }],
}
```

For `subscribe-track`:

```ts
{
  tracks: [{ location: 'remote', sessionId: publisherSessionId, trackName: expectedTrackName }],
}
```

For `renegotiate`:

```ts
{ sessionDescription: { type: 'answer', sdp } }
```

For `close-track`, accept only validated session ID + `mid` associated with the caller's current screen-share route and call Cloudflare `PUT .../tracks/close` using the documented request shape selected during implementation from the current OpenAPI schema. Reject oversized SDP bodies and identifiers that fail strict character/length validation.

- [ ] **Step 5: Run source/security test**

Run: `node scripts/test-cloudflare-realtime-edge-function.mjs`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/cloudflare-realtime/index.ts scripts/test-cloudflare-realtime-edge-function.mjs
git commit -m "feat: add Cloudflare Realtime edge proxy"
```

---

### Task 3: Build the isolated Cloudflare WebRTC transport module

**Files:**
- Create: `src/lib/cloudflareScreenShare.js`
- Create: `scripts/test-cloudflare-screen-share-transport.mjs`

**Interfaces:**
- Produces `createCloudflareScreenShareApi({ supabase, boardId, boardKey, screenShareSessionId })`.
- Produces `createCloudflarePublisher({ track, trackName, api, RTCPeerConnectionImpl })` → `{ sessionId, trackName, peer, sender, close }`.
- Produces `createCloudflareSubscriber({ publisherSessionId, trackName, api, RTCPeerConnectionImpl })` → `{ sessionId, peer, stream, close }`.
- Both use `{ iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }], bundlePolicy: 'max-bundle' }` and never call `getDisplayMedia()`.

- [ ] **Step 1: Write a failing transport unit test with fake peer connections**

The fake publisher peer must record `addTransceiver(track, { direction: 'sendonly' })`, offer creation, local/remote descriptions, and close. The fake subscriber peer must expose `ontrack` and record remote offer + local answer. Mock API methods should record exact order:

```js
publisher: createSession -> publishTrack
subscriber: createSession -> subscribeTrack -> renegotiate (when required)
```

Assert the publisher receives the exact existing track object by identity (`===`). Assert no module text contains `getDisplayMedia` or a Cloudflare secret/env key.

- [ ] **Step 2: Run the test and verify it fails**

Run: `node scripts/test-cloudflare-screen-share-transport.mjs`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the Supabase-backed API wrapper**

Use `supabase.functions.invoke('cloudflare-realtime', { body })` with the fixed operation enum. Throw a normalized `Error` when `error` exists or returned data has `{ error }`. Never retry media mutations blindly.

- [ ] **Step 4: Implement publisher negotiation**

Create one send-only transceiver with the existing track, create/set local offer, wait for ICE gathering completion before sending SDP because the Cloudflare HTTPS API does not use a trickle-ICE signaling endpoint, create publisher session, call `publish-track`, and set Cloudflare's answer as remote description. Return the RTCRtpSender so existing adaptive bitrate code can target it.

- [ ] **Step 5: Implement subscriber negotiation**

Create viewer session, request the remote publisher track, apply Cloudflare's returned offer, create/set local answer, call `renegotiate` when `requiresImmediateRenegotiation` is true, and resolve a `MediaStream` from `ontrack`. Add bounded timeouts for track arrival and peer connection establishment; close partial resources on failure.

- [ ] **Step 6: Run transport tests**

Run: `node scripts/test-cloudflare-screen-share-transport.mjs`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/cloudflareScreenShare.js scripts/test-cloudflare-screen-share-transport.mjs
git commit -m "feat: add Cloudflare screen share transport"
```

---

### Task 4: Integrate manual Cloud transport switching into `useAdaptiveScreenShare`

**Files:**
- Modify: `src/components/ScreenShare.jsx`
- Modify: `src/lib/screenShare.js`
- Create: `scripts/test-screen-share-cloud-switch.mjs`

**Interfaces:**
- Extend `view` with `transport: 'p2p' | 'cloud'`, `cloudPhase: 'off' | 'connecting' | 'on' | 'disconnecting' | 'error'`, `cloudError: ''`.
- Expose from `useAdaptiveScreenShare`: `setCloudEnabled(enabled: boolean)` and the Cloud state above.
- Keep `stream` as the currently displayed stream for both host and viewer; keep `localStreamRef` as the one capture source.

- [ ] **Step 1: Write failing lifecycle regression assertions**

Create `scripts/test-screen-share-cloud-switch.mjs` to verify source/lifecycle invariants by importing helpers where practical and by targeted source assertions where browser hooks cannot run in Node:

```js
assert.match(source, /setCloudEnabled/);
assert.match(source, /cloudPhase/);
assert.match(source, /createCloudflarePublisher/);
assert.match(source, /createCloudflareSubscriber/);
assert.equal((source.match(/getDisplayMedia\(/g) ?? []).length, 1);
```

Also assert `stopHosting`/viewer cleanup calls Cloud cleanup and that the original P2P peer creation code remains present.

- [ ] **Step 2: Run the new test and verify it fails**

Run: `node scripts/test-screen-share-cloud-switch.mjs`

Expected: FAIL.

- [ ] **Step 3: Add Cloud refs/state without changing default P2P start**

Add refs for one host publisher and one viewer subscriber. Initialize every normal screen share to:

```js
transport: 'p2p',
cloudPhase: 'off',
cloudError: '',
```

Do not invoke Cloudflare from `start()`.

- [ ] **Step 4: Implement `setCloudEnabled(true)`**

Host-only, normal-screen-only flow:

1. Set `cloudPhase: 'connecting'` while retaining all existing P2P peers.
2. Build `trackName = screenShareCloudTrackName(boardId, session.sessionId)`.
3. Call `createCloudflarePublisher()` with `localStreamRef.current.getVideoTracks()[0]`.
4. Apply the current adaptive sender profile to the returned Cloud sender.
5. Broadcast `cloud-track` containing only `publisherSessionId` and `trackName`.
6. Set `transport: 'cloud'`, `cloudPhase: 'on'` after publisher negotiation succeeds.
7. On failure, close partial Cloud resources, leave all P2P peers intact, set `cloudPhase: 'error'`, and preserve the current displayed stream.

- [ ] **Step 5: Implement viewer handling for `cloud-track`**

Only accept the route for the current preferred screen-share session. Create/replace the viewer Cloud subscriber, then call `setStream(cloudStream)` only after a video track arrives. Send `cloud-viewer-ready` for status. A viewer that fails Cloud subscription keeps its existing P2P stream and must not disturb other viewers.

- [ ] **Step 6: Implement `setCloudEnabled(false)` with P2P-first handback**

Host flow:

1. Set `cloudPhase: 'disconnecting'`.
2. Broadcast `cloud-disable`.
3. Re-run normal `announceHost()` so viewers recreate P2P offers using the existing capture track.
4. Keep Cloud publisher alive during a bounded grace period.
5. Close Cloud publisher after grace period and set `transport: 'p2p'`, `cloudPhase: 'off'`.

Viewer flow: on `cloud-disable`, keep Cloud stream until a P2P `ontrack` stream arrives; switch to P2P, then close Cloud subscriber. If P2P never arrives within the grace timeout, show the existing connecting/no-picture state but do not stop the host share.

- [ ] **Step 7: Apply adaptive profile to both active transports during overlap**

Update `applyCurrentProfile()` so it still iterates `hostPeersRef` and also calls `applySenderProfile(cloudPublisherRef.current?.sender, profile, degraded)` when present.

- [ ] **Step 8: Add teardown and stale-signal guards**

Ensure screen stop, browser-ended capture, session arbitration, page unmount, and viewer leave all close Cloud peers. Ignore Cloud signals whose `sessionId` is not `activeSessionRef.current?.sessionId`.

- [ ] **Step 9: Run lifecycle regressions**

Run:

```bash
node scripts/test-screen-share-cloud-switch.mjs
node scripts/test-screen-share-cloud-protocol.mjs
node scripts/test-cloudflare-screen-share-transport.mjs
node scripts/test-screen-share.mjs
node scripts/test-screen-share-stun-retry.mjs
node scripts/test-screenshare-full-frame-release.mjs
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/components/ScreenShare.jsx src/lib/screenShare.js scripts/test-screen-share-cloud-switch.mjs
git commit -m "feat: switch screen share through Cloudflare"
```

---

### Task 5: Put the host-only `Cloud` checkbox on the board screen object

**Files:**
- Modify: `src/components/Board.jsx`
- Modify: `src/styles.css`
- Create: `scripts/test-board-screen-share-cloud-control.mjs`

**Interfaces:**
- Consume `screenShare.view.cloudPhase`, `screenShare.view.transport`, `screenShare.setCloudEnabled` from the hook result already owned by `Board.jsx`.
- Render one DOM overlay for the active normal screen-share host only.
- Anchor overlay to the transient Fabric screen-share object's upper-right screen-space corner.

- [ ] **Step 1: Write failing UI/source regression test**

Create `scripts/test-board-screen-share-cloud-control.mjs` and assert:

```js
assert.match(boardSource, /Cloud/);
assert.match(boardSource, /setCloudEnabled/);
assert.match(cssSource, /screen-share-cloud-control/);
assert.match(boardSource, /cloudPhase/);
```

Also assert the overlay condition requires the local client to be the active host and `sourceMode === 'screen'`, and that the control is not serialized through the Fabric object.

- [ ] **Step 2: Run it and verify it fails**

Run: `node scripts/test-board-screen-share-cloud-control.mjs`

Expected: FAIL.

- [ ] **Step 3: Track the Fabric object's viewport position**

At the existing board-screen-share integration point that owns the transient media controller, derive the object upper-right point with Fabric's viewport transform (e.g. object corner coordinate transformed by `canvas.viewportTransform`). Refresh overlay position on object move/scale, viewport pan/zoom, resize, and render lifecycle. Store only ephemeral React state `{ left, top }`.

- [ ] **Step 4: Render the requested host-only control**

Render a compact label/button above the board canvas:

```jsx
<label className={`screen-share-cloud-control is-${cloudPhase}`} style={{ left, top }}>
  <span>Cloud</span>
  <input
    type="checkbox"
    checked={transport === 'cloud' || cloudPhase === 'connecting'}
    disabled={cloudPhase === 'connecting' || cloudPhase === 'disconnecting'}
    onChange={(event) => screenShare.setCloudEnabled(event.target.checked)}
    aria-label="Передавать демонстрацию через Cloudflare"
  />
</label>
```

Use `pointerdown`/click propagation guards so interacting with the checkbox does not select or move the Fabric object. During `connecting`, show `Cloud …`; during error, briefly expose a compact error state while leaving the checkbox unchecked.

- [ ] **Step 5: Style the overlay**

Add `.screen-share-cloud-control` in `src/styles.css` with compact typography, high enough z-index to sit over the canvas, pointer events enabled only on the control, and no dependency on board serialization. Keep it readable in both light/dark surfaces already used by the board.

- [ ] **Step 6: Run UI and board-object regression tests**

Run:

```bash
node scripts/test-board-screen-share-cloud-control.mjs
node scripts/test-board-screen-share-integration.mjs
node scripts/test-board-screen-share-object.mjs
node scripts/test-board-screen-share-resize-fit.mjs
node scripts/test-desktop-sharescreen-button.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/Board.jsx src/styles.css scripts/test-board-screen-share-cloud-control.mjs
git commit -m "feat: add Cloud screen share checkbox"
```

---

### Task 6: Wire production-safe backend deployment and fail-closed behavior

**Files:**
- Modify if needed: `supabase/functions/cloudflare-realtime/index.ts`
- Create: `docs/CLOUDFLARE-REALTIME-SETUP.md`
- Modify: `scripts/test-cloudflare-realtime-edge-function.mjs`

**Interfaces:**
- Production requires `CLOUDFLARE_REALTIME_APP_ID` and `CLOUDFLARE_REALTIME_APP_SECRET` as Supabase Edge Function secrets.
- Missing secrets return a deterministic configuration error; P2P remains functional.

- [ ] **Step 1: Extend the backend test for missing-secret fail-closed behavior**

Assert the function explicitly checks both secret names before any Cloudflare fetch and returns a configuration error without leaking the missing secret name/value to the browser response.

- [ ] **Step 2: Write deployment documentation**

Create `docs/CLOUDFLARE-REALTIME-SETUP.md` with exact operator steps:

1. Create one Cloudflare Realtime SFU Application in Cloudflare Dashboard.
2. Copy App ID and App Secret.
3. Store them as Supabase Edge Function secrets named exactly `CLOUDFLARE_REALTIME_APP_ID` and `CLOUDFLARE_REALTIME_APP_SECRET`.
4. Deploy `cloudflare-realtime` from `supabase/functions/cloudflare-realtime/index.ts` with the project’s board-key authorization model.
5. Smoke-test P2P with `Cloud ☐`, then Cloud mode with `Cloud ☑`, then return to P2P by clearing it.
6. Never put App Secret in Cloudflare Pages/Vite public variables.

- [ ] **Step 3: Deploy the reviewed Edge Function source to the connected Supabase project**

Project: `nsdmvyggcarwznvvzpet`.

Deploy the exact committed `index.ts`. Use custom board-key authentication (`verify_jwt: false`) only because the function itself validates `boardId + boardKey` on every operation, matching the existing `ably-token` pattern.

Expected before secrets are configured: invocation fails closed with configuration error; no impact to normal P2P screen sharing.

- [ ] **Step 4: Run backend regression test again**

Run: `node scripts/test-cloudflare-realtime-edge-function.mjs`

Expected: PASS.

- [ ] **Step 5: Commit documentation/final backend adjustments**

```bash
git add supabase/functions/cloudflare-realtime/index.ts docs/CLOUDFLARE-REALTIME-SETUP.md scripts/test-cloudflare-realtime-edge-function.mjs
git commit -m "docs: document Cloudflare screen relay setup"
```

---

### Task 7: Full regression, build, diff review, and live-test boundary

**Files:**
- Modify only if a verified regression requires a scoped fix.
- Review all files changed on `feature/cloudflare-screen-share-fallback` against `main`.

**Interfaces:**
- Produces a reviewable feature branch that leaves `main` untouched.

- [ ] **Step 1: Run all new Cloud tests**

```bash
node scripts/test-screen-share-cloud-protocol.mjs
node scripts/test-cloudflare-realtime-edge-function.mjs
node scripts/test-cloudflare-screen-share-transport.mjs
node scripts/test-screen-share-cloud-switch.mjs
node scripts/test-board-screen-share-cloud-control.mjs
```

Expected: PASS.

- [ ] **Step 2: Run existing screen-share/board regressions**

```bash
npm run test:screen-share
node scripts/test-screen-share-stun-retry.mjs
node scripts/test-screen-share-board-session.mjs
node scripts/test-screen-share-board-ui.mjs
node scripts/test-board-screen-share-integration.mjs
node scripts/test-board-screen-share-object.mjs
node scripts/test-board-screen-share-resize-fit.mjs
node scripts/test-screenshare-full-frame-release.mjs
node scripts/test-desktop-sharescreen-button.mjs
```

Expected: PASS for every test available in the repository.

- [ ] **Step 3: Run production build**

Run: `npm run build`

Expected: Vite build exits 0 with no unresolved imports or browser-global leakage into build-time execution.

- [ ] **Step 4: Review branch diff**

Compare `main...feature/cloudflare-screen-share-fallback`. Verify no unrelated drawing, persistence, remote-browser, EV/game code, or board data schema changed. Verify no Cloudflare App Secret or credential value appears anywhere in tracked frontend files.

- [ ] **Step 5: Perform live browser smoke test only when Cloudflare App credentials are configured**

Manual browser matrix:

```text
Host Chrome/Safari desktop: start share -> P2P picture
Host clicks Cloud: no new screen picker -> viewer picture continues through Cloud
Late viewer joins Cloud-active share -> receives picture
Host clears Cloud: viewer returns to P2P
Host stops share: transient object and Cloud resources disappear
Cloud backend unavailable: Cloud fails, P2P remains visible
```

Do not report this live test as passed unless it is actually executed against configured Cloudflare credentials.

- [ ] **Step 6: Commit any scoped verification-only fixes, then prepare PR/diff**

```bash
git status --short
git diff --check main...HEAD
```

Create a PR from `feature/cloudflare-screen-share-fallback` to `main` only after deterministic tests/build pass. Leave merge to an explicit subsequent decision.
