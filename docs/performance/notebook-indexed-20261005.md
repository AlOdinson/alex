# Notebook indexed pipeline — continuation of the no-video plan

Base: `52a65f38badf74215568540297e71ba3ce7b8b0c` on `perf/notebook-no-video-20261005`.
Scope: an integrated fixed-top-level-order path for notebook child operations and retirement of an absent temporary source. This is NOT the complete indexed model for all board operations and NOT completion of the approved plan.

## Implementation

`indexedBoardModel.js` maintains a shared ID/rank map and persistent balanced record slots. Replacing an addressed frame copies only its tree path. Its snapshot wrapper materializes a conventional array only when a legacy/export/checkpoint consumer explicitly reads `canvas.objects`; normal state/revision/addressed reads do not do that. Internal input is owned and frozen at the load boundary; external checkpoint input is cloned before adoption.

`notebookIndexedTransaction.js` scopes unchanged canonical evaluation/history/reduction to the addressed notebook frames. Absolute top-level layer order is never simulated in the small scope: existing source deletion, board insertion/reordering/frame edits and unsafe old layouts use the original structural reducer. Child order, field guards, atomic rejection, source-retirement tombstones and undo inverses retain their old semantics.

The local session, serial browser authority, controller diff, commit bridge, Board projection/lease lookup, and bounded verifier use addressed reads. The verifier is not disabled. Plain snapshot consumers remain compatible. A structural transition deliberately materializes and reindexes the model; this remaining cost is not hidden as a constant-time operation.

## Local evidence

New structural tests first failed with 44 whole-board array operations in local enqueue, 17 during confirmation/controller/bridge, and 41 in serial authority at 5000 neighbors. They now count zero in those same paths. A further verifier regression first found five whole-board operations, then passed with zero after integration.

Differential cases cover accepted/rejected child actions, conditional fields/deletions, atomic group rollback, missing parents/pages, restoring a child, and 150 deterministic mixed child actions against the unchanged canonical reducer/history. Persistent-state tests cover ranks, retained old versions, unchanged object identity, ordinary JSON/structuredClone output, invalid rank rejection and legacy duplicate-ID precedence. Actual Board callback tests continue to check sender/receiver cached ink, durable confirmations and undo.

Latest local run: 54 new/previous optimization tests, 254 notebook tests, and 123 bounded-verification tests passed. Browser-authority, pencil, sync, storage, reading, media, connections and unchanged screen-share commands passed. Browser CI/build evidence must be checked for the delivered commit; local CPU measurements are not native-browser or physical-device results.

At 5000 neighboring short paths, the local Node model-only sample changed enqueue median from about 6.90ms to 0.19ms, and acknowledgement median from 1.63ms to 0.06ms (192 warm observations). Empty-board overhead did not improve. This excludes drawing, storage/network and long tombstone histories; it is not a claim of whole-app acceleration by the same factor.

## Browser verification

The workflow compares against the last verified `52a65f38` source, restores ALL `src` files for each baseline/candidate, runs three focused rounds with alternating order, and records synchronous controller enqueue/ack durations separately. The existing sequential 16-child-render assertion remains. A separate burst scenario does not wait for each paint; it checks that all 16 inputs persist and appear, and reports rendering counts without claiming the sequential append-only bound for a coalesced batch.

Native Chromium/Linux and WebKit/macOS, exact append pixels, existing notebook/PDF tests and received-video compatibility are required. No physical iPad/iPhone/Apple Pencil or independent review is implied.

## Remaining work

Page arrays still use their canonical child reducer and can be traversed. Tombstones are still copied in the owning session/authority/storage and IndexedDB has NOT migrated. Generic structural changes still rebuild the layout. Canvas-object membership/scans, frame scheduling, general dirty-region redraw, erasing, splitting workers, zoom-budget policy, cold startup and long-history persistence remain in the approved plan.

Screen-share code, resolution/FPS/bitrate, signaling, network protocols, stored formats and schema are unchanged. No merge or deployment to main in this increment. Author self-review only.
