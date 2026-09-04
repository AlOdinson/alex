# Board-native Screen Share Design

## Goal

Turn normal desktop screen sharing into a temporary, live object on the Fabric board. Any participant with edit permission can start a share; while one share is active no second share may start. Any editor can move and resize the live screen object, but it cannot rotate. The object disappears everywhere when the share ends and is never persisted in board history or snapshots.

## Confirmed behavior

- The existing `ShareScreen` desktop control remains the entry point.
- The control is available to any participant whose board permission is `owner` or `edit` (`canEdit === true`).
- `view` participants cannot start a share.
- Only one normal screen-share session may be active per board.
- If two editors start almost simultaneously, the existing deterministic `preferredScreenShareSession` arbitration selects one winner; the loser stops its capture.
- The screen appears near the center of the current board viewport with an initial 16:9 footprint.
- The live screen is represented as a transient Fabric object backed by the existing WebRTC MediaStream, not as a durable board image.
- Any editor may click the live screen, move it, and resize it with Fabric controls.
- Rotation/skew/flips are disabled; the rotation control is hidden.
- Live geometry (`left`, `top`, `width`, `height`) is broadcast on the screen-share signaling channel at a throttled cadence and applied by every participant.
- `host-start` carries the current geometry so late joiners and reconnecting viewers recover the same placement.
- The live object is excluded from normal object serialization, object journal operations, snapshots, clipboard, Undo/Redo, delete-selection, clear-board, and exported board content.
- Ending capture through `Stop Share`, the browser capture picker/indicator, page close, or session arbitration sends/observes `host-stop`; the transient Fabric object is removed immediately on every participant.
- The existing remote-browser overlay remains unchanged. This design applies to normal `sourceMode: 'screen'` only.

## Architecture

### Screen-share protocol

`src/lib/screenShare.js` gains:

- `screen-layout` as a valid signal type.
- `screenSharePermissionCanHost(permission)` to authorize `owner` and `edit` host signals.
- `normalizeScreenShareBoardLayout(layout)` to validate/clamp scene-space layout payloads.
- `screenShareBoardLayoutForViewport(...)` to derive the initial centered 16:9 layout.

The `useAdaptiveScreenShare` hook stores `boardLayout` in its view state, includes it in `host-start`, consumes `screen-layout`, and exposes `updateBoardLayout(layout)`. Normal screen-share host signals accept `owner` or `edit`; remote-browser availability/control retains its existing owner-specific rules.

### Fabric live media object

`src/lib/boardScreenShare.js` owns the Fabric/media bridge:

- create a transient `FabricImage` from a 1280x720 placeholder canvas;
- attach an `HTMLVideoElement` once the MediaStream can play;
- request Fabric renders from `requestVideoFrameCallback` (with a timer fallback);
- convert between Fabric scale/position and scene-space `{left, top, width, height}`;
- disable rotation/skew/flip controls and mark the object `transientScreenShare` and `excludeFromExport`.

`Board.jsx` owns lifecycle and collaboration integration. A React effect creates the media controller when a normal screen-share session exists, updates its stream/layout/interactivity, and disposes it when the session ends.

### Geometry collaboration

Normal Fabric object transform handlers special-case `transientScreenShare` before durable board logic:

- no Supabase object lease;
- no normal object transform frames;
- no durable operation or history entry;
- moving/scaling broadcasts the screen layout through `screenShare.updateBoardLayout` at the existing ~50 ms live-transform cadence;
- transform completion sends a final layout immediately.

Incoming `screen-layout` changes update the transient object unless that same object is currently being transformed locally, preventing drag jitter.

## Safety invariants

- A live screen object never has to become a durable board record.
- Normal drawings and images remain untouched by screen-share lifecycle.
- Stopping a share removes only the transient object for that session.
- A viewer cannot spoof host lifecycle signals; only `owner`/`edit` permissions are accepted for normal screen host signals.
- The existing deterministic session comparator remains the single-share conflict arbiter.
