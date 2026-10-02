# Notebook performance continuation — storage, protocol, queue and page adapter

## Release status

This is a **local, gated development continuation**, NOT a deployed release.
Base is production `f766f2207495d52576cfee6bb4e2b8e6605f2bf8` (1.42.1).
The previous Task 3 archive was restored and verified before this work.
The main application still uses its legacy notebook gesture callbacks. Do not
set the notebook capability to true just because the lower-level tests pass.

Task 4 core integration is implemented. Task 5's session, durable outbox, page
adapter and race fixes are implemented, but Task 5 UI/runtime integration is NOT
complete. Tasks 7/8 and actual browser/device release gates remain open.

## What was implemented in this continuation

- Immutable baseline snapshots are stored separately from mutable board metadata.
  An ordinary commit does not read or write the baseline snapshot. Child deletion
  guards occupy individual durable rows and survive reopen/undo. Schema upgrades
  are atomic; a forced migration failure preserves the old saved board.
- Explicit notebookVersion negotiation in teacher/student peer handlers. Old peers
  receive an update-required view-only notice, not unknown operations or a stale
  board masquerading as current. This notice is NOT a flattened-content view.
  Capability is reset on transport replacement; action payloads cannot negotiate
  themselves. Unsupported import and journal versions fail before data/head changes.
- Replica and offline replay understand the delta journal. Existing recursive
  image traversal is reused; nested image journals deduplicate across lessons and
  survive until the final reference is removed. No second asset store was added.
- Digest version 2 distinguishes notebook frame and page fingerprints. Registered,
  deeply immutable child/page data are cached; a changed page updates that branch.
  Targeted repairs carry only mismatching pages or frame fields. Revision fences,
  old-version rejection and independent visible-Fabric checks remain in place.
- `notebookSession.js` separates confirmed and pending state, previews immediately,
  saves ordered immutable intents before transmission and handles out-of-order
  acknowledgements, rejection, undo-before-ack, temporary storage/transport failure,
  lease loss, rebase, duplicate delivery and bounded backpressure. A missing parent
  blocks a split without creating an orphan outside fragment or dropping its intent.
- `browserAuthorityStore.createNotebookOutbox` persists pending actions separately
  from committed state. Scope is board+client; each identity is append-once. Stable
  order survives reload. A lost acknowledgement resends the same identity, so an
  already-committed stroke is not duplicated. Schema 3 upgrades intermediate v2
  databases as well as original v1 databases; old code must reload rather than write.
- `notebookPageRuntime.js` applies accepted operations only to affected visible
  children; hidden pages do not revive images. Page switches, local sibling edits,
  removal, disposal and delayed preparation cannot attach stale content to a wrong
  page. Latest navigation wins. Existing children and immutable records are retained.

## Current interfaces

`createNotebookSession({confirmedState,publish,onChange,onError,clientId,outbox,
initialPendingActions,canEdit,maxPending,maxPendingBytes,maxInFlight})`

`confirmedState` is `{snapshot,revision,tombstones?,notebookTombstones?}`.
`enqueue(operationOrAction)` returns `{actionId,inverseOps,durable,settled}`.
`durable` resolves after the outbox save; `settled` resolves/rejects on the authority
outcome. Preview is visible immediately and is not a claim that it is durable yet.
The returned session also exposes `ack`, `reject`, `rebase`, `pause`, `resume`,
`flush`, `exportPending`, `pendingCount`, `pendingBytes`, `getState`,
`getConfirmedState`, `dispose`. Disposing retains durable records and returns
unconfirmed intents; storage failure is reported rather than silently dropping them.

`createNotebookOutbox({boardId,clientId,maxPending,maxActionBytes})` exposes
`save`, `list`, `remove`, `clear`. Use a stable client identity on reopen. Do not
clear this outbox merely because a transport disconnected or a notebook was removed.

`applyPageDeltaToFabric(notebook,operation,{signal?})` is exported from
`boardNotebook.js`. It accepts committed/ordered operations, not arbitrary mixed
confirmed and optimistic histories. The session must decide the correct visible
state/order. Failure requires retry/reconciliation; never advance a visual revision
and pretend an operation was drawn when preparation failed.

`setNotebookPage` now fences obsolete loads, preserves existing content until the
new target is ready, and returns false if canceled/retired or repeatedly invalidated.

## Verified commands (fresh final runs, all exit 0)

- npm run test:notebook: **105/105**, no skips.
  Previous restored foundation had 43 tests. New tests include storage/import (9),
  protocol (8), integrity (10), session (17), outbox (7), page delta (11).
- npm run test:browser-authority: **347/347** in its main Node suite, plus existing
  preceding script checks. The name does not make these browser UI tests.
- node --test scripts/test-bounded-verification-*.mjs: **112/112**.
- npm run test:student:storage, test:connections, test:screen-share, test:sync:ci,
  test:media, test:pencil: all passed, including their existing standalone checks.
- npm run build: passed; existing chunk-size and mixed-import warnings remain.
- git diff --check: passed.

Core benchmark on this Linux/Node container (NOT end-to-end handwriting latency):
1/6/12/20 pages, each 300 strokes with 40 points, 75 measured repeats after warmup.
At 20 pages the operation is 736 bytes and the inverse 675 bytes. Structural
payload gates pass. The JSON report records environment, p50/p95 and exclusions.
Do not claim real-video FPS, iPad performance or a whole-app speedup from it.

The 300-stroke peer test uses the actual peer handlers and replica with an in-memory
transport. The 300-stroke session test reverses acknowledgements. The page adapter
uses real Fabric with Node-canvas and compares pixels (including transparency and
isolated erasing). None is a physical device or browser-screen-share test.

## Browser limitation

The notebook browser and received-video scripts could not start in this session:
`playwright-core` was absent from the restored environment. Installation of the
workflow's pinned dependency timed out. The prior session also encountered a local
browser navigation restriction. No alternate route was used to bypass that block.
No Chromium/WebKit UI, actual received-video or physical iPad/iPhone result is claimed.

The branch CI file is prepared but has not been published with these source changes.
Its existing browser scripts exercise the legacy UI until the new mode is wired and
explicit new-mode scenarios are added; a future green legacy browser run is not a
substitute for testing the new session path.

## Review and decisions

A separate author self-review was performed; no independent reviewer/subagent was
available. Demonstrated issues were reproduced with failing tests, then fixed and
followed by the complete listed suites: checkpoint handling for ordinary objects,
duplicate buffered commit delivery metadata, lock rejection versus successful noop,
ordered durable saves, immutable queued targets, and unsupported-version import.

Ruling: use a local isolated branch and a manual ledger because helper executables
are not mounted. Cost: no helper-generated completion record; actual commits, logs,
source hashes and a tested cumulative patch are the recovery record.
Ruling: split baseline and child tombstones in an atomic schema upgrade. Cost:
old IndexedDB writers fail closed and must reload; a failed upgrade keeps old data.
Ruling: use schema 3 for the outbox so an intermediate v2 checkout can also upgrade.
Cost: old code cannot silently downgrade that newer database. No asset format,
server, TURN, Ably live fallback, periodic scan or snapshot compaction is introduced.

Minor deferred: existing large production bundle and mixed import warnings; these
are outside the notebook change and were not hidden or described as fixed.

## Exact next implementation steps — do not restart the completed foundation

1. Inventory/wire Board.jsx `affectedOperationIds`, local/remote operation reducers,
   `applyOpsToSnapshot` compatibility and targeted reconciliation. Incoming deltas
   must call the page adapter, not revive/replace a whole notebook.
2. Thread the trusted enable flag and negotiated status through teacher/student
   runtimes, their networks and browserBoardSession. Keep the default off until
   every UI reader/writer and recovery path supports the format. Show an explicit
   unsupported-peer status; do not let an old writer silently change new journals.
3. Replace Board.jsx capture/text/erase/navigation full-record transactions with
   compact operations and the session adapter together. Current locations are
   around 8292–8514. Preserve parent/source leases and one atomic split with its
   outside fragment. Navigation remains outside editing history. Whole text stays
   editable, clipping rasterizes only when required. Do not wait on network ack
   inside the local input preparation queue.
4. Wire pending preview reconciliation, outbox reload (stable board/client scope),
   lease loss, page/parent deletion, late commits and undo/redo. The queue itself
   is tested, but these UI hooks must be proven against real drawing events.
   Avoid full `syncFromServer(true)` rollback that would erase later local intents.
5. Finish image-encoding/lifecycle checks and browser tests that explicitly enable
   the new mode. Soak: 20×300 strokes plus 300 rapid strokes, teacher and student as
   writer, real 720p60/1080p60 reception, page changes, split/text undo, reconnect,
   reload, copy/delete. Require Chromium and WebKit; report physical iPad separately.
6. Review the complete integration, run the listed suites/build and browser gates,
   then publish only through an authorized successful write path. A previous GitHub
   source-write request was safety-blocked; this session did not bypass or repeat it.

Do not call the whole optimization complete or bump/deploy a public version based
only on this artifact. Main remains at 1.42.1 until a separately verified rollout.
