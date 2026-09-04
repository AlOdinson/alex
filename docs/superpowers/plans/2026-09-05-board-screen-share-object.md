# Board-native Screen Share Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render normal WebRTC screen sharing as a temporary, movable and resizable Fabric board object that any editor can start or transform, with one active share per board and immediate removal on stop.

**Architecture:** Extend the existing screen-share signaling protocol with editor hosting permission and transient scene-space layout messages. Bridge the existing MediaStream into a transient `FabricImage` controller and special-case that object in Board transform handlers so its geometry is collaborative but never enters durable board history/snapshots.

**Tech Stack:** React 19, Fabric.js 7, WebRTC MediaStream, Supabase Realtime broadcast, Vite, Node regression scripts.

**Spec:** `docs/superpowers/specs/2026-09-05-board-screen-share-object-design.md`

## Global Constraints

- Normal ShareScreen can be started by `owner` or `edit` participants only.
- Exactly one normal screen-share session can be active per board.
- Any participant with edit permission can move and resize the live object.
- Rotation, skewing and flipping of the live screen are disabled.
- The live screen object is transient: no durable ops, snapshot, history, clipboard, delete-selection, clear-board or export persistence.
- Existing remote-browser behavior is not changed.
- Existing WebRTC transport and adaptive quality remain in use.

---

### Task 1: Screen-share protocol permissions and layout

**Files:**
- Modify: `src/lib/screenShare.js`
- Modify: `scripts/test-screen-share.mjs`

**Interfaces:**
- Produces: `screenSharePermissionCanHost(permission): boolean`
- Produces: `normalizeScreenShareBoardLayout(layout): {left,top,width,height}|null`
- Produces: `screenShareBoardLayoutForViewport(input): {left,top,width,height}`
- Produces: normalized `screen-layout` signaling support.

- [ ] **Step 1: Write failing protocol tests**

Add assertions that `owner` and `edit` can host, `view` cannot, malformed layouts are rejected, a centered viewport produces a 16:9 bounded layout, and `normalizeScreenShareSignal` accepts a `screen-layout` signal.

- [ ] **Step 2: Run the screen-share test and verify RED**

Run: `node scripts/test-screen-share.mjs`
Expected: FAIL because the permission/layout helpers and `screen-layout` signal do not yet exist.

- [ ] **Step 3: Implement minimal protocol helpers**

Add `screen-layout` to `SIGNAL_TYPES`, implement the three exported helpers, and keep existing session arbitration unchanged.

- [ ] **Step 4: Re-run and verify GREEN**

Run: `node scripts/test-screen-share.mjs`
Expected: PASS.

### Task 2: Editor-hosted screen-share session with collaborative layout state

**Files:**
- Modify: `src/components/ScreenShare.jsx`
- Create: `scripts/test-screen-share-board-session.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 1 helpers.
- Produces from `useAdaptiveScreenShare`: `sessionId`, `boardLayout`, `updateBoardLayout(layout)`, existing `stream`, `toggle`, and lifecycle state.

- [ ] **Step 1: Write failing static/behavior regression**

Assert that normal start checks `canEdit` instead of `isOwner`, normal host lifecycle accepts `owner`/`edit`, `host-start` carries `boardLayout`, `screen-layout` updates view state, and the returned hook exposes `sessionId`, `boardLayout`, and `updateBoardLayout`.

- [ ] **Step 2: Run and verify RED**

Run: `node scripts/test-screen-share-board-session.mjs`
Expected: FAIL on the current owner-only hook.

- [ ] **Step 3: Implement session layout state**

Use `getInitialBoardLayout()` during start, normalize it, include it in session/view/`host-start`, consume `screen-layout` only from the active host session, and send layout updates through existing `sendSignal`. Replace normal host permission gate with `screenSharePermissionCanHost` while preserving remote-browser owner-only checks.

- [ ] **Step 4: Re-run hook regression and existing protocol tests**

Run: `node scripts/test-screen-share-board-session.mjs && npm run test:screen-share`
Expected: PASS.

### Task 3: Transient Fabric media controller

**Files:**
- Create: `src/lib/boardScreenShare.js`
- Create: `scripts/test-board-screen-share-object.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `normalizeScreenShareBoardLayout`.
- Produces: `createBoardScreenShareMedia({sessionId, layout, canEdit})` controller with `object`, `setStream`, `setLayout`, `getLayout`, `setInteractive`, `dispose`.
- Produces: `isBoardScreenShareObject(object)`.

- [ ] **Step 1: Write failing object/controller regression**

Assert the module exists, the object is marked `transientScreenShare`, `excludeFromExport`, has rotation/skew locked, hides `mtr`, and exposes layout conversion/controller lifecycle APIs.

- [ ] **Step 2: Run and verify RED**

Run: `node scripts/test-board-screen-share-object.mjs`
Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the controller**

Create a 1280×720 placeholder canvas, `FabricImage`, hidden rotation control, video attach/play, `requestVideoFrameCallback` render loop with interval fallback, scene-layout conversion, editor interactivity, and cleanup.

- [ ] **Step 4: Run and verify GREEN**

Run: `node scripts/test-board-screen-share-object.mjs`
Expected: PASS.

### Task 4: Integrate live screen object into Board transforms and lifecycle

**Files:**
- Modify: `src/components/Board.jsx`
- Create: `scripts/test-board-screen-share-integration.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: Tasks 2–3 APIs.
- Produces: transient Fabric object lifecycle and throttled layout broadcasting.

- [ ] **Step 1: Write failing integration regression**

Assert Board passes `getInitialBoardLayout` into the hook, creates/disposes `createBoardScreenShareMedia`, special-cases `transientScreenShare` in `before:transform`, live transform, and `object:modified`, excludes it from marquee selection, deleteSelection and clearBoard, and never calls durable/history persistence for its transform path.

- [ ] **Step 2: Run and verify RED**

Run: `node scripts/test-board-screen-share-integration.mjs`
Expected: FAIL because Board still treats only durable objects and renders active normal share through the fixed overlay.

- [ ] **Step 3: Add lifecycle effect**

Create/dispose the media controller from `screenShare.sessionId/sourceMode`, attach `screenShare.stream`, apply incoming `boardLayout`, and keep `canEdit` interactivity current. Remove on idle/session change.

- [ ] **Step 4: Add geometry broadcast path**

Throttle screen layout updates to `LIVE_TRANSFORM_INTERVAL`; send a final update on `object:modified`. Skip object lease, durable transform frames, history and persistence for `transientScreenShare`.

- [ ] **Step 5: Protect temporary-object semantics**

Exclude the screen object from marquee group selection, selection UI style/copy operations, deleteSelection, clearBoard, and any durable serializing path reachable from transforms.

- [ ] **Step 6: Run and verify GREEN**

Run: `node scripts/test-board-screen-share-integration.mjs && node scripts/test-board-screen-share-object.mjs && npm run test:screen-share`
Expected: PASS.

### Task 5: Desktop UI permissions and remove active fixed overlay

**Files:**
- Modify: `src/components/Toolbar.jsx`
- Modify: `src/components/ScreenShare.jsx`
- Modify: `scripts/test-desktop-sharescreen-button.mjs`
- Create: `scripts/test-screen-share-overlay-mode.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: active `screenShare.sessionId`, `canEdit`.
- Produces: editor-visible desktop ShareScreen button and no fixed overlay for active normal screen sessions.

- [ ] **Step 1: Write failing UI regressions**

Assert desktop ShareScreen is gated by `canEdit` rather than `isOwner`, remains bound to `screenShare.toggle`, and `ScreenShareOverlay` returns null for an active normal screen session while remote-browser/picker/error notices remain supported.

- [ ] **Step 2: Run and verify RED**

Run: `node scripts/test-desktop-sharescreen-button.mjs && node scripts/test-screen-share-overlay-mode.mjs`
Expected: FAIL on owner-only desktop button / active fixed overlay.

- [ ] **Step 3: Implement minimal UI changes**

Change toolbar condition to `canEdit && screenShare`. In `ScreenShareOverlay`, keep normal request/error notices before a session exists, but suppress the fixed panel whenever `sourceMode === 'screen' && sessionId`.

- [ ] **Step 4: Run and verify GREEN**

Run: `node scripts/test-desktop-sharescreen-button.mjs && node scripts/test-screen-share-overlay-mode.mjs`
Expected: PASS.

### Task 6: Full regression and production build

**Files:**
- Modify only if a regression exposes a real integration defect.

- [ ] **Step 1: Run focused regressions**

Run: `node scripts/test-screen-share.mjs && node scripts/test-screen-share-board-session.mjs && node scripts/test-board-screen-share-object.mjs && node scripts/test-board-screen-share-integration.mjs && node scripts/test-desktop-sharescreen-button.mjs && node scripts/test-screen-share-overlay-mode.mjs && node scripts/test-bottom-tool-dock.mjs && node scripts/test-browser-button-visibility.mjs`
Expected: all PASS.

- [ ] **Step 2: Run production build**

Run: `npm install --no-audit --no-fund && npm run build`
Expected: exit 0.

- [ ] **Step 3: Review final diff**

Confirm only the protocol, screen-share hook/overlay, Fabric media helper, Board integration, desktop button tests/package registration, and docs changed; no temporary patch workflow/helper remains.

- [ ] **Step 4: Fast-forward `main` and verify Pages deploy**

Only after all checks pass, fast-forward `main` to the feature branch head and wait for GitHub Pages build + deploy to complete successfully.
