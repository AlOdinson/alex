# Cloudflare Screen Share Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a host-controlled `Cloud` checkbox to normal board screen sharing so the existing captured screen can switch from direct P2P WebRTC to Cloudflare Realtime SFU and back without re-running the screen picker.

**Architecture:** Keep `getDisplayMedia()` and the board-native Fabric media object unchanged as capture/render boundaries. Add a focused Cloudflare WebRTC client module and a narrow Supabase Edge Function that owns the Cloudflare App Secret, verifies board access, and binds each Cloudflare session to a signed short-lived lease. `useAdaptiveScreenShare` owns transport state and switches the displayed MediaStream while existing screen-share signaling carries only Cloud routing state.

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
- If Cloud is disabled, P2P restoration begins before Cloud media is torn down.
- Cloudflare API base is `https://rtc.live.cloudflare.com/v1`; required endpoints are `/apps/{appId}/sessions/new`, `/tracks/new`, `/renegotiate`, and `/tracks/close`.
- Cloudflare peer connections use `stun:stun.cloudflare.com:3478`; existing P2P Google STUN remains unchanged.
- Every Cloudflare session mutation after creation requires a valid signed session lease bound to board ID, screen-share session ID, Cloudflare session ID, role, and expiry.

---

### Task 1: Extend the screen-share protocol with Cloud transport state

**Files:**
- Modify: `src/lib/screenShare.js`
- Create: `scripts/test-screen-share-cloud-protocol.mjs`

**Interfaces:**
- Produces signal types: `cloud-track`, `cloud-disable`, `cloud-viewer-ready`.
- Produces `normalizeCloudScreenShareRoute(route)` → `{ publisherSessionId, trackName } | null`.
- Produces `screenShareCloudTrackName(boardId, screenShareSessionId)` → deterministic `screen:<boardId>:<sessionId>`.
- Existing `normalizeScreenShareSignal()` remains the single signal validator.

- [ ] **Step 1: Write the failing protocol regression test**

Create `scripts/test-screen-share-cloud-protocol.mjs` and assert:

```js
assert.equal(
  screenShareCloudTrackName('boardABC', 'sessionXYZ'),
  'screen:boardABC:sessionXYZ',
);
assert.deepEqual(
  normalizeCloudScreenShareRoute({
    publisherSessionId: 'pub_123456',
    trackName: 'screen:boardABC:sessionXYZ',
  }),
  { publisherSessionId: 'pub_123456', trackName: 'screen:boardABC:sessionXYZ' },
);
assert.equal(normalizeCloudScreenShareRoute({ publisherSessionId: '', trackName: 'x' }), null);
assert.equal(normalizeScreenShareSignal({
  protocol: SCREEN_SHARE_PROTOCOL,
  type: 'cloud-track',
  sessionId: 'sessionXYZ',
  publisherSessionId: 'pub_123456',
  trackName: 'screen:boardABC:sessionXYZ',
})?.type, 'cloud-track');
```

Also assert malformed Cloud payloads are rejected and existing host/P2P/remote-browser signals still normalize.

- [ ] **Step 2: Run the new test and verify it fails**

Run: `node scripts/test-screen-share-cloud-protocol.mjs`

Expected: FAIL because Cloud signal helpers do not exist.

- [ ] **Step 3: Implement the minimal helpers**

In `src/lib/screenShare.js` add:

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

Extend the valid type set and normalize only validated Cloud fields.

- [ ] **Step 4: Run protocol + existing tests**

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

### Task 2: Add the board-authorized Cloudflare Edge Function with signed session leases

**Files:**
- Create: `supabase/functions/cloudflare-realtime/index.ts`
- Create: `scripts/test-cloudflare-realtime-edge-function.mjs`

**Interfaces:**
- Request base: `{ boardId, boardKey, screenShareSessionId, operation }`.
- Operations: `create-publisher-session`, `publish-track`, `create-viewer-session`, `subscribe-track`, `renegotiate-viewer`, `close-track`.
- Session creation returns `{ sessionId, sessionLease }` plus Cloudflare response fields needed by the caller.
- Every later operation consumes `sessionId` + `sessionLease`.
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
assert.match(source, /HMAC/);
assert.match(source, /sessionLease/);
assert.doesNotMatch(source, /VITE_.*CLOUDFLARE/i);
for (const op of [
  'create-publisher-session',
  'publish-track',
  'create-viewer-session',
  'subscribe-track',
  'renegotiate-viewer',
  'close-track',
]) assert.match(source, new RegExp(op));
```

Also assert `view` cannot publish/close a publisher and that all post-creation mutation branches call lease verification before Cloudflare `fetch()`.

- [ ] **Step 2: Run the test and verify it fails**

Run: `node scripts/test-cloudflare-realtime-edge-function.mjs`

Expected: FAIL because the function source does not exist.

- [ ] **Step 3: Implement board access validation**

Follow the deployed `ably-token` pattern exactly for board credential shape, SHA-256 hashing, `get_board_access_v4` lookup, missing-function fallback, and closed-board rejection. Derive the only allowed track name server-side:

```ts
const expectedTrackName = `screen:${boardId}:${screenShareSessionId}`;
```

Use fixed Cloudflare base + auth:

```ts
const CF_BASE = `https://rtc.live.cloudflare.com/v1/apps/${encodeURIComponent(appId)}`;
const cfHeaders = {
  Authorization: `Bearer ${appSecret}`,
  'Content-Type': 'application/json',
  Accept: 'application/json',
};
```

`owner|edit` may create publisher sessions; any non-closed permission may create viewer sessions.

- [ ] **Step 4: Implement signed session leases**

Define payload:

```ts
type SessionLease = {
  boardId: string;
  screenShareSessionId: string;
  cloudflareSessionId: string;
  role: 'publisher' | 'viewer';
  exp: number;
};
```

Encode JSON as base64url. Sign `payloadB64` with HMAC-SHA-256 using a key imported from `CLOUDFLARE_REALTIME_APP_SECRET`; encode signature base64url. Lease format:

```text
<payloadB64>.<signatureB64>
```

Set `exp = Date.now() + 2 * 60 * 60 * 1000`. Verification must use `crypto.subtle.verify`, reject expired payloads, and require exact equality for board ID, screen-share session ID, Cloudflare session ID, and expected role.

- [ ] **Step 5: Implement the fixed operation map**

`create-publisher-session` and `create-viewer-session`:

```http
POST /apps/{appId}/sessions/new
{}
```

After successful `{ sessionId }`, return a signed lease with the matching role.

`publish-track` requires publisher lease + `owner|edit` and sends:

```ts
{
  sessionDescription: { type: 'offer', sdp },
  tracks: [{ location: 'local', mid, trackName: expectedTrackName }],
}
```

to `POST /sessions/{sessionId}/tracks/new`.

`subscribe-track` requires viewer lease and sends:

```ts
{
  tracks: [{
    location: 'remote',
    sessionId: publisherSessionId,
    trackName: expectedTrackName,
  }],
}
```

to the viewer's `POST /sessions/{viewerSessionId}/tracks/new`.

`renegotiate-viewer` requires viewer lease and sends:

```ts
{ sessionDescription: { type: 'answer', sdp } }
```

to `PUT /sessions/{viewerSessionId}/renegotiate`.

`close-track` requires a valid lease for the session being closed, validates `mid`, and sends:

```ts
{
  tracks: [{ mid }],
  force: true,
}
```

to `PUT /sessions/{sessionId}/tracks/close`. Publisher lease closure additionally requires `owner|edit`; viewer lease closure is allowed to any non-closed board participant.

Reject SDP above a fixed safe limit (e.g. 256 KiB) and reject invalid identifier/mid formats before any Cloudflare call.

- [ ] **Step 6: Run the source/security test**

Run: `node scripts/test-cloudflare-realtime-edge-function.mjs`

Expected: PASS.

- [ ] **Step 7: Commit**

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
- `createCloudflareScreenShareApi({ supabase, boardId, boardKey, screenShareSessionId })` returns fixed methods matching Task 2.
- `createCloudflarePublisher({ track, trackName, api, RTCPeerConnectionImpl })` → `{ sessionId, sessionLease, trackName, mid, peer, sender, close }`.
- `createCloudflareSubscriber({ publisherSessionId, trackName, api, RTCPeerConnectionImpl })` → `{ sessionId, sessionLease, mid, peer, stream, close }`.
- Both peer connections use Cloudflare STUN and never call `getDisplayMedia()`.

- [ ] **Step 1: Write a failing transport unit test with fake WebRTC peers**

Fake publisher records `addTransceiver(track, { direction: 'sendonly' })`, offer/local/remote description, sender, and close. Fake subscriber records Cloudflare offer/local answer and triggers `ontrack`. Mock API order:

```text
publisher: createPublisherSession -> publishTrack
subscriber: createViewerSession -> subscribeTrack -> renegotiateViewer
```

Assert publisher receives the exact pre-existing track object by identity. Assert the module contains neither `getDisplayMedia` nor any App Secret/Vite Cloudflare credential.

- [ ] **Step 2: Run and verify failure**

Run: `node scripts/test-cloudflare-screen-share-transport.mjs`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement Supabase API wrapper**

Each method calls:

```js
supabase.functions.invoke('cloudflare-realtime', { body: { ...base, operation, ...details } });
```

Pass returned `sessionLease` only to subsequent calls for that same local Cloudflare session. Throw normalized errors on function/response failure. Do not automatically retry mutation requests.

- [ ] **Step 4: Implement ICE gathering helper**

After `setLocalDescription(offer)`, wait until `peer.iceGatheringState === 'complete'` or a bounded timeout fires. Send `peer.localDescription.sdp`, not the pre-gathering offer object, to the HTTPS signaling API.

- [ ] **Step 5: Implement publisher negotiation**

1. Create publisher session + lease.
2. Create Cloudflare `RTCPeerConnection` with `stun:stun.cloudflare.com:3478`.
3. Add the existing capture track with a send-only transceiver.
4. Create/set local offer and gather ICE.
5. Read `transceiver.mid` after local description; call `publishTrack({ sessionId, sessionLease, mid, sdp })`.
6. Apply returned Cloudflare answer.
7. Return the response `mid` if supplied, otherwise the transceiver mid, for later forced close.

- [ ] **Step 6: Implement subscriber negotiation**

1. Create viewer session + lease.
2. Create Cloudflare peer.
3. Call `subscribeTrack({ viewerSessionId, sessionLease, publisherSessionId })`.
4. Require Cloudflare `sessionDescription.type === 'offer'` when immediate renegotiation is requested.
5. Set remote offer, create/set local answer, gather ICE, then `renegotiateViewer()` with the viewer lease.
6. Resolve a `MediaStream` when a video `ontrack` event arrives; enforce a bounded timeout.
7. Retain returned viewer `mid` for forced close.

- [ ] **Step 7: Implement idempotent local teardown**

`close()` attempts backend `close-track` with `{ mid, force: true }`, ignores cleanup-only backend failure after logging, clears handlers, and closes the local peer exactly once.

- [ ] **Step 8: Run transport tests**

Run: `node scripts/test-cloudflare-screen-share-transport.mjs`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/lib/cloudflareScreenShare.js scripts/test-cloudflare-screen-share-transport.mjs
git commit -m "feat: add Cloudflare screen share transport"
```

---

### Task 4: Integrate manual Cloud switching into `useAdaptiveScreenShare`

**Files:**
- Modify: `src/components/ScreenShare.jsx`
- Modify: `src/lib/screenShare.js`
- Create: `scripts/test-screen-share-cloud-switch.mjs`

**Interfaces:**
- Extend `view` with `transport: 'p2p' | 'cloud'`, `cloudPhase: 'off' | 'connecting' | 'on' | 'disconnecting' | 'error'`, `cloudError: ''`.
- Expose `setCloudEnabled(enabled)` from `useAdaptiveScreenShare`.
- Keep `localStreamRef` as the one capture source; `stream` remains the currently rendered media source.

- [ ] **Step 1: Write failing lifecycle regression assertions**

Create `scripts/test-screen-share-cloud-switch.mjs` and assert:

```js
assert.match(source, /setCloudEnabled/);
assert.match(source, /cloudPhase/);
assert.match(source, /createCloudflarePublisher/);
assert.match(source, /createCloudflareSubscriber/);
assert.equal((source.match(/getDisplayMedia\(/g) ?? []).length, 1);
```

Assert Cloud cleanup is referenced from host stop/viewer cleanup/unmount and existing P2P creation remains present.

- [ ] **Step 2: Run and verify failure**

Run: `node scripts/test-screen-share-cloud-switch.mjs`

Expected: FAIL.

- [ ] **Step 3: Add Cloud refs/state without touching default start**

Add `cloudPublisherRef`, `cloudSubscriberRef`, and per-viewer Cloud readiness tracking. Initialize normal share state:

```js
transport: 'p2p',
cloudPhase: 'off',
cloudError: '',
```

`start()` must not call Cloudflare.

- [ ] **Step 4: Implement `setCloudEnabled(true)`**

Host-only and `sourceMode === 'screen'` only:

1. Set `cloudPhase: 'connecting'` and retain P2P peers.
2. Build `trackName = screenShareCloudTrackName(boardId, session.sessionId)`.
3. Call `createCloudflarePublisher()` with `localStreamRef.current.getVideoTracks()[0]`.
4. Apply current adaptive profile to Cloud sender.
5. Broadcast `cloud-track` with only `publisherSessionId` + `trackName`; never broadcast the publisher lease.
6. Set `transport: 'cloud'`, `cloudPhase: 'on'` after publisher negotiation succeeds.
7. On failure, close partial Cloud resources, keep P2P untouched, set error state, and preserve current stream.

- [ ] **Step 5: Implement viewer `cloud-track` handling**

Require signal `sessionId === activeSessionRef.current?.sessionId` and normalized route. Create/replace viewer subscriber. Switch `stream` to Cloud only after its video track arrives. Send `cloud-viewer-ready`. If subscription fails, keep the P2P stream and do not affect other viewers.

- [ ] **Step 6: Retire redundant P2P only per successful viewer**

On host receipt of `cloud-viewer-ready`, start a two-second timer for that viewer and then close/remove only that viewer's entry in `hostPeersRef` if the same Cloud session is still active. Viewers not ready remain on P2P.

- [ ] **Step 7: Implement `setCloudEnabled(false)` P2P-first handback**

Host:

1. Set `cloudPhase: 'disconnecting'`.
2. Broadcast `cloud-disable`.
3. Immediately `announceHost()` so viewers send normal `viewer-ready` and receive fresh P2P offers using the same capture track.
4. Keep Cloud publisher alive for up to three seconds.
5. Close Cloud publisher and set `transport: 'p2p'`, `cloudPhase: 'off'`.

Viewer: retain Cloud stream until P2P `ontrack` arrives, switch to P2P, then close Cloud subscriber. If P2P does not return within the grace period, stop displaying the stale Cloud stream when host teardown arrives and show normal connecting/no-picture state without stopping host capture.

- [ ] **Step 8: Apply adaptive profiles to Cloud sender**

Keep current iteration over P2P senders and additionally call:

```js
applySenderProfile(cloudPublisherRef.current?.sender, profile, degraded)
```

when a Cloud publisher exists.

- [ ] **Step 9: Add complete teardown + stale signal guards**

Host stop, browser-ended capture, losing arbitration, page unmount, viewer leave, and session replacement all close appropriate Cloud resources. Old `sessionId` Cloud signals are ignored.

- [ ] **Step 10: Run lifecycle regressions**

```bash
node scripts/test-screen-share-cloud-switch.mjs
node scripts/test-screen-share-cloud-protocol.mjs
node scripts/test-cloudflare-screen-share-transport.mjs
node scripts/test-screen-share.mjs
node scripts/test-screen-share-stun-retry.mjs
node scripts/test-screenshare-full-frame-release.mjs
```

Expected: PASS.

- [ ] **Step 11: Commit**

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
- Consume `screenShare.view.cloudPhase`, `screenShare.view.transport`, and `screenShare.setCloudEnabled`.
- Render one ephemeral DOM overlay for the active local normal-screen host only.
- Anchor it to the transient Fabric screen-share object's upper-right viewport position.

- [ ] **Step 1: Write failing UI regression test**

Assert source contains the Cloud control, `setCloudEnabled`, cloud-phase states, host/source guards, CSS class, and no attempt to serialize the control into Fabric state.

- [ ] **Step 2: Run and verify failure**

Run: `node scripts/test-board-screen-share-cloud-control.mjs`

Expected: FAIL.

- [ ] **Step 3: Derive overlay position from the existing transient Fabric object**

At the board-screen-share integration point, calculate the object's upper-right scene point and transform it through `canvas.viewportTransform`. Refresh ephemeral `{ left, top }` React state on live object move/scale, viewport zoom/pan, canvas resize, and relevant render events. Do not alter the object's durable representation.

- [ ] **Step 4: Render the host-only checkbox**

Use an overlay equivalent to:

```jsx
<label
  className={`screen-share-cloud-control is-${cloudPhase}`}
  style={{ left, top }}
  onPointerDown={(event) => event.stopPropagation()}
  onClick={(event) => event.stopPropagation()}
>
  <span>{cloudPhase === 'connecting' ? 'Cloud …' : 'Cloud'}</span>
  <input
    type="checkbox"
    checked={transport === 'cloud' || cloudPhase === 'connecting'}
    disabled={cloudPhase === 'connecting' || cloudPhase === 'disconnecting'}
    onChange={(event) => screenShare.setCloudEnabled(event.target.checked)}
    aria-label="Передавать демонстрацию через Cloudflare"
  />
</label>
```

Render only when `sourceMode === 'screen'`, local user is active host, and the transient object exists.

- [ ] **Step 5: Style the overlay**

Add `.screen-share-cloud-control` to `src/styles.css`: compact font, unobtrusive background, high z-index above canvas, keyboard-visible focus, and distinct connecting/error states. Do not change board layout measurements.

- [ ] **Step 6: Run UI/object regression tests**

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

### Task 6: Deploy fail-closed backend source and document production setup

**Files:**
- Modify if required: `supabase/functions/cloudflare-realtime/index.ts`
- Create: `docs/CLOUDFLARE-REALTIME-SETUP.md`
- Modify: `scripts/test-cloudflare-realtime-edge-function.mjs`

**Interfaces:**
- Production requires Supabase secrets named exactly `CLOUDFLARE_REALTIME_APP_ID` and `CLOUDFLARE_REALTIME_APP_SECRET`.
- Missing secrets produce configuration error only for Cloud mode; P2P remains usable.

- [ ] **Step 1: Extend test for missing-secret fail-closed behavior**

Assert the function checks both secrets before Cloudflare network calls and returns a generic server-configuration error without returning secret values.

- [ ] **Step 2: Write exact setup documentation**

`docs/CLOUDFLARE-REALTIME-SETUP.md` must state:

1. Create one Cloudflare Realtime SFU Application.
2. Copy App ID and App Secret.
3. Store them only as Supabase Edge Function secrets `CLOUDFLARE_REALTIME_APP_ID` and `CLOUDFLARE_REALTIME_APP_SECRET`.
4. Deploy `cloudflare-realtime` from the committed source.
5. Smoke test `Cloud ☐` → `Cloud ☑` → `Cloud ☐`.
6. Never put App Secret in Cloudflare Pages/Vite public variables.

- [ ] **Step 3: Deploy reviewed function to connected Supabase project**

Project: `nsdmvyggcarwznvvzpet`.

Deploy exact committed `index.ts`. Use `verify_jwt: false` because this endpoint implements explicit board-key authorization on every request, matching the existing `ably-token` model.

If credentials are not configured yet, verify only the deterministic fail-closed response; do not claim live SFU success.

- [ ] **Step 4: Run backend regression test**

Run: `node scripts/test-cloudflare-realtime-edge-function.mjs`

Expected: PASS.

- [ ] **Step 5: Commit docs/final backend adjustments**

```bash
git add supabase/functions/cloudflare-realtime/index.ts docs/CLOUDFLARE-REALTIME-SETUP.md scripts/test-cloudflare-realtime-edge-function.mjs
git commit -m "docs: document Cloudflare screen relay setup"
```

---

### Task 7: Full verification and review

**Files:**
- Change only if a test demonstrates a scoped regression.

**Interfaces:**
- Produces a reviewable branch; `main` remains untouched.

- [ ] **Step 1: Run every new Cloud regression**

```bash
node scripts/test-screen-share-cloud-protocol.mjs
node scripts/test-cloudflare-realtime-edge-function.mjs
node scripts/test-cloudflare-screen-share-transport.mjs
node scripts/test-screen-share-cloud-switch.mjs
node scripts/test-board-screen-share-cloud-control.mjs
```

Expected: PASS.

- [ ] **Step 2: Run existing screen-share regressions**

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

Expected: PASS for tests present in the repository.

- [ ] **Step 3: Build**

Run: `npm run build`

Expected: Vite exits 0 with no unresolved imports or secret leakage.

- [ ] **Step 4: Review branch diff**

Compare `main...feature/cloudflare-screen-share-fallback`. Confirm no unrelated drawing, persistence, remote-browser, board schema, or game code changed. Search tracked frontend files for `CLOUDFLARE_REALTIME_APP_SECRET` and ensure it appears only in server/docs/test contexts, never in `src/`.

- [ ] **Step 5: Live smoke test only after Cloudflare credentials exist**

```text
Host starts share -> P2P picture
Host checks Cloud -> no new screen picker -> viewer gets Cloud picture
Late viewer joins active Cloud -> gets Cloud picture
Host unchecks Cloud -> viewer returns to P2P
Host stops -> transient object and Cloud peers disappear
Cloud backend unavailable -> Cloud error, P2P stays usable
```

Do not report this matrix as passed until actually executed against configured Cloudflare credentials.

- [ ] **Step 6: Diff hygiene and PR**

Run `git diff --check main...HEAD` and inspect all changed files. Create a PR to `main` only after deterministic tests/build pass; do not merge without an explicit merge decision.
