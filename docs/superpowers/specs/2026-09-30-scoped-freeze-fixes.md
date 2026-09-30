# Scoped lesson-freeze fixes

Approved scope: the user's 2026-09-30 instruction selects findings 1, 2 and 4 from the six-item chat summary. Do not fix findings 3, 5 or 6.

## Goals and constraints

- Reduce screen-share frame cost independently of accumulated static board geometry, preserving screen capture quality, viewport positioning, object stacking, drawing above/below media, and complete video frames.
- Stop thumbnail rendering/encoding during active input and on video-only frames. Preserve sharp white previews and durable final previews on home navigation/reload.
- A nonmatching finger/palm touchend must not finalize an ongoing Pencil contact. Preserve recovery from genuinely missing native pointerup and cancellation.
- Do not change the hidden game-library gesture, synchronization/replay/queues, detached-object retention/history, or unrelated Cloud/network logic.
- No new servers, TURN, live Ably fallback, periodic full sync, snapshot compaction, or dependency upgrades.
- The user already authorized these fixes and previously requested direct GitHub publication; carry through testing/review and publish the reviewed main update.

## Design

Keep the existing Fabric media object and frame canvas as the source of truth. Introduce a focused media compositor that caches static scene pixels around/below/above the visible screen-share region and updates only media pixels on video frames. Actual scene/viewport changes invalidate/rebuild cache. Fall back to the ordinary Fabric render for unsupported composite/selection states; preserve correctness before optimization. The common static-board + screen-share case must not rerender all paths per video frame. Stop frame-copy/presentation work when hidden or outside the viewport; resume with latest content. Avoid per-frame setCoords unless geometry changes. Preserve original full-frame staging to avoid the historical crop regression.

Thumbnail scheduling reacts to content/viewport changes and quiet input, not generic after:render. Defer while pointer/touch/keyboard activity is active; allow an explicit flush for leaving the board. Use asynchronous Blob encoding with a compatibility path, render geometry once per capture even when lowering JPEG quality, and serialize/retain at most one in-flight capture plus the newest dirty request. Exclude transient screen-share imagery from written lesson previews. Keep IDB data URL storage compatibility in this change.

Pencil fix is a minimal guard in the existing touch-end bridge: require a matching ended contact, or explicit evidence the tracked contact is absent and recovery is warranted. A different changed contact while tracked stylus is still in touches must return without claiming the event, dispatching an end, adding rejected IDs or resetting ownership.

## Acceptance

Regression tests must exercise actual production functions/components. Prove native and synthetic Pencil palm-release cases, genuine endings/cancel/recovery; thumbnail video-only idle, active-gesture deferral, flush ordering and final-frame persistence; media static-object render counts, visibility/resume, viewport/stack changes and pixel equivalence including annotations/erasers/controls. Run relevant existing suites and normal deployment verification commands. Validate browser behavior through the provided browser UI tooling where accessible and supported CI browser tests; don't claim physical iPad validation.
