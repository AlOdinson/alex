# WebRTC Live + Ably Signaling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move all board live/transient traffic from Ably to WebRTC while preserving the existing durable WebRTC authority path and keeping Ably only for presence/discovery and WebRTC signaling.

**Architecture:** Keep `alex-board-durable-v1` unchanged for canonical collaboration. Add `alex-board-live-v1` as an independent disposable DataChannel for high-frequency previews, and route rare board-control events over the existing reliable durable peer protocol. Capability negotiation through Ably presence enables the new mode only when both peers support it; otherwise legacy Ably-live behavior remains.

**Tech Stack:** React 19, Fabric 7, WebRTC RTCDataChannel, Ably Realtime v2, IndexedDB browser authority/replica stores, Node test runner, Playwright browser fixtures.

**Spec:** `docs/superpowers/specs/2026-09-26-webrtc-live-ably-sync-design.md`

## Global Constraints

- Work only on `project/webrtc-live-ably-sync`; do not write or merge to `main`.
- Ably remains only for token auth, presence/discovery, capability advertisement, and offer/answer/ICE signaling for new-capability peers.
- Existing `alex-board-durable-v1` remains the canonical reliable path.
- New live channel label is exactly `alex-board-live-v1`.
- Initial live channel options are `ordered:false`, `maxRetransmits:0`, subject only to proven browser compatibility fallback.
- New presence capability is exactly `webrtcLiveV1:true`.
- No TURN deployment, image-storage migration, Supabase replacement, board-key format change, or authority-model rewrite.
- Legacy peer compatibility remains available behind capability negotiation.
- Live traffic can never mutate history, locks, permissions, or canonical revision.

## Review Focus

1. Live frames arrive reordered or duplicated: newest causally valid frame must win and canonical durable state must remain untouched.
2. Live channel closes while durable channel stays open: durable editing must continue.
3. Durable connection fails while a stale live channel is still producing frames: editing must still fail/recover according to the existing durable runtime.
4. New client talks to legacy client: current Ably-live behavior must remain usable.
5. High-rate drawing/transform congestion: queue must stay bounded and old frames must coalesce/drop rather than stall durable traffic.

---

### Task 1: Add the live event protocol

**Files:**
- Create: `src/lib/liveEventProtocol.js`
- Create: `scripts/test-live-event-protocol.mjs`

**Interfaces:**
- Produces:
  - `BOARD_LIVE_PROTOCOL = 'alex-board-live-v1'`
  - `LIVE_EVENT_TYPES`
  - `encodeLiveEvent({type, boardId, clientId, seq, baseRevision, timestamp, streamKey, payload})`
  - `decodeLiveEvent(value, {boardId, remoteClientId, highestSeqByStream}) -> envelope|null`

- [ ] Write failing tests for valid encode/decode, wrong protocol/board/source, unknown type, malformed sequence/revision, oversized frame, duplicate/stale sequence.
- [ ] Run `node --test scripts/test-live-event-protocol.mjs` and verify RED.
- [ ] Implement the minimal protocol/validation.
- [ ] Run the same command and verify GREEN.
- [ ] Commit: `feat: add WebRTC live event protocol`.

---

### Task 2: Add congestion-aware disposable live DataChannel transport

**Files:**
- Create: `src/lib/peerLiveChannel.js`
- Create: `scripts/test-peer-live-channel.mjs`

**Interfaces:**
- Produces `createPeerLiveChannel({channel, boardId, localClientId, remoteClientId, getRevision, onEvent, onState, onError, highWaterMark, lowWaterMark, maxPendingStreams})`
- Returned API: `send(type,payload,{streamKey})`, `stats()`, `close()`.

- [ ] Write failing tests for immediate send, congestion coalescing by stream key, bounded queue, newest-frame replacement, stale receive rejection, close/error reporting.
- [ ] Add a test proving live close does not call or close any durable transport.
- [ ] Run `node --test scripts/test-peer-live-channel.mjs scripts/test-live-event-protocol.mjs` and verify RED.
- [ ] Implement transport with `bufferedAmount` high/low watermarks and no unbounded promise queue.
- [ ] Run focused tests GREEN.
- [ ] Commit: `feat: add disposable WebRTC live channel transport`.

---

### Task 3: Create the second RTCDataChannel without disturbing durable behavior

**Files:**
- Modify: `src/lib/browserPeerConnection.js`
- Modify: `scripts/test-browser-peer-connection.mjs`

**Interfaces:**
- `createBrowserPeerConnection` gains `onLiveChannel(channel)`.
- Initiator creates both `alex-board-durable-v1` and `alex-board-live-v1`.
- Responder routes each incoming label to the correct callback.

- [ ] Extend browser-peer tests: initiator creates two exact labels; durable remains `ordered:true`; live is `ordered:false,maxRetransmits:0`.
- [ ] Add responder tests for both labels and unknown label rejection.
- [ ] Add live-only closure test proving durable channel/RTCPeerConnection remains active.
- [ ] Run `node --test scripts/test-browser-peer-connection.mjs` RED.
- [ ] Implement channel separation.
- [ ] Run test GREEN plus `scripts/test-peer-data-channel.mjs`.
- [ ] Commit: `feat: create independent WebRTC live data channel`.

---

### Task 4: Wire live channel through teacher/student peer networks and runtimes

**Files:**
- Modify: `src/lib/teacherPeerNetwork.js`
- Modify: `src/lib/studentPeerNetwork.js`
- Modify: `src/lib/teacherBoardRuntime.js`
- Modify: `src/lib/studentBoardRuntime.js`
- Test: `scripts/test-teacher-peer-network.mjs`
- Test: `scripts/test-student-peer-network.mjs`
- Test: existing teacher/student runtime tests

**Interfaces:**
- Peer networks expose `sendLive(...)`, `getLiveState()`, `getLiveStats()`.
- Board runtimes expose `sendLive(type,payload,options)` and `onLiveEvent`.
- Existing durable readiness semantics do not change.

- [ ] Write failing tests proving live transport attachment is separate from hub/session durable transport.
- [ ] Test live close leaves durable peer registered and editable.
- [ ] Test durable failure still triggers current session recovery even if live channel exists.
- [ ] Run focused network tests RED.
- [ ] Implement live plumbing using Task 2.
- [ ] Run network/runtime tests GREEN.
- [ ] Commit: `feat: route live channel through peer runtimes`.

---

### Task 5: Add capability negotiation through Ably presence

**Files:**
- Create: `src/lib/collaborationTransportFlags.js`
- Modify: `src/lib/browserAuthorityRealtime.js`
- Modify: `src/lib/browserBoardSession.js`
- Test: `scripts/test-browser-authority-realtime-events.mjs`
- Test: `scripts/test-browser-board-session.mjs`
- Create: `scripts/test-collaboration-transport-flags.mjs`

**Interfaces:**
- `resolveCollaborationMode({enabled, localCapabilities, remoteCapabilities}) -> 'legacy'|'webrtc-live-v1'`
- Ably presence gains optional `capabilities:{webrtcLiveV1:true}`.

- [ ] Write tests: flag off -> legacy; both capable -> v1; one legacy -> legacy; capability never changes permission.
- [ ] Test presence enter/refresh preserves capability metadata.
- [ ] Test mixed new/legacy peer continues existing Ably-live behavior.
- [ ] Run focused tests RED.
- [ ] Implement capability propagation/selection.
- [ ] Run tests GREEN.
- [ ] Commit: `feat: negotiate WebRTC live capability`.

---

### Task 6: Move high-frequency transient events from Ably to WebRTC live

**Files:**
- Create: `src/lib/liveTransportRouter.js`
- Modify: `src/lib/browserAuthorityRealtimeCore.js`
- Modify: `src/lib/browserAuthorityRealtime.js`
- Modify: `src/lib/browserBoardSession.js`
- Test: `scripts/test-live-transport-router.mjs`
- Test: `scripts/test-browser-authority-realtime-core.mjs`
- Test: `scripts/test-browser-authority-realtime-events.mjs`
- Test: `scripts/test-stale-draw-preview-regression.mjs`

**Events migrated in this task:**
- cursor
- draw
- transform
- preview
- object-live
- delete-preview
- high-rate selection transaction frames
- view

**Interfaces:**
- `createLiveTransportRouter({mode, sendWebRtcLive, publishLegacyAbly})`
- Existing Board-facing methods keep signatures.

- [ ] Write router tests proving v1 sends each listed event only to WebRTC; legacy sends only to Ably; no dual-send in normal mode.
- [ ] Add live stream-key tests: cursor, draw object id, transform object/group identity, view.
- [ ] Update realtime-core tests to preserve current call signatures and durable behavior.
- [ ] Run focused tests RED.
- [ ] Implement router and inject it into realtime core/session.
- [ ] Add canonical-commit-wins tests for lossy/reordered draw/transform previews.
- [ ] Run focused tests GREEN.
- [ ] Commit: `feat: move high-frequency board previews to WebRTC`.

---

### Task 7: Move remaining low-frequency board events off Ably onto reliable WebRTC

**Files:**
- Modify: `src/lib/peerProtocol.js`
- Modify: `src/lib/teacherPeerHub.js`
- Modify: `src/lib/studentPeerSession.js`
- Modify: `src/lib/browserAuthorityRealtimeCore.js`
- Modify: `src/lib/browserAuthorityRealtime.js`
- Test: `scripts/test-peer-protocol.mjs`
- Test: `scripts/test-teacher-peer-hub.mjs`
- Test: `scripts/test-student-peer-session.mjs`
- Test: `scripts/test-browser-authority-realtime-core.mjs`

**Reliable board-control events:**
- mode
- background-live
- sync hint
- view-jump
- view-request
- game-library-visibility
- selection transaction lifecycle boundaries where reliability is required

**Interfaces:**
- Add peer protocol message `board-control`.
- Payload is `{event,payload}` with an explicit allowlist.
- Teacher/student sessions expose `onBoardControl(event,payload)` and `sendBoardControl(event,payload)`.

- [ ] Write failing protocol/allowlist tests, including unknown event rejection.
- [ ] Write teacher/student routing tests for each allowed event.
- [ ] Prove new-v1 peers publish none of these events through Ably.
- [ ] Run focused tests RED.
- [ ] Implement board-control path on durable WebRTC channel.
- [ ] Run tests GREEN.
- [ ] Commit: `feat: move board control events off Ably`.

---

### Task 8: Integrate Board, diagnostics, and branch-only feature flag

**Files:**
- Modify: `src/components/Board.jsx`
- Modify: `src/lib/browserAuthorityRealtime.js`
- Modify: `src/lib/browserBoardSession.js`
- Modify: `src/lib/collaborationTransportFlags.js`
- Add/extend diagnostic tests.

**Interfaces:**
- Feature flag: `webrtcLiveV1`.
- Diagnostics report: collaboration mode, Ably signaling state, RTC state, durable channel state, live channel state, live sent/received/coalesced/dropped counts, legacy Ably-live count, canonical revision.

- [ ] Write failing tests proving flag off preserves production behavior exactly.
- [ ] Write tests proving new-new mode sends board events through WebRTC while Ably only sees presence/signaling.
- [ ] Add diagnostics tests with no board content or secret room key leakage.
- [ ] Implement Board/session plumbing without changing drawing tool public behavior.
- [ ] Run focused tests GREEN.
- [ ] Commit: `feat: enable branch-only WebRTC live collaboration mode`.

---

### Task 9: Browser and failure-mode verification

**Files:**
- Add focused browser fixture/test as needed under `scripts/`.
- Extend existing preview/convergence/reconnect tests rather than creating duplicate full-stack fixtures.

- [ ] Add Chromium test: teacher/student cursor + pencil live preview arrive through WebRTC; final stroke converges durably.
- [ ] Add image drag/resize test: live geometry arrives without image bytes; final durable state matches.
- [ ] Add packet reorder/drop simulation: preview may degrade, canonical board must converge.
- [ ] Add live congestion simulation: bounded pending state and no durable stall.
- [ ] Add live-channel-close simulation: durable edit still succeeds.
- [ ] Add full RTC failure/reconnect test using Ably signaling assistance.
- [ ] Add mixed-client test proving legacy Ably-live route.
- [ ] Run browser-focused tests on Chromium and WebKit where current project fixtures support them.
- [ ] Commit: `test: verify WebRTC live collaboration recovery`.

---

### Task 10: Full regression and branch-only release evidence

**Files:**
- Update branch release/evidence document only if needed.
- Do not modify production deployment or `main`.

- [ ] Run focused peer suite:
  `node --test scripts/test-peer-protocol.mjs scripts/test-peer-data-channel.mjs scripts/test-browser-peer-connection.mjs scripts/test-teacher-peer-network.mjs scripts/test-student-peer-network.mjs`
- [ ] Run browser-authority suites covering realtime, cycle, recovery, history, images, locks, selection, and snapshots.
- [ ] Run `npm run test:sync`.
- [ ] Run `npm run test:browser-authority` if still present in branch scripts; otherwise run the exact constituent command from `package.json`.
- [ ] Run `npm run build`.
- [ ] Verify Git diff against `main` contains only branch work and no deployment/main mutation.
- [ ] Record any physical-device checks as RUN/NOT RUN; do not claim unrun iPad/Russian-network checks.
- [ ] Commit evidence only after all automated checks are captured.
- [ ] Stop before merge; report branch result for explicit user decision.

## Self-review result

- Spec coverage: all target sections map to Tasks 1–10.
- Type/interface consistency: live protocol -> live channel -> peer networks -> router -> Board is one directional dependency chain; durable interfaces remain existing ones.
- Review focus: each listed failure mode has an owning test task.
- Scope: TURN and hosting/accessibility remain separate future projects.
- Main protection: every task is branch-only and the final task explicitly stops before merge.
