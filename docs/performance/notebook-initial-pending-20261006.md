# Cooperative cold durable-intent restore

Base: `4f8539d0a67fbf6eac7c98e2cb6fb1991a0c082c` (tree `b7e7cf2989a6018c0779a343748f95963016acb1`).
Approved no-video startup/queue continuation. Experimental branch only; not a production deployment or full-plan completion.

## Implemented contract

The Board no longer feeds the entire IndexedDB notebook outbox through the synchronous `createNotebookSession` constructor on cold acquisition. It creates the controller with an empty restored queue, then restores durable intents through `restoreInitialPendingActions` before publishing the controller reference.

Session restoration reuses the existing normalize/preflight/history code one complete action at a time and yields through the existing 4 ms / 32-unit work-slice budget between actions. Restored actions remain already-durable: they are not re-saved and are never removed from the outbox merely because preparation is cancelled. The old synchronous `initialPendingActions` constructor path remains for existing direct callers/tests.

The restore is an explicit cold-only state. Ordinary enqueue cannot interleave into a partially restored prefix, and `flush()`/sender pumping cannot publish a partial prefix. Cancellation rolls back the private restored prefix to the confirmed model without deleting durable rows. Only after the complete restore does the controller install its pending-object ownership map and project the resulting coherent view once.

Because restoration can now span browser tasks, Board rechecks the realtime revision after it finishes. A changed revision is reconciled through the existing cooperative rebase. A second revision read closes the final await handoff; if another commit lands in that narrow window, the existing synchronous rebase boundary is retained as the liveness/correctness escape rather than installing stale state.

## Tests

Five new session/controller regressions were observed RED before fixes and now pass locally:
- 128 durable actions admit a browser task before the full replay completes and converge to the original synchronous oracle.
- Cancellation rolls back partial private work without outbox deletion.
- Controller pending-object ownership is restored cooperatively and projected once.
- Ordinary enqueue is rejected during the private cold restore instead of being inserted between old durable intents.
- A concurrent `flush()` cannot wake transmission and publish a partial durable prefix.

Two Board source-contract tests verify that the cold Board path opts into the cooperative restore before publishing the controller and retains both cooperative and final synchronous revision fences.

The native startup gate is extended to seed 96 real notebook outbox actions under the stable tab identity before opening the 1,201-object/six-page lesson. It observes the actual controller restore task boundary, then exercises the first real pointer stroke, durable flush and reload. Native CI is required before claiming Chromium/WebKit success.

Local environment note: network package installation is unavailable in this container, leaving `fabric/node` and `rolldown/experimental` absent. Tests not importing those packages run; full locked-dependency verification is delegated to the repository CI, as in prior blocks. The known unrelated `test:capacity-cleanup` issue remains unchanged.

## Measurement

A Node model probe with 384 simple restored notebook actions alternated seven synchronous and cooperative rounds. Median delay until a pre-scheduled browser-style task executed:
- synchronous constructor: ~75.2 ms
- cooperative restore: ~6.8 ms

Median total restore completion:
- synchronous constructor: ~75.1 ms
- cooperative restore: ~90.3 ms

This deliberately trades total completion time for earlier task admission. It is not a browser/Pencil latency measurement and excludes IndexedDB, networking, Fabric projection and the initial runtime snapshot export.

## Remaining limitations

- `outbox.list()` itself still reads/clones the durable rows before restore begins.
- The first runtime snapshot/tombstone export still performs native copies.
- One individual action/preflight/history calculation remains indivisible.
- The rare final revision race retains a synchronous rebase fallback.
- Generic structural/full-layout controller diffs, legacy masks/partial eraser geometry, long two-user lessons and physical iPad/Pencil acceptance remain.
- No video implementation, signaling, TURN/server, schema/wire, snapshot compaction, export quality or `main` changes are part of this increment.
