# Cooperative notebook session recovery

Base: `7bf468e74ab0819d4428c2b786033678c46966d8` (exact tree
`fb637d24894bd43913b51c47f99b32f70560f961`). Approved no-video item 6
continuation. Not a release, full-plan completion, or main deployment.

## Implementation and interfaces

The Board controller opts its session into cooperative recovery. Direct legacy
session callers retain the synchronous default; queues of at most 32 pending
intents without an active recovery retain the immediate path. Large pending
replays and bursts of more than 32 buffered revisions use the existing 4 ms / 32
unit task budget BETWEEN indivisible operations. This is not preemption.

Confirmed state and the previous coherent optimistic view remain distinct.
Reconstruction uses private preview metadata, not partially mutated live entries.
New enqueues still immediately update the visible optimistic view and save their
unchanged identities/conditions through the original ordered outbox. They extend
the replay tail rather than invalidating its whole prefix. Rejection, replacement
of the pending list, or a new checkpoint invalidates the private draft. Ordinary
commit arrivals are buffered until the next complete replay boundary, avoiding a
restart for every incoming packet. A continuous stream can expose successive
WHOLE coherent prefixes, never a partially replayed page.

Only a complete current draft installs its snapshot and preview/blocked metadata.
No durable action is dropped/merged. Publication waits while the replay owns the
model; after installation it rechecks the existing lease/save/order conditions.
Already in-flight acknowledgements can be admitted during the computation.
Confirmed revisions advance only contiguously and after an operation succeeds.
Flush includes recovery, not just pending/outbox counts. Previously blocked parent
metadata is not used to reject flush while replacement metadata is being rebuilt.
Disposal rejects recovery observers promptly and retains all unresolved intents.
Errors preserve the previous view, pause transmission and surface to the existing
error/retry path; no recovery error is silently converted into success.

`whenReconciled()` is the explicit model completion barrier. Controller
`whenPainted()` waits for it and then for projection. Board's snapshot and refresh
callbacks now await `rebaseAsync()` and recheck their owner/lifetime before using
the recovered state. The synchronous legacy rebase entry is retained for old
callers and tests, but production snapshot consumers no longer assume immediate
large recovery. Deferred nonmanaged commits retain their paint suppression, while
new local input/managed changes and new checkpoints cannot inherit stale suppression.
Addressed settled-action events retire restored pending-object markers without
cloning/exporting the pending queue on every acknowledgement.

## Verification at creation of this change

Baseline core notebook suite: 254/254. New regressions first demonstrated the
128-intent synchronous checkpoint and 128-revision burst starvation. Fifteen
new tests cover live input/conditional undo, interleaved commits/rejections,
replacement checkpoints, parent loss/return, durable identities, flush, disposal,
nonmanaged projection, restored markers and the REAL extracted Board snapshot
callback. Reverting the Board await reproduces loading the pre-recovery snapshot.
The stale-blocked flush and retained acknowledged marker failures were reproduced
before fixing them. Five shared browser/model cases run locally too.

Local verification commands and logs are in the accompanying evidence archive.
Project notebook, Pencil, sync, authority, storage, reading, media, screen-share,
connections, menu and build pass. `test:capacity-cleanup` is still red: its old
assertion expects a direct `duplicate_board_v8` RPC in boardRepository.js, which
already delegates in the exact base. The adapter is byte-identical; this change
neither alters nor disables that test. Existing build warnings remain.

Native test: five model/order cases and real Board pointer writing while recovery
is suspended at an ACTUAL task boundary. A test-only wrapper holds that boundary
until the native pointer completes; it does not bypass editing, persistence or
confirmation. The test then releases recovery, verifies convergence, flushes the
real authority/outbox, and exercises UI undo/redo. This establishes interleaving
and correctness, NOT physical pen latency or wall-clock speed. No test hook is
imported by production. Native results must be read for the delivered SHA before
claiming success; local browser navigation is administrator-blocked.

## Limits and review decisions

- Initial full checkpoint cloning/index construction, constructor-time import of
  persisted intents and one indivisible large operation may still block. First
  load remains a separate approved plan item; no claim that all recovery is O(1).
- Private replay can restart after an actual state conflict/checkpoint; only
  append-only input and buffered ordinary commits avoid needless restarts.
- The UI may show its earlier coherent optimistic state until a draft completes;
  new operations still carry the actually observed base revision at enqueue.
  Their immutable source and conditional inverse are not rewritten retroactively.
- Transmission temporarily waits for consistent replay metadata; local input does
  not. No new permission is granted and pending queue/byte limits remain unchanged.
- Native clone/apply, full structural reducers, export, final Fabric installation,
  zoom/cache/startup work, legacy split cases and partial-eraser geometry remain.
- Author self-review only, no independent branch review or physical iPad/Pencil
  acceptance. Only the experimental branch is updated; main/video/wire/schema,
  server/TURN/signaling, snapshot compaction and quality settings are untouched.
