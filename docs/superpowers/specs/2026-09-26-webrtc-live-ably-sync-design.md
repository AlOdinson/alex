# WebRTC Live + Ably Authoritative Sync — Design

Date: 2026-09-26
Branch: project/webrtc-live-ably-sync
Base main commit: 3b08833d57b604d312bdbaa97d620e0a91476108

## Goal

Move high-frequency visual collaboration to WebRTC while making Ably the reliable board-synchronization and signaling plane.

The intended behavior is:

- WebRTC carries disposable live previews: pencil points, cursors, drag/resize/rotate frames, selection previews, and viewport-follow frames.
- Ably carries presence, WebRTC signaling, durable action proposals, authoritative commits, acknowledgements, locks, revision synchronization, and snapshot recovery.
- The teacher browser remains the only canonical authority.
- A WebRTC failure may reduce smoothness, but must not block durable editing while Ably is healthy.
- This project is developed only on `project/webrtc-live-ably-sync`; `main` is not changed without explicit merge approval.

## Current architecture

Today the project is split differently:

- Ably carries transient events such as `cursor`, `draw`, `transform`, `preview`, `object-live`, `delete-preview`, `selection-transaction`, `view`, and WebRTC signaling.
- Durable student proposals, acknowledgements, commits, snapshots, locks, and verification traffic use an ordered reliable WebRTC DataChannel.
- Ably deliberately ignores `action` / `actions` packets in browser-authority mode.
- The teacher browser owns canonical board state and revision in the browser authority store.
- Images may be embedded as large data URLs in durable objects; the existing peer transport chunks oversized messages and snapshot transfers.
- The default RTC configuration currently has one STUN server and no TURN relay.

## Target architecture

### Ably control + durable synchronization plane

Ably becomes the primary reliable transport for the existing peer-authority protocol.

It carries versioned, targeted durable envelopes for:

- head / revision exchange
- snapshot request and snapshot transfer
- sync request
- action proposal
- authoritative commit
- acknowledgement
- lock request / lock result
- verification control traffic
- WebRTC offer / answer / ICE signaling
- presence and participant capabilities

Ably is a transport, not a second authority. A student may publish a proposal, but only the teacher authority may produce canonical commits and revision advances.

The existing `teacherPeerHub` and `studentPeerSession` semantics should be reused wherever practical by placing an Ably transport adapter underneath them instead of duplicating authority logic.

### WebRTC live plane

Create a dedicated DataChannel:

- label: `alex-board-live-v1`
- purpose: transient high-frequency visual frames only
- stale frames may be dropped
- it never advances board revision
- it never writes canonical history
- it never grants permissions or locks

The current durable DataChannel `alex-board-durable-v1` remains available during rollout for legacy compatibility and as a temporary migration fallback, but it is not the target primary durable transport after both peers advertise Ably durable capability.

## Capability negotiation

Presence data advertises explicit capabilities:

```js
capabilities: {
  ablyDurableV1: true,
  webrtcLiveV1: true
}
```

Rules:

- New teacher + new student: Ably durable + WebRTC live.
- New + legacy peer: use the current legacy durable WebRTC path and current Ably transient path for that peer until both sides support the new architecture.
- No client assumes support from version numbers or timing alone.
- Capability changes are diagnostic/control metadata and do not grant edit permission.

## Reusing the existing peer protocol over Ably

Introduce an Ably durable transport adapter with the same conceptual interface used by the current peer sessions:

```js
transport.send(type, payload)
transport.sendTextTransfer(kind, text, options)
transport.sendLowPriorityEncoded(encoded)
transport.close()
```

The adapter wraps each peer-protocol frame in a targeted Ably envelope containing:

```js
{
  protocol: "alex-board-ably-durable-v1",
  boardId,
  sourceId,
  targetId,
  messageId,
  frame
}
```

Teacher broadcast commits are still logically one authority commit delivered to each eligible peer. Receivers ignore envelopes not targeted to them (or explicit broadcast envelopes where allowed).

## Ably large-message transport

The existing peer protocol limits individual frames. Reuse its bounded transfer framing rather than publishing multi-megabyte JSON as one Ably message.

Requirements:

- choose an Ably-safe frame ceiling below the account/platform maximum; initial project value: 12 KiB encoded frame payload
- large peer messages are split into `transfer-start`, bounded `transfer-chunk`, and `transfer-end`
- receiver reassembles with an explicit maximum transfer size and maximum concurrent transfers
- duplicated frames are idempotent
- missing/incomplete transfers expire
- malformed or oversized transfers are rejected
- snapshots and image-bearing commits may therefore work without WebRTC, although they are expected to be slower and more expensive than small actions

This project does not migrate images to object storage. That can be a later optimization.

## Durable delivery semantics

Ably receipt alone is not application acknowledgement.

The existing action protocol remains authoritative:

1. Student creates stable `actionId`.
2. Student sends `action-proposal` through the Ably durable transport.
3. Teacher validates permission, lock state, base revision, and operation semantics.
4. Teacher commits once.
5. Teacher sends canonical `commit` and `ack`.
6. Duplicate proposal with the same `actionId` returns the existing outcome instead of applying twice.

On reconnect, revision/head synchronization repairs any missed commit.

## WebRTC live protocol

Create a versioned envelope:

```js
{
  protocol: "alex-board-live-v1",
  type: "cursor" | "draw" | "transform" | "preview" | "object-live" |
        "delete-preview" | "selection-transaction" | "view" |
        "view-jump" | "view-request" | "background-live",
  boardId,
  clientId,
  seq,
  baseRevision,
  timestamp,
  payload
}
```

Rules:

- `seq` is monotonic per sender/live session.
- Receiver tracks highest accepted sequence for replaceable streams.
- Live messages cannot advance canonical revision.
- Causally stale frames are ignored.
- Corresponding transient state is reconciled or removed when the canonical Ably commit arrives.
- Malformed, oversized, unknown-type, and wrong-board messages are rejected.

## Live channel behavior

Use a second RTCDataChannel independent from the legacy durable channel.

Desired properties:

- unordered where safe
- bounded retransmission or no retransmission for disposable frames
- no unbounded promise/send queue
- congestion-aware coalescing
- live channel closure must not close Ably durable editing
- durable/Ably failure must not be hidden by a still-moving live preview

## Event classification

### WebRTC-live primary

- cursor
- pencil stroke preview
- single-object transform preview
- group transform preview
- object-live preview
- delete preview
- selection transaction preview
- viewport/view-follow
- view-jump
- view-request when live peer is available
- background-live preview

### Ably durable/control

- final pencil stroke
- final object move/resize/rotate
- object create/delete
- text commit
- style commit
- background commit
- undo/redo
- image insertion final state
- lock acquire/refresh/release
- canonical commit
- canonical snapshot
- revision/head exchange
- acknowledgements
- permission-relevant state
- verification traffic
- presence/capabilities
- WebRTC signaling

## Pencil behavior

While pointer/stylus is down:

- incremental points travel through WebRTC live
- points may be coalesced under congestion
- receiver paints a transient stroke

On pointer-up:

- one complete authoritative stroke action is proposed through Ably
- teacher commits it once
- canonical commit replaces/reconciles transient preview
- lost live packets cannot change the final stroke

If live WebRTC is unavailable, optional bounded Ably transient fallback may provide a lower-rate preview; regardless, the final durable stroke still goes through Ably.

## Transform behavior

During drag, resize, rotation, or group transform:

- send newest causally valid frame over WebRTC live
- coalesce obsolete frames by object/group key
- respect the existing selection lease and lock model
- final state is proposed/committed through Ably
- commit clears stale preview

## Images

Do not retransmit image bytes for every transform.

- live image transform contains object id + geometry only
- final transform action contains canonical object mutation
- initial image insertion may contain a large data URL and therefore uses the bounded Ably transfer framing
- late-join snapshot may include image data and uses the same bounded transfer framing
- object-storage migration is out of scope

## Ably transient fallback

WebRTC live is preferred. When unavailable:

- durable editing continues through Ably
- selected transient events may use the existing Ably event path at bounded rates
- cursor <= 10 Hz
- transform <= 10 Hz
- draw preview <= 10 Hz with point coalescing
- view <= 8 Hz
- object/selection previews coalesced by identity

When live WebRTC recovers, discard stale queued previews and route new transient traffic back to WebRTC.

## WebRTC signaling

Keep offer/answer/ICE signaling on Ably.

Existing signaling replay assistance remains.

TURN infrastructure is not added in this project, but the new live channel must work with future `rtcConfig` STUN/TURN settings without protocol redesign.

## Connection/readiness model

Track durable and live readiness separately.

- `durableReady`: Ably authority session is synchronized enough to edit.
- `liveReady`: WebRTC live DataChannel is open.
- Editing permission depends on `durableReady`, not `liveReady`.
- UI may show reduced-live-quality/fallback diagnostics without disabling editing.
- A working WebRTC channel must never mask an Ably durable outage.

## Recovery

### Ably durable reconnect

1. reconnect/reattach Ably
2. presence/capability refresh
3. exchange authoritative head
4. request missing commits or snapshot
5. only then declare durable editing ready

### WebRTC live reconnect

1. verify signaling/session peer identity
2. open new live channel
3. clear stale local live queue
4. resume only new transient frames
5. canonical Ably revision remains unchanged by the live reconnect

## Diagnostics

Expose internal counters/state without board content or secrets:

- durable Ably state
- live WebRTC state
- live direct/relay candidate type when browser APIs expose it safely
- current revision
- live frames sent/received/dropped/coalesced
- live fallback events sent via Ably
- durable frames/messages sent via Ably
- reconnect count
- large transfer count/bytes
- current capability mode: legacy / hybrid / v1

## Feature flags and rollout

Use a safe rollout flag:

- `ablyDurableWebrtcLiveV1`
- optional `dualTransportDiagnostics`

Modes:

- off: current production behavior
- on for both capable peers: Ably durable + WebRTC live
- mixed capabilities: legacy behavior
- diagnostic mode: compare paths without applying duplicate effects

Keep the current implementation available until the new branch passes verification.

## Files expected to change

Primary existing files:

- `src/lib/browserAuthorityRealtime.js`
- `src/lib/browserAuthorityRealtimeCore.js`
- `src/lib/browserBoardSession.js`
- `src/lib/browserPeerConnection.js`
- `src/lib/teacherPeerNetwork.js`
- `src/lib/studentPeerNetwork.js`
- `src/lib/teacherBoardRuntime.js`
- `src/lib/studentBoardRuntime.js`
- `src/components/Board.jsx`

Reuse where possible:

- `src/lib/peerProtocol.js`
- `src/lib/teacherPeerHub.js`
- `src/lib/studentPeerSession.js`

Likely new modules:

- `src/lib/ablyDurableTransport.js`
- `src/lib/liveEventProtocol.js`
- `src/lib/peerLiveChannel.js`
- `src/lib/liveTransportRouter.js`

## Non-goals

This project will not:

- remove Ably
- replace teacher authority
- move canonical browser storage to a backend
- migrate images to object storage
- replace Supabase token issuance
- deploy TURN
- change board/share-key formats
- merge anything into `main` without explicit approval

## Security and authority invariants

- Only the teacher authority advances canonical revision.
- Student Ably messages are proposals, never commits.
- Source identity is taken from the authenticated/session context and validated against envelope identity.
- Wrong-board / wrong-target durable envelopes are ignored.
- Duplicate action IDs are idempotent.
- Live WebRTC messages are untrusted preview input.
- Live traffic cannot change permission, locks, history, or revision.
- Oversized/malformed messages and transfers fail closed.
- Secret room keys are never included in diagnostics.

## Verification plan

### Unit tests

- Ably durable envelope validation and targeting
- peer-protocol framing over Ably
- large durable message chunk/reassembly
- duplicate/missing/expired transfer behavior
- durable action idempotency through Ably
- capability negotiation
- live protocol validation
- live sequence/stale rejection
- live coalescing/congestion behavior
- live failure independent from durable readiness
- bounded Ably transient fallback

### Integration tests

- new student joins through Ably durable sync with revision 0 snapshot
- existing student catches up through commits
- student proposal -> teacher authority -> commit/ack over Ably
- image-bearing action over chunked Ably
- lock acquire/refresh/release over Ably
- teacher/student reconnect and revision repair
- cursor through WebRTC
- pencil preview through WebRTC + final action through Ably
- image drag/resize preview through WebRTC + final transform through Ably
- group selection/transform
- undo/redo after live preview
- WebRTC loss while durable Ably edit succeeds
- Ably loss while live frames may still arrive but editing is gated
- legacy/new mixed-client behavior
- late join gets canonical state, never stale previews

### Browser tests

At minimum:

- Chromium desktop
- WebKit desktop
- existing touch-profile fixtures
- throttled/congested live DataChannel
- reordered/dropped live frames
- Ably durable reconnect
- large snapshot transfer over Ably adapter
- fallback transient path

### Existing regression suites

Run all existing browser-authority, sync, history, image, selection, storage, peer, screen-share, and build suites relevant to production behavior.

## Acceptance criteria

The branch is ready for merge review only when:

1. New-capability peers use Ably for durable authority synchronization and WebRTC for high-frequency live previews.
2. WebRTC live failure does not prevent a healthy Ably session from editing.
3. Ably durable failure gates editing even if stale live frames still move.
4. Final canonical board is identical with perfect, lossy, reordered, or absent live traffic.
5. Large snapshots/image-bearing actions can synchronize without relying on the live WebRTC channel.
6. Legacy/new mixed clients remain usable via legacy transport behavior.
7. Instrumentation shows a material reduction in Ably transient message volume during normal drawing/dragging.
8. Existing authority/history/image/selection synchronization tests remain green.
9. `main` remains unchanged until explicit approval.

## Rollout sequence

1. Ably durable transport adapter over existing peer protocol.
2. Capability advertisement and mixed-client selection.
3. Ably durable authority session integration.
4. Dedicated WebRTC live channel.
5. Cursor migration.
6. Pencil preview migration.
7. Single-object transform migration.
8. Group/selection/view previews.
9. Bounded Ably transient fallback.
10. Diagnostics / dual-transport verification.
11. Full regression and browser tests.
12. Branch-only deployment/testing.
13. Explicit merge decision.
