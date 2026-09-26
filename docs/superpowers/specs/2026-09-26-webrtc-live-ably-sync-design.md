# WebRTC Live + Ably Signaling — Design

Date: 2026-09-26
Branch: project/webrtc-live-ably-sync
Base main commit: 3b08833d57b604d312bdbaa97d620e0a91476108

## Goal

Move all board live/visual traffic that currently uses Ably onto WebRTC, while keeping Ably only as the connection-assistance plane: participant presence/discovery plus WebRTC signaling (offer, answer, ICE).

The existing WebRTC durable authority path remains unchanged in purpose: it continues to carry canonical actions, acknowledgements, commits, snapshots, locks, verification traffic, and large transfers.

The teacher browser remains the only canonical authority.

No change is merged to `main` without explicit approval.

## Current architecture

Today:

- Ably carries transient board events:
  - mode
  - background-live
  - sync
  - cursor
  - lock preview
  - transform
  - draw
  - preview
  - object-live
  - delete-preview
  - selection-transaction
  - view
  - view-jump
  - view-request
  - game-library-visibility
  - WebRTC signaling
  - presence
- WebRTC `alex-board-durable-v1` carries durable student proposals, acknowledgements, commits, snapshots, locks, verification traffic, and large chunked transfers.
- The teacher browser owns canonical board state/revision.
- Ably deliberately does not accept durable `action` / `actions` packets.
- WebRTC signaling is already relayed through Ably.
- Current default RTC config has one STUN server and no TURN.

## Target architecture

### Ably: connection assistance only

For two new-capability clients, Ably is used only for:

- token authentication
- presence
- participant discovery
- capability advertisement
- WebRTC signaling:
  - offer
  - answer
  - ICE candidates
  - bounded signaling replay assistance already implemented

No board live event is published through Ably once both peers support the new live transport.

Ably does not become a board synchronization backend.

### WebRTC durable channel: canonical/reliable path

Keep existing label:

`alex-board-durable-v1`

Keep existing ordered, reliable semantics.

It continues to carry:

- initial head/revision exchange
- snapshot request and snapshot transfer
- sync requests
- action proposals
- authoritative commits
- acknowledgements
- lock acquire/refresh/release
- verification traffic
- large image-bearing messages
- undo/redo outcomes
- canonical board recovery

This path remains the source of durable collaboration truth.

### WebRTC live channel: transient visual path

Create a second DataChannel:

`alex-board-live-v1`

Purpose:

- cursor
- pencil live preview
- transform preview
- preview
- object-live
- delete-preview
- selection-transaction preview
- view / view-jump / view-request
- background-live preview
- lock visualization
- other existing non-durable board live events

Rules:

- live traffic never advances canonical revision
- live traffic never writes durable history
- live traffic never grants permission
- live traffic never bypasses object locks or selection leases
- stale or malformed frames are discardable
- final canonical state always comes from the existing durable channel

## Low-frequency board-control events

Some current Ably events are not high-rate but still belong to the board rather than to connection setup, e.g. mode, game-library-visibility, background-live, sync hints.

For new-capability peers, these move off Ably too.

Use the existing reliable WebRTC durable channel for low-frequency transient/control messages that should not be lost or reordered.

Add a bounded peer-protocol message type such as:

`board-control`

with payload:

```js
{
  event,
  payload
}
```

Allowed control events are explicitly enumerated.

This avoids keeping Ably as a second board-event bus while also avoiding unreliable delivery for rare control transitions.

## Live protocol

Use a versioned envelope:

```js
{
  protocol: "alex-board-live-v1",
  type,
  boardId,
  clientId,
  seq,
  baseRevision,
  timestamp,
  streamKey,
  payload
}
```

### Sequence and staleness

- `seq` is monotonic per sender live session.
- Replaceable streams also use `streamKey` such as `cursor`, `transform:<objectId>`, `view`, or `draw:<objectId>`.
- Receiver tracks newest accepted sequence per stream.
- older frames are ignored
- frames whose `baseRevision` is causally obsolete for the referenced object/state are ignored using existing convergence rules where applicable
- canonical durable commit always wins over live preview

## RTC live channel settings

Initial channel configuration:

```js
{
  ordered: false,
  maxRetransmits: 0
}
```

Rationale:

- cursor/transform/view frames are replaceable
- pencil preview may tolerate gaps because the complete final stroke arrives through the durable channel
- removing retransmission avoids head-of-line delay for obsolete preview frames

If browser compatibility testing proves `maxRetransmits: 0` unsuitable on a supported browser, keep `ordered: false` and use the narrowest compatible reliability setting; document the exact fallback in code/tests.

## Congestion behavior

The live channel must not use the durable channel's unbounded ordered promise queue.

Requirements:

- hard bufferedAmount high-water threshold
- low-water drain threshold
- bounded pending live map
- coalesce replaceable frames by `streamKey`
- newest frame replaces older pending frame
- drop obsolete frames instead of growing memory
- expose counts for sent/received/coalesced/dropped frames
- never let live congestion block durable sends

## Pencil behavior

During pointer/stylus down:

- points are sent incrementally over `alex-board-live-v1`
- packets may be coalesced/dropped under congestion
- receiver renders transient stroke preview

On pointer-up:

- full stroke is committed exactly as today over `alex-board-durable-v1`
- canonical commit reconciles/replaces transient stroke
- even if every live packet is lost, final board state is correct

## Transform behavior

During drag/resize/rotate/group transform:

- geometry previews go through live channel
- newest causally valid frame wins
- final transform commit stays on durable channel
- commit clears/reconciles preview
- selection lease and lock authority stay unchanged

## Images

- image bytes are not repeatedly sent during live transforms
- live image transform contains geometry/object identity only
- insertion/final image object uses existing durable chunking
- snapshot/image recovery remains on durable WebRTC channel
- object-storage migration is out of scope

## Connection model

Student remains WebRTC initiator under current topology.

On one RTCPeerConnection:

- durable DataChannel: `alex-board-durable-v1`
- live DataChannel: `alex-board-live-v1`

Readiness is separate:

- `durableReady`: canonical edit path ready
- `liveReady`: live preview channel ready

Editing requires `durableReady`.

A live-channel-only failure must not close a healthy durable channel.

If the entire RTCPeerConnection fails, existing recovery/signaling assistance reconnects the peer. Ably helps establish the new connection but does not carry board events in v1 mode.

TURN is a separate follow-up project.

## Capability negotiation

Presence advertises:

```js
capabilities: {
  webrtcLiveV1: true
}
```

Rules:

- new + new => WebRTC live + WebRTC durable; Ably presence/signaling only
- new + legacy => current legacy behavior for that peer:
  - durable over existing WebRTC
  - live events through current Ably path
- no capability inference from application version or timing
- capability does not alter permission

This allows branch testing without breaking existing clients.

## Routing model

Introduce a single board transient router.

For each event:

- if collaboration mode is `v1` and event is high-rate live => WebRTC live
- if collaboration mode is `v1` and event is reliable low-frequency board control => WebRTC durable `board-control`
- if collaboration mode is `legacy` => existing Ably behavior
- signaling always => Ably
- durable canonical operations always => existing durable WebRTC path

No production dual-send of the same board event.

Optional diagnostics mode may compute both paths but applies/sends only the selected path unless an explicit test fixture enables mirrored transport.

## Event classification

### High-rate WebRTC live

- cursor
- draw
- transform
- preview
- object-live
- delete-preview
- selection-transaction preview frames that are self-contained
- view

### Reliable WebRTC board-control

- mode
- background-live
- sync hint
- view-jump
- view-request
- game-library-visibility
- selection transaction lifecycle boundaries if tests show they cannot safely be lossy
- other rare board UI control events currently using Ably

Exact classification is pinned by tests before migration of each event.

## Recovery

### Live channel recovers

- clear pending stale live queue
- reset live sequence epoch/session
- resume only new frames
- do not replay old previews

### Durable channel recovers

Use existing durable recovery semantics:

- head/revision comparison
- missing commits/snapshot
- canonical convergence

### Ably reconnects

Ably reconnect is relevant only for presence/signaling continuity.

If WebRTC is already healthy, an Ably signaling reconnect must not disturb the active board channels.

If WebRTC is down, Ably presence/signaling recovery helps create a new peer connection.

## Diagnostics

Expose internal state/counters without board content or secret keys:

- Ably signaling state
- WebRTC connection state
- durable channel state
- live channel state
- sent/received live frames
- coalesced live frames
- dropped live frames
- legacy Ably live message count
- current collaboration mode: legacy / webrtc-live-v1
- reconnect count
- current canonical revision

## Feature flags

Use branch-only opt-in:

- `webrtcLiveV1`
- optional `dualTransportDiagnostics`

Modes:

- flag off => production behavior unchanged
- flag on + capable peer => WebRTC live
- flag on + legacy peer => current Ably live path
- no merge to `main` without explicit approval

## Files expected to change

Primary:

- `src/lib/browserPeerConnection.js`
- `src/lib/peerProtocol.js`
- `src/lib/peerDataChannel.js` only if board-control needs a helper
- `src/lib/teacherPeerNetwork.js`
- `src/lib/studentPeerNetwork.js`
- `src/lib/teacherBoardRuntime.js`
- `src/lib/studentBoardRuntime.js`
- `src/lib/browserBoardSession.js`
- `src/lib/browserAuthorityRealtimeCore.js`
- `src/lib/browserAuthorityRealtime.js`
- `src/components/Board.jsx`

Likely new:

- `src/lib/liveEventProtocol.js`
- `src/lib/peerLiveChannel.js`
- `src/lib/liveTransportRouter.js`
- `src/lib/collaborationTransportFlags.js`

## Non-goals

This project will not:

- move durable board synchronization to Ably
- make Ably an authoritative board backend
- remove Ably signaling/presence
- deploy TURN
- replace Supabase token issuance
- migrate image storage
- change board/share-key formats
- change teacher authority semantics
- merge to `main`

## Security and authority invariants

- live messages are untrusted transient UI input
- live messages cannot mutate canonical history/revision
- board-control messages are validated against an explicit allowlist
- wrong-board/wrong-peer live frames are ignored
- oversized/malformed live frames are rejected
- durable actions continue through existing authority checks
- secret room keys never enter diagnostics

## Verification plan

### Unit

- live protocol validation
- stale sequence rejection
- wrong board/source rejection
- congestion/coalescing/drop behavior
- board-control allowlist validation
- capability negotiation
- live close independent from durable close

### Integration

- cursor teacher -> student over WebRTC
- cursor student -> teacher over WebRTC
- pencil preview over live + final durable stroke
- transform preview over live + final durable transform
- image resize preview without retransmitting image bytes
- group transform/selection
- view/view-jump/view-request
- mode/background/game visibility through WebRTC board-control
- live loss with durable final state still correct
- Ably reconnect while WebRTC remains healthy
- WebRTC reconnect using Ably signaling
- new/legacy mixed peer uses legacy Ably live path

### Browser

- Chromium desktop
- WebKit desktop
- existing touch-profile browser tests
- simulated reordered/dropped live frames
- simulated live channel congestion
- live channel close while durable stays open
- full peer reconnect

### Existing regressions

Run current peer, authority, history, image, selection, screen-share, sync, and production build suites.

## Acceptance criteria

Ready for merge review only when:

1. Two new clients publish no board live events through Ably.
2. Ably remains functional for presence and WebRTC signaling.
3. Existing durable WebRTC authority path remains correct.
4. High-frequency previews use `alex-board-live-v1`.
5. Loss/reorder/congestion of live packets never corrupts canonical state.
6. Live-channel failure alone does not break durable editing.
7. Mixed new/legacy clients remain usable.
8. Existing history/image/selection/authority regression suites remain green.
9. `main` remains unchanged until explicit approval.

## Rollout sequence

1. Live protocol + channel, unused by UI.
2. Capability negotiation.
3. Cursor migration.
4. Pencil draw preview migration.
5. Single-object transform migration.
6. Group/selection/preview/object-live/delete-preview migration.
7. View events migration.
8. Rare board-control events move from Ably to reliable WebRTC.
9. Diagnostics.
10. Full regression/browser verification.
11. Branch-only deployment/test.
12. Explicit merge decision.
