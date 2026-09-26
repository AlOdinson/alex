# WebRTC Live + Ably Authoritative Sync — Design

Date: 2026-09-26
Branch: project/webrtc-live-ably-sync
Base main commit: 3b08833d57b604d312bdbaa97d620e0a91476108

## Goal

Make WebRTC the primary transport for high-frequency visual collaboration events while keeping Ably as the control plane for presence, signaling, authoritative board synchronization, and recovery.

The user-facing goal is that drawing, cursor movement, object drag/resize/rotate, selection previews, and viewport-following feel immediate and do not consume Ably message volume at high frequency. Final durable board state must still converge through one authoritative path.

This project must not change `main` until the isolated branch has passed the full verification plan and is explicitly approved for merge.

## Current architecture

The current browser-authority architecture already separates durable and transient behavior partially:

- Durable student actions are proposed to the teacher over the WebRTC DataChannel.
- The teacher remains the authority for canonical board state and revision.
- Ably currently carries transient realtime events such as `cursor`, `draw`, `transform`, `preview`, `object-live`, `delete-preview`, `selection-transaction`, `view`, `view-jump`, `view-request`, presence, and WebRTC signaling.
- Ably deliberately rejects durable `action` / `actions` events in the current browser-authority mode.
- WebRTC signaling itself is transported through Ably.
- The current WebRTC peer configuration has one default STUN server and no TURN relay in the default config.
- The current peer DataChannel is ordered and is used for reliable durable application messages and snapshot transfers.

## Target architecture

Use two WebRTC DataChannels per teacher-student peer session:

1. **Durable channel**
   - Existing label: `alex-board-durable-v1`
   - Ordered and reliable.
   - Continues to carry durable proposals, acknowledgements, authoritative commits/snapshots, lock requests, verification traffic, and transfers.
   - Existing semantics remain unchanged.

2. **Live channel**
   - New label: `alex-board-live-v1`
   - Optimized for transient high-frequency events.
   - Primary transport for visual-only events.
   - Must never become a source of durable truth.
   - Late or stale live frames must be discardable.
   - Each live event includes enough identity/revision metadata to detect stale frames.

Ably remains the control plane:

- presence
- participant discovery
- WebRTC offer/answer/ICE signaling
- board revision / authoritative synchronization notifications
- connection recovery coordination
- fallback delivery of selected live events when WebRTC live transport is unavailable
- no independent second durable source of truth

## Event classification

### WebRTC-live primary events

The following events should move from Ably-primary to WebRTC-live-primary:

- cursor
- draw preview
- transform preview
- object-live preview
- delete preview
- selection transaction preview
- view / viewport-follow
- view-jump
- view-request where a live peer is present
- background-live preview when applicable

These events may still use bounded Ably fallback when no live DataChannel is available.

### Durable / authoritative events

These remain on the existing authoritative durable path and must not be downgraded to transient transport:

- completed pencil stroke
- final object position/scale/rotation
- create/delete object
- text commit
- style commit
- background commit
- undo/redo
- board metadata changes
- image insertion final state
- lock acquire/refresh/release
- canonical snapshot
- revision and acknowledgement state
- permission changes
- verification records

## Live message protocol

Create a versioned live envelope:

```js
{
  protocol: "alex-board-live-v1",
  type: "cursor" | "draw" | "transform" | ...,
  boardId,
  clientId,
  seq,
  baseRevision,
  timestamp,
  payload
}
```

Rules:

- `seq` is monotonic per peer/live session.
- Receiver keeps the highest accepted sequence per event stream/source.
- Old/stale sequence numbers are ignored.
- `baseRevision` prevents previews based on obsolete board state from overwriting newer durable state.
- live frames must never advance canonical revision.
- live frames must never be journaled as durable actions.
- after the corresponding durable commit arrives, related preview state is cleared/reconciled.

## Transport selection

For every transient event:

1. If live WebRTC DataChannel is open and writable, send through WebRTC.
2. If it is connecting/recovering, use event-specific policy:
   - high-rate disposable events: drop or coalesce
   - important transient UI events: bounded Ably fallback
3. If WebRTC has failed, send through bounded Ably fallback.
4. When WebRTC recovers, switch new transient traffic back to WebRTC without replaying stale live frames.

Never send the same transient event to both paths in production mode unless diagnostic dual-send is explicitly enabled.

## Ably fallback policy

Ably fallback is a resilience path, not the normal high-rate transport.

Recommended fallback rate limits:

- cursor: <= 10 Hz
- transform: <= 10 Hz
- draw preview: <= 10 Hz with point coalescing
- view: <= 8 Hz
- object/selection previews: coalesce by object / transaction id

Durable authoritative synchronization remains unaffected by these limits.

## Draw behavior

During an active pencil stroke:

- points are streamed incrementally through WebRTC live.
- live packets are coalesced to stay below buffer thresholds.
- the receiver renders a transient stroke preview.
- on pointer-up, the complete serialized stroke is committed through the durable authority path.
- once the durable commit is accepted, the transient version is replaced or reconciled with the canonical object.
- if live packets are lost, the final durable stroke still produces the correct final board.

## Transform behavior

During drag, resize, rotate, or group transform:

- send bounded live frames through WebRTC.
- receiver renders only the newest causally valid frame.
- final Fabric object state is committed through the durable path.
- after commit, stale previews are removed.
- lock and selection lease semantics remain authoritative and unchanged.

## Images

Do not continuously transmit image bytes during transforms.

- Initial image insertion uses the existing durable/chunked transport path.
- Live transform events carry object id plus position/scale/rotation metadata only.
- Existing image bytes/data URL remain attached to canonical object state.
- Large image payloads must never be routed through the high-frequency live channel.
- Any future object-storage migration is explicitly out of scope for this project.

## WebRTC connection model

Keep the existing teacher-student peer topology.

The live channel is created alongside the durable channel.

Teacher:
- accepts incoming live channel
- registers per-peer live sender/receiver with teacher peer hub

Student:
- creates both durable and live channels as initiator
- considers durable readiness separately from live readiness
- board editing is allowed when durable path is ready
- live preview quality may degrade gracefully if live channel is not ready

A live-channel failure must not close an otherwise healthy durable channel.

A durable-channel failure remains a stronger session failure and follows existing recovery behavior.

## Buffering and congestion

The existing durable transport uses backpressure and chunking. The live transport should use different semantics:

- hard cap on queued bytes
- no unbounded promise queue
- coalesce replaceable events by key, e.g. latest cursor or latest transform for object/group
- drop obsolete frames when the channel is congested
- protect durable channel bandwidth from live traffic
- expose live dropped/coalesced counters for diagnostics

Suggested initial thresholds should be validated by tests rather than assumed final.

## Recovery

When WebRTC disconnects:

- Ably remains connected if available.
- UI status moves to recovery/fallback state.
- authoritative edits may continue through the existing durable recovery rules; this project must not invent a second authority.
- selected live events can fall back to Ably at bounded rates.

When WebRTC reconnects:

1. verify peer/session identity
2. confirm current board revision
3. discard all queued stale live frames
4. resume new live traffic
5. reconcile any remaining transient UI against canonical state

No complete board replay is required if revisions already match.

## Signaling

Keep WebRTC signaling on Ably.

Existing offer/answer/ICE replay assistance stays in place.

This project does not remove Ably authentication or presence.

TURN support is recommended as a separate follow-up project. The live-channel architecture must accept a future `rtcConfig` containing STUN/TURN without further protocol changes.

## Diagnostics

Add internal transport diagnostics:

- live transport state: idle / connecting / direct / relay / failed / fallback
- durable transport state
- last accepted live sequence per peer
- sent live frames
- received live frames
- dropped live frames
- coalesced live frames
- Ably fallback event count
- reconnect count
- current canonical board revision

These diagnostics must not contain board content or secret room keys.

## Feature flags

Introduce a safe rollout flag, for example:

- `webrtcLiveTransport`
- optional `dualTransportDiagnostics`

Behavior:

- flag off: current production transport behavior
- flag on: WebRTC-primary live events with Ably fallback
- diagnostic mode: compare transports without applying duplicate UI effects

The legacy Ably live path remains available until the new implementation passes verification.

## Files expected to change

Primary:

- `src/lib/browserPeerConnection.js`
- `src/lib/peerDataChannel.js` or a new dedicated live transport module
- `src/lib/teacherPeerNetwork.js`
- `src/lib/studentPeerNetwork.js`
- `src/lib/browserAuthorityRealtimeCore.js`
- `src/lib/browserAuthorityRealtime.js`
- `src/lib/browserBoardSession.js`
- `src/components/Board.jsx`

Likely new modules:

- `src/lib/peerLiveChannel.js`
- `src/lib/liveEventProtocol.js`
- `src/lib/liveTransportRouter.js`

Tests/scripts:

- new focused live-transport unit tests
- browser authority integration tests
- connection recovery regressions
- draw/transform convergence tests
- Ably fallback tests
- live congestion/backpressure tests

## Non-goals

This project will not:

- remove Ably
- move canonical board storage to a server
- replace the existing teacher authority model
- change board IDs or share-key format
- migrate image storage
- replace Supabase token issuance
- add TURN infrastructure in the same implementation
- modify production `main` until explicit merge approval

## Compatibility

The rollout must support old and new clients during transition.

A client advertising no live-channel capability remains on the existing Ably transient path.

Capability negotiation can be communicated through peer protocol/session hello. No client should assume the remote side supports `alex-board-live-v1` until explicitly detected.

## Security and authority invariants

- Live WebRTC traffic is untrusted transient UI input.
- It cannot grant permission.
- It cannot advance revision.
- It cannot bypass object locks or selection leases.
- It cannot directly mutate canonical history.
- Final object mutation still passes the same authoritative validation used today.
- Peer identity must remain tied to the established board session / signaling identity.
- Oversized or malformed live frames are rejected.

## Verification plan

### Unit tests

- live protocol validation
- sequence ordering / stale rejection
- coalescing behavior
- buffer overflow/drop behavior
- Ably fallback throttling
- capability negotiation
- malformed frame rejection
- live failure does not close durable channel
- durable failure still triggers existing recovery

### Integration tests

- teacher -> student cursor
- student -> teacher cursor
- pencil live preview + durable final stroke
- image drag/resize live preview + durable final transform
- group transform
- selection transaction
- undo/redo during or after live preview
- concurrent edits / lock conflict
- WebRTC live failure with Ably fallback
- WebRTC reconnect
- stale preview after newer durable commit
- late joiner receives canonical state, not old live frames
- existing snapshot and image transfers remain unaffected

### Browser tests

At minimum:

- Chromium desktop
- WebKit desktop
- touch-profile browser tests already used by the project
- explicit throttled/congested DataChannel fixture
- simulated packet loss / reorder for live channel
- simulated Ably-only fallback

### Existing regression suites

Run existing authority, sync, image, history, browser, and screen-share suites. No release claim should be made from focused tests alone.

## Acceptance criteria

The branch is ready for merge review only when:

1. High-frequency transient events use WebRTC by default when the live channel is healthy.
2. Ably message volume for a normal drawing session is materially lower in instrumentation.
3. Final board state remains identical to the authoritative result with or without live packet loss.
4. Loss/reorder of live frames never corrupts canonical state.
5. Live channel failure does not disable durable editing.
6. Ably fallback preserves usable collaboration when live WebRTC is unavailable.
7. Legacy clients still interoperate.
8. Existing history, image, authority, and synchronization regressions remain green.
9. No change has been merged to `main` without explicit approval.

## Rollout sequence

1. Protocol + live DataChannel with no UI routing.
2. Cursor migration.
3. Pencil draw preview migration.
4. Single-object transform migration.
5. Group/selection previews.
6. View/autopilot events.
7. Ably live fallback throttling.
8. Diagnostics and dual-transport verification.
9. Full regression run.
10. Manual test branch deployment.
11. Only after explicit approval: prepare merge to `main`.
