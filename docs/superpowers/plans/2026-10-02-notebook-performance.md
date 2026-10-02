# Notebook Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make notebook writing responsive as pages accumulate, including while receiving screen sharing.

**Architecture:** Incremental child operations replace full-notebook edits; current-page hydration and rendering become linear and cacheable. Existing authority, ordered journal, locks and compound undo remain the consistency boundary. Ship backward-compatible rendering work first; activate the protocol change only after every reader/writer supports it.

**Tech Stack:** React, Fabric 7.4, IndexedDB, current WebRTC browser-authority protocol, Chromium/WebKit.

**Spec:** docs/superpowers/specs/2026-10-02-notebook-performance.md

## Global Constraints

- Preserve every behavior and acceptance target in the spec, including exact clipping, text undo, unlimited pages and media cleanup.
- No new servers, TURN, periodic full-board scans or scheduled snapshot compaction.
- Preserve screen-share resolution/FPS settings and crisp text/ink at zoom.
- Do not globally refactor Board.jsx; extract only notebook transaction and page-rendering responsibilities.
- Implement on an isolated branch, based on a fresh checked-out main; do not deploy planning documents as an implementation.
- Performance numbers are release targets; report observed results rather than promising a fixed whole-application speedup.

## Review Focus

- A page flip or notebook deletion during asynchronous image preparation cannot attach content to the wrong page (Tasks 3, 5).
- Undo after another participant edits the outside fragment cannot partially undo a split (Tasks 3, 5).
- A reconnect/reload with pending edits or an older client cannot lose or duplicate notebook content (Tasks 4, 5).
- A cached page with an eraser, image transparency or content in front of/behind video must remain pixel-correct (Tasks 2, 6, 7).
- Hidden pages, clipboard entries and undo references must retain assets until their final required reference is gone (Tasks 4, 7).

## File responsibilities

Existing core: src/lib/boardNotebook.js (Fabric frame/current page), src/components/Board.jsx (integration), src/lib/operationProtocol.js (validation/IDs), src/lib/authorityOperationEvaluator.js (conditions), src/lib/authoritySnapshot.js (state application), src/lib/historyOperations.js (inverse generation).

New modules: notebookOperations.js (child-op types/model application/inverses), notebookSession.js (ordered local edits and pending state), notebookRenderCache.js (bounded page surfaces), notebookAssets.js (immutable image serialization and references). Keep each independent of React where possible.

Existing persistence/compatibility: browserBoardAuthority.js, browserAuthorityStore.js, browserReplicaStore.js, studentOfflineCache.js, teacherPeerHub.js, studentPeerSession.js, boundedVerificationState.js, boundedVerificationDigest.js, boundedVerificationProtocol.js, imageStorage.js and mediaAssetStore.js. The implementer must inventory all operation-type switches and readers before enabling the new operation, including Board's own affected-ID helper and live protocol adapters.

Existing video: src/lib/boardScreenShareCompositor.js and src/lib/boardScreenShare.js. The actual video decoder/transport remains unchanged unless measurements identify a separate defect.

### Task 1: Reproducible performance fixture and counters

**Files:** Create scripts/benchmark-notebook-performance.mjs and scripts/notebook-performance-fixture.js; extend package.json with test:notebook:performance.

**Interfaces:** Produces JSON {environment,scenario,strokePreparationP50Ms,strokePreparationP95Ms,forwardBytes,inverseBytes,childSerializationVisits,pageHydrations,fullSceneRenders,cacheBytes,pendingActions,convergence}.

- [ ] Add fixtures: 1/6/12/20 pages x 100 and 300 strokes, 40 points per stroke; one image-heavy variant; warmup then five measured repeats.
- [ ] Assert the structural spec gates first. Run `npm run test:notebook:performance`; expect current code to FAIL hidden-page, packet-size and hydration gates with saved baseline JSON.
- [ ] Add browser frame tests both with a synthetic compositor and a real captured test-canvas MediaStream over the existing peer connection. Distinguish codec/transport time from notebook main-thread work; do not call a synthetic frame test real screen sharing.
- [ ] Record browser/device/DPR/video settings with each result. Verify instrumentation is opt-in and absent from the normal production hot path.
- [ ] Commit fixture and reproducible baseline, without claiming target performance yet.

### Task 2: Linear page hydration and side-effect-free reads — Release A

**Files:** Modify src/lib/boardNotebook.js and Board.jsx; create src/lib/notebookRenderCache.js; extend scripts/test-board-notebook.mjs and create scripts/test-notebook-cache.mjs.

**Interfaces:** `replacePageObjects(objects: FabricObject[]): void`; `invalidatePageContent(): void`; `serializeNotebookForSnapshot(): SerializedNotebook`. `createNotebookRenderCache({maxNotebookBytes:33554432,maxBoardBytes:67108864})` returns acquire/invalidate/release/dispose/bytesUsed.

- [ ] Add tests: hydrating 600 children visits at most 1200 child records; serializing an unchanged notebook does not set dirty; repeated reads do not serialize hidden pages again unless an explicit full snapshot is requested.
- [ ] Run `node --test scripts/test-board-notebook.mjs scripts/test-notebook-cache.mjs`; expect the new assertions to fail on 1.42.0.
- [ ] Batch group hydration with one layout/sync at the end. Track explicit content invalidation separately from view transforms. Keep immutable serialized child records until the child changes; invalidate every supported mutation path. A retained before-record must remain byte-identical after any later child edit; assert this explicitly to prevent shared-reference history corruption.
- [ ] Implement bounded current-page caching and zoom/DPR-aware regeneration. Keep high-quality final rendering; do not accumulate caches for visited hidden pages. Reading/selection must not invalidate content pixels.
- [ ] Run notebook tests plus existing PDF continuity and screen-share compositor tests. Expect identical pixels, clipping and text edit behavior; linear hydration and bounded cache bytes.
- [ ] Commit. This stage can ship independently with the old data format, but must not be described as solving the all-pages transaction cost.

### Task 3: Notebook child operations and compact, atomic inverses

**Files:** Create src/lib/notebookOperations.js; modify operationProtocol.js, authorityOperationEvaluator.js, authoritySnapshot.js, historyOperations.js; create scripts/test-notebook-operations.mjs.

**Interfaces:** `isNotebookOperation(op): boolean`; `applyNotebookOperation(notebook,op): {changed,changedChildIds,pageNumber}`; `evaluateNotebookOperation(notebook,op,tombstones): {appliedChanges: Change[], skippedConflicts: Conflict[], changed: boolean}`; `invertNotebookOperation(before,appliedOp,{clientId,mutationId}): Operation[]`. Operation/change fields are fixed by the spec; Conflict is {childId,reason,fields?}. No whole notebook clone in these helpers.

- [ ] Test one child insertion on page 20: no visits to pages 1–19; forward/inverse <=16 KiB; whole-text edits remain text; deletes/restores guard child identity and deletion mutation; duplicate action IDs are idempotent.
- [ ] Test split groups containing both notebook child changes and board-fragment changes. Any conflicting member rejects the entire group; successful undo/redo touches only the affected children. Test dependent operations against a staged group state.
- [ ] Run `node --test scripts/test-notebook-operations.mjs scripts/test-notebook-history.mjs`; expect missing-operation failures.
- [ ] Implement versioned changes, parent-ID authorization/locking, conditional preflight and exact inverses. Avoid prepareAuthoritativeHistory's current clone of an entire affected notebook; copy only changed child data. Keep regular board operations behavior unchanged.
- [ ] Run new tests and `npm run test:browser-authority`; expect all existing conditional-history semantics to pass and notebook payload independent of hidden-page count.
- [ ] Commit behind a disabled capability gate. No new wire operation may be emitted before Task 4 completes.

### Task 4: Every reader/writer, compatibility and storage hot paths

**Files:** Modify browserBoardAuthority.js, browserAuthorityStore.js, browserReplicaStore.js, studentOfflineCache.js, teacherPeerHub.js, studentPeerSession.js, boundedVerificationState.js/digest.js/protocol.js and all operation consumers identified in the inventory. Create scripts/test-notebook-protocol-compat.mjs and scripts/test-notebook-storage.mjs.

**Interfaces:** Negotiate `notebookVersion:1`; expose `supportsNotebookOperations(peer): boolean`. A versioned notebook verification digest caches child/page hashes and updates the affected branch only; advertise its version so old and new fingerprints cannot be compared as equivalent.

- [ ] Test legacy notebook load, journal replay, student offline replay, duplicate delivery, reconnect and unsupported-peer behavior. A rejected migration leaves the original stored board recoverable.
- [ ] Test commit storage counts: ordinary notebook edits do not clone/rewrite the notebook or re-encode an unchanged baseline snapshot. Current boards.put(nextBoard) embeds the old snapshot; separate immutable baseline payload from mutable metadata if this path carries a large baseline.
- [ ] Test that one child change updates only its verification branch; preserve cancellation, bounded work scheduling and the existing revision fence. Any peer repair must distinguish notebook frame metadata from page content.
- [ ] Run `node --test scripts/test-notebook-protocol-compat.mjs scripts/test-notebook-storage.mjs`; expect unsupported-op/compatibility assertions to fail before implementation.
- [ ] Implement the new operation in transport validation, authority, replica replay, recovery, ID extraction, asset-reference traversal and offline storage. Use existing durable transactions; do not add periodic snapshot work. Keep full legacy checkpoint read support.
- [ ] Run browser-authority, student-storage and bounded-verification suites. Expect teacher/student/offline state equality and explicit safe behavior with an old writer; no silently discarded operation.
- [ ] Commit; keep activation disabled until Task 5's local pending-state behavior passes.

### Task 5: Incremental live page updates and responsive local input — Release B

**Files:** Create src/lib/notebookSession.js; modify Board.jsx and boardNotebook.js; extend scripts/test-notebook-browser.mjs and test-notebook-lease.mjs; create scripts/test-notebook-session.mjs.

**Interfaces:** `createNotebookSession({confirmedState,publish,onChange})` returns `enqueue(op)`, `ack(result)`, `reject(result)`, `rebase(confirmedState)`, `flush()`, `pendingCount()` and `dispose()`. `applyPageDeltaToFabric(notebook,op): Promise<void>` changes/revives only affected visible children; hidden-page ops do not enliven Fabric objects.

- [ ] Test 300 rapid strokes with delayed/out-of-order acknowledgements, rejection in the middle, undo before ack, page change, parent deletion, lease loss and reconnect. Require no lost/duplicated input and the same final authoritative state.
- [ ] Test that an incoming one-stroke operation never invokes full BoardNotebook.fromObject and never touches other page children. Page switching reuses existing serialized state without rewriting it as an edit.
- [ ] Run `node --test scripts/test-notebook-session.mjs scripts/test-notebook-lease.mjs`; expect new-session functionality to fail initially.
- [ ] Move notebook edit orchestration out of the giant Board callback into the session adapter. Capture target page at gesture start. Apply prepared local changes immediately under the valid parent lease and journal immutable intents in order; network acknowledgement must not block the next stroke's visible preview.
- [ ] Keep committed + pending state separate; rejection rebases pending operations instead of reverting the whole notebook. Coalesce only transient previews or superseded transforms, never independent strokes. Apply backpressure without an unbounded in-memory queue.
- [ ] Run notebook browser tests, teacher/student history and performance gates. Expect <=16 KiB operations, <=5% payload growth across page counts, and unchanged atomic split undo. Enable negotiated notebook operations only when the entire path passes.
- [ ] Commit and prepare Release B; retain explicit old-client compatibility behavior from Task 4.

### Task 6: Screen-share fast path with notebook selection and erasing

**Files:** Modify boardScreenShareCompositor.js, boardScreenShare.js and notebookRenderCache.js; extend scripts/test-board-screen-share-compositor.mjs; create scripts/test-notebook-screen-share-browser.mjs.

**Interfaces:** The compositor distinguishes content invalidation, selection-overlay invalidation and video-only presentation. The notebook exposes whether its internal compositing is isolated in its own cached surface; never assume every destination-out object is safe globally.

- [ ] Add failing tests: 60 video-only presentations with a stationary selected notebook produce zero extra full-scene geometry renders; controls remain visible; isolated notebook erasing retains fast presentation without changing pixels.
- [ ] Add pixel comparisons for transparent images, notebook before/after video in z-order, outside eraser fragments, zoom/pan, selection movement, DPR changes and frame resize. Unsafe board-wide compositing must retain a correct fallback.
- [ ] Run `node --test scripts/test-board-screen-share-compositor.mjs` and `node scripts/test-notebook-screen-share-browser.mjs`; expect selected/isolated-eraser fast-path assertions to fail first.
- [ ] Separate static notebook pixels, transient brush/selection overlay and video repaint. Rebuild affected scene caches on actual geometry/content changes; video-only frames must not serialize pages or draw notebook paths again.
- [ ] Run Chromium/WebKit with real received test video at both configured modes. Expect frame-loop correctness, no lost overlays, no extra full scene renders for stationary selection and no forced quality downgrade.
- [ ] Commit; this task can ship independently once Task 2's cache interfaces are stable.

### Task 7: Images and rasterized text without repeated encoding — Release C

**Files:** Create src/lib/notebookAssets.js; modify boardNotebook.js, imageStorage.js and existing asset/clipboard/export adapters only where required; create scripts/test-notebook-assets.mjs.

**Interfaces:** `getImmutableNotebookImageSource(image): ImageSourceRef` (union {kind:'inline',src:string} or {kind:'asset',assetId:string,mime:string,width:number,height:number}); `retainNotebookAsset(ref,owner)` / `releaseNotebookAsset(ref,owner)`. Source refs reuse the existing content-addressed asset identity; they are not board-local duplicate files. Owners include page/board and still-reachable clipboard/history/pending entries.

- [ ] Test that rasterized text encodes once, not on every later stroke/read. Drawing 100 strokes beside a static image must perform zero additional image encodes or hidden-page image decodes.
- [ ] Test whole/cut image undo, copying notebooks across boards, offline reopen, missing asset retry, and deleting one versus all referencing boards. Releasing page render caches must not delete durable assets needed by history or other boards.
- [ ] Run `node --test scripts/test-notebook-assets.mjs`; expect current repeated-canvas-encoding assertions to fail.
- [ ] Cache immutable source data and pass short existing asset refs where supported. Extend the shared image asset path only if needed; do not invent a second deduplication store. Include format migration/export expansion in the same change if refs replace inline sources.
- [ ] Run student-storage, media, export and notebook browser tests. Expect one durable asset per content identity and unchanged visual output/lifecycle behavior.
- [ ] Commit, preserving ordinary image/PDF/GIF handling outside notebooks.

### Task 8: Soak, review and staged release

**Files:** Performance/browser test scripts, package.json, .github/workflows/main.yml, release notes/version metadata.

**Interfaces:** Produces before/after JSON and a concise human report per browser/device, including failed targets and manual device tests not yet run.

- [ ] Run 20 pages x 300 strokes and an image-heavy variant; then 300 rapid strokes while receiving 1080p/60 and 720p/60 video. Exercise both teacher and student as writer, page switches, undo/redo, offline reconnect, copy, delete and reload.
- [ ] Assert structural targets in CI. Record p50/p95 and long tasks on stable reference hardware; do not use volatile shared-runner wall time as the only pass/fail gate.
- [ ] Run `npm run test:notebook`, browser notebook/media/PDF continuity tests, browser-authority, student-storage, sync CI and screen-share suites, followed by production build. Require Chromium and WebKit success.
- [ ] Conduct a fresh whole-change review with the five Review Focus cases. Fix demonstrated correctness/performance regressions and rerun affected tests plus the required release suite.
- [ ] Publish stages A/B/C separately as their gates pass. Keep migration compatibility explicit; a code rollback must preserve the ability to read already-created child-operation journals/assets.
- [ ] Verify deployed version and repeat the user scenario on physical iPad/iPhone when access is available. Do not claim physical-device verification from desktop WebKit alone.

## Self-review

Covered: page growth, hydration, dirty-cache reads, history, local queue, real video compositing, image encoding, compatibility, durable/offline replay and shared asset lifetime. No implementation or release occurs as part of preparing this plan. The highest-risk stage is Task 3–5 as one coordinated protocol rollout; Task 2 is the smallest independently releasable improvement. Recommended execution order: 1 → 2 → 6 (Release A), then 3 → 4 → 5 (Release B), then 7 (Release C); apply Task 8 verification/release gates at each release boundary, not only after all code exists.
