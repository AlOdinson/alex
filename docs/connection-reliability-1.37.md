# Connection reliability — 1.37

The release retains the owner-authoritative WebRTC topology, existing signaling
and STUN services. It adds no production TURN service or board-data server.

## Changes

1. Valid Web Locks options, safe delayed acquisition and authority reacquisition.
2. Presence readiness follows the actual authority runtime, with bounded retry.
3. Duplicate signaling preserves the active SDP/ICE replay queue.
4. Attempt and native-generation checks reject stale offers and control replays.
5. Student reconnect backoff survives unchanged presence updates.
6. Real negotiation progress extends the primary idle timer within a total budget.
7. Coordinated ICE restart precedes full reconnect; a healthy wake probe cancels teardown.
8. A negotiated live channel can be replaced while keeping the durable channel.
9. Connection stages show total time and attempts; local diagnostics are bounded and omit addresses, SDP and keys.
10. The teacher relays validated student live events to the other students.
11. Unit, native browser and build checks gate deployment.

Mixed-version peers retain the full reconnect fallback. Live replacement requires
explicit remote support; an intentionally disabled live channel is not repaired.
No periodic full snapshot verification or snapshot compaction was added.

## Verification

Run `npm run test:connections`, `npm run test:browser-authority`,
`npm run test:sync:ci`, `npm run test:screen-share`, and `npm run build`.

`scripts/run-connection-direct-ci.sh` exercises three real browser participants:
edits, group cursors, pair-level ICE recovery, live-channel replacement, a wake
probe, and exclusive owner-tab handoff with persisted IndexedDB state.

The WebKit CI fixture uses its inspector's `ICECandidateFilteringEnabled=false`
setting for direct routes between peers on the same hosted macOS machine. This
test-only setting requires the pinned Playwright version. Chromium uses its
default ICE filtering. Neither fixture uses TURN or mocks SCTP/DataChannels.
These checks establish browser behavior on an available direct route; they do
not establish reachability through every mobile, corporate or residential NAT.
