# Scoped Lesson Freeze Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Fix only chat findings 1 (media rendering), 2 (thumbnails), 4 (Pencil ownership).

**Architecture:** Keep Fabric and existing transport. Cache static media layers for frame presentation; schedule thumbnail work on content/viewport changes after input; guard the existing stylus end bridge.

**Tech Stack:** React 19, Fabric 7.4, JavaScript, Node tests, Vite, GitHub Pages.

**Spec:** docs/superpowers/specs/2026-09-30-scoped-freeze-fixes.md

## Global Constraints

- Do not change hidden game gestures, sync/replay/queues, history/retention or unrelated Cloud/network logic.
- No new servers/TURN, live Ably fallback, full periodic sync, compaction or dependency upgrades.
- Preserve quality modes, stacking, drawing, sharp white thumbnails and final-preview persistence.
- No changes to production data. Only root handles publication/versioning.
- Tests must exercise actual code; scripts with source-only assertions aren't proof for new behavior.

## Review Focus

- Palm ends while stylus remains: task 1 tests both bridge modes and asserts no fabricated end/reset.
- Missing native pointerup but real matching touchend: task 1 verifies one valid end and cancellation.
- Navigation while preview capture/write is pending: task 2 tests final image ordering and bounded queue.
- Notes and eraser masks above/below media, with pan/zoom: task 3 tests pixel equivalence versus full Fabric rendering.
- Screen outside viewport, hidden document, resize, stop/restart: task 3 verifies skip/resume/cleanup without old pixels.

### Task 1: Preserve Pencil contact on unrelated touch endings

**Files:** Modify src/components/Board.jsx only near finishStylusTouchFallback; create scripts/test-pencil-touch-end-ownership.mjs. If a small test utility is necessary keep it under scripts.

**Interfaces:** Preserve existing function/call signature. Production source extraction used by audit at /workspace/scratch/329b4426d7ce/input-ui-audit/reproduce-input-state.mjs is available as a starting point, but assert behavior, not source text. No changes to other contact state machines.

- [x] Write failing regressions executing actual function and identity helpers for native/synthetic: changed finger99 while stylus42 remains => no claim, no pointerup/reset, no rejected ID; real changed stylus42 => valid pointerup; matching cancel => pointercancel; native pointerup already closed => no duplicate; genuine missing changed-contact recovery remains valid when tracked stylus absent.
- [x] Run node --test scripts/test-pencil-touch-end-ownership.mjs and confirm palm-release failure before editing production.
- [x] Add minimal ownership guard to finishStylusTouchFallback.
- [x] Run the new file and npm run test:pencil. Record any baseline/unsupported-environment limitation by name.
- [x] Commit and self-review only this task. Write task report with RED/GREEN evidence.

### Task 2: Defer thumbnail work and exclude media-only changes

**Files:** Modify src/lib/boardThumbnail.js, scripts/test-board-thumbnail.mjs; Board.jsx integration near installBoardThumbnail only if required. Keep boardThumbnailStore API unchanged.

**Interfaces:** installBoardThumbnail({canvas,save,window,document}) retains disposer/flush behavior for callers; optional injected capture/idle hooks are allowed only if used by production. captureBoardThumbnail compatibility can be preserved; production async capture should draw content once and then encode JPEG through toBlob (fallback only where missing), returning data URL for existing storage. New focused module allowed for a single clear responsibility.

- [x] Write behavioral failing tests: repeated video-only after:render does not schedule captures; real object/viewport change yields preview after quiet; pointer/touch held defers without starvation on release; leaving board flushes newest frame while another encode/save awaits; white sharp output and existing final A/B ordering preserved.
- [x] Run focused tests RED and record expected failure.
- [x] Implement event-based dirty tracking with viewport-signature fallback on after:render, input-aware scheduling, serialized async capture+save, and screen-share exclusion. Changes while in-flight must not be lost. Rendering at exit is allowed; don't defer navigation indefinitely.
- [x] Run node --test scripts/test-board-thumbnail.mjs and npm run test:menu; test encoding actual pixel output where Node Canvas is available. No unrelated Home/storage changes.
- [x] Commit and self-review. Report RED/GREEN evidence, timers/listeners cleanup, queue bound.

### Task 3: Separate video-frame presentation from static scene geometry

**Files:** Modify src/lib/boardScreenShare.js; create src/lib/boardScreenShareCompositor.js (or equivalently focused single module); new scripts/test-board-screen-share-compositor.mjs and focused frame-loop regressions. Board.jsx only for a narrowly needed integration callback/event; no unrelated edits.

**Interfaces:** Existing createBoardScreenShareMedia return API remains compatible. Compositor owns its cache and disposal; may attach to Fabric before/after render and media render boundary. Normal scene renders rebuild cached static layers; media-only frame updates composite cached pixels plus video without rerendering static paths. No second transport/media capture. Preserve native staging frameCanvas full dimensions.

- [x] Write failing real-Fabric tests: static path render calls stay unchanged across repeated video-only presentations; final pixels match normal renderer with static objects below and above video at multiple viewport transforms; invalidation on object/viewport/media size changes; hidden/offscreen frames do no copy/render work and resume; selection/unsupported blending falls back safely; disposal releases hooks/caches.
- [x] Run focused tests RED before production change.
- [x] Implement focused cached compositor. For correct z-order, cache under/above layer or equivalent clipped media-region composite. If using a foreground bitmap, non-source-over blend operations must either be represented correctly or use ordinary render fallback; never silently drop eraser effects. Controls/top-canvas brush previews must remain correct. Coalesce latest video frame, don't queue frames. Cache invalidation must include pending full renders and scene edits.
- [x] Gate hidden/offscreen work; setCoords only for actual geometry changes; ensure full-frame staging/capture quality and host/viewer controls still work.
- [x] Run new tests, npm run test:screen-share, existing board-screen-share object/integration/full-frame-release scripts; compare actual Fabric pixel buffers and operation counts. No new generic instrumentation UI.
- [x] Commit and self-review. Report correctness fallbacks and measured draw-call reduction.

## Integration and publication (root)

- Review each task against its brief, then broad whole-branch review.
- Integrate new regressions into existing appropriate test commands; bump patch version after checks.
- Run deployment verification: test:connections, test:browser-authority, test:sync:ci, test:screen-share, build. Resolve scoped failures; report unrelated baseline failures without hiding them.
- Publish a reviewed commit through GitHub and verify main deployment; no new hosting provider.
