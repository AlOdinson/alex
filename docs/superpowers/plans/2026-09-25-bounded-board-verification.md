# Bounded new-board verification implementation plan

> Implement inline with regression tests before integration. This is the approved scope from the board owner's discussion on 2026-09-25, not a statement that implementation is complete.

## Goal and immutable constraints

Add an event-driven, low-priority integrity check after authoritative drawing, property changes, transforms, deletes, eraser actions and undo/redo. Enable it only for boards created by the updated application; existing boards keep the existing behavior and receive no migration. Keep the existing durable authority, network recovery, action acknowledgements and history semantics.

- At most 100 objects in one verification batch, not 100 user actions.
- Cooperative CPU work budget: 4 ms; heavy serialization must yield rather than rely on object count alone.
- Debounce 200 ms, maximum scheduling deferral 1000 ms from the first pending change.
- Minimum 250 ms between batch starts (at most 4 batches/second).
- One active verification worker per board/device and one in-flight verification request per peer.
- Coalesce pending verification by object id and newest confirmed state; never coalesce/drop user actions.
- At most 1000 dirty identifiers; overflow becomes a bounded incremental membership/state sweep.
- Prefer 80 dirty and 20 older objects per batch, lending unused capacity to the other category.
- Only check committed data at compatible board/session/revision boundaries. Ignore stale responses. Do not overwrite a pending local edit or active gesture.
- Verify deletions as absence, not merely by iterating surviving objects. Include object order, board background, duplicates and Canvas/data agreement.
- Group transform stays one history action even when its verification takes multiple batches.
- Do not make drawing or the next history command await verification.
- No newly added periodic 5/30-second checks, retry timers or request-timeout policy: the owner explicitly removed points 13 and 14. Existing recovery is unchanged. Pending event-triggered work may drain after input stops.
- Repair narrowly; do not serialize/reload the full board for every stroke or create user history entries for repairs.

## Implementation sequence

1. Read and pin current creation, authority, replica, peer protocol, Canvas callback and history paths. Establish existing tests/build baseline and retain source evidence without changing main.
2. Write deterministic tests for scheduling, bounded dirty queue, continuous input, duplicate changes, stale generations, disposal, old/new-board eligibility and peer request bounds. Run them failing against missing functionality.
3. Implement scheduler and cooperative canonical comparison in small dependency-free modules. Repeat red/green tests.
4. Introduce an explicit creation-only feature marker, preserve it in snapshots/session metadata, and leave unmarked old boards disabled. Test reopen, copy and old-client behavior.
5. Integrate the bounded verification request/response and targeted repair with authority/replica and Canvas, retaining per-object/session/revision fences. Add tests for lost delete, same-revision wrong content, concurrent move/undo and large groups.
6. Run authority, sync/history/image and production-build checks. Add a browser-level verification scenario where feasible. Report unrun physical-device checks separately.
7. Review complete diff and verified commit, then publish only when the integrated change has passing evidence. Never claim a prototype or partial integration is deployed.

## Review focus

- A slow/lost verification message must not delay a durable commit or undo acknowledgement.
- A response from an old revision/session must not move or resurrect an object changed while the request was in flight.
- Queue overflow must not silently lose deletions or cause an unbounded full-board copy.
- Existing boards must not receive the new feature merely by opening/saving them after release.
- A large single path/image must not bypass the cooperative CPU budget.

## Status

- [x] Approved requirements recorded; feature branch isolated from main.
- [ ] Baseline and failing feature tests.
- [ ] Scheduler/comparison implementation.
- [ ] New-board eligibility and network/Canvas integration.
- [ ] Full verification and deployment.
