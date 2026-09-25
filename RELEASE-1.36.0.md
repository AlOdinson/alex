# Alex Board 1.36.0 — bounded verification for new boards

## Scope

Only boards explicitly created with `verificationVersion: 1` enable the additional checker. Existing/unmarked boards are neither migrated nor upgraded on edit/reopen. No backend, database-schema or application-dependency changes.

The checker observes confirmed drawing, transforms, property changes, deletion/eraser and undo/redo outcomes. It checks at most 100 object identities, prefers 80 changed/20 sampled, coalesces duplicate identities in a maximum 1000-ID queue, and uses a finite membership sweep after overflow. Scheduling uses 200ms debounce, 1000ms maximum postponement and at least 250ms between starts. One CPU lane and one outstanding verification request per peer are separate from durable acknowledgements and history.

No new periodic 5/30-second polls or request-timeout/retry policy were added. Existing transport recovery remains. New-board preview completion resumes the same bounded checker rather than starting the old targeted retry loop. Legacy boards retain that original path.

Repairs are restricted to compatible runtime/epoch/revision boundaries and are rechecked after asynchronous preparation. Active/local-pending gestures are protected. Presence/absence, layer order, duplicate/missing objects, canonical content and visible Fabric state are covered. A group move remains one history command regardless of verification batches.

## Corrections found during integration

- A shared serialized cache entry was mutating the saved pre-move history position. New boards now copy its small header before updating placement; long path arrays are not cloned. Reproduced failing tests for 1 and 300 objects, then verified undo/redo and a second immediate move.
- Live group previews are split into at most 100 objects and 48000 UTF-8 payload bytes. One sender retains only the newest pending preview, while durable operations and acknowledgements remain independent. Legacy preview envelopes are unchanged.
- Cooperative traversal avoids allocating/awaiting a resolved Promise for every coordinate; it yields an actual task when its budget is exhausted.
- New-board previews no longer start a competing legacy reconciliation retry queue. Legacy compatibility and late capability discovery are regression tested.

## Evidence

Candidate GitHub Actions run: `36107231047`.
Identical tested Git tree on Linux/Chromium and macOS/WebKit: `f53f867d6db85264719441f84a6b3f6c86972b53`.
Verified product sources published to feature commit: `00d68601eabd7da10a25086e882237ac5359f294` (temporary assembly helpers removed).

Both platforms passed 123 new deterministic tests, 260 existing authority tests, 30 screen tests, 18 storage tests, hosted-compatible sync checks and the production build.

Native browser scenarios passed on both engines: nine Fabric object types; workloads on boards of 100/1000/5000 objects with only 100 checked; old-format board edit/reopen staying disabled; same-revision wrong content correction; Canvas-only lost-delete ghost; missing model/Canvas object; 100 real strokes plus 30 undo and 30 redo with the queue drained; a real 300-object group move with one undo/redo plus deletion/restoration; new marker persistence after reload.

Chromium uses unchanged application ICE configuration. Hosted WebKit first failed to establish a direct peer connection; the successful WebKit collaboration run uses an authenticated loopback-only TURN relay in the test runner. WebRTC/DataChannel, React, Fabric, IndexedDB and application handlers remain native. The test relay is not included in application configuration and is not a claim that every real-world network is verified.

## Limits and honest interpretation

4ms is a cooperative traversal target, not a hard real-time limit on browser GC/JIT, task scheduling or Fabric rasterization. One first Chromium workload recorded a 50ms long task and 83.9ms heartbeat delay; the later 1000/5000-object workloads recorded no long tasks and approximately 2.3ms heartbeat delay. WebKit measured 2–16ms heartbeat delay and does not expose the same long-task observer. These are synthetic hosted measurements, not guarantees on the owner's iPad.

Physical iPad/iPhone/Apple Pencil checks were not run. Existing hosted sync CI skips its three pixel-Canvas-specific Node checks; the native checks above are reported separately rather than pretending those skipped tests passed. Local full dependency-based testing was unavailable because Fabric was not installed; the full suites were therefore executed on the hosted runners, not claimed as local successes. Existing npm lockfile/install warnings are unchanged.

Final merge and deployment must be confirmed from the pull request checks and Pages run; this document itself is not deployment evidence.
