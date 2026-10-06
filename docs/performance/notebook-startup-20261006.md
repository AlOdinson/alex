# Bounded scene startup and transient maintenance

Base: `257973daf99249948928daee3267154484924d86`, verified exact source tree
`92d4928e25e5d2d45da53bb1d10ef7c84b95aec4`. Approved no-video plan items
1/11 continuation. Experimental branch only; NOT completion of every cold-load
cost, all remaining plan items, or a production deployment.

## Implemented

The actual Board initial canvas loader now hydrates top-level objects
through the same strict, bounded Fabric constructor helper as notebook children.
Partitioning ordinary image placeholders also yields between work slices. New
objects remain detached until every object and background/overlay/clip resource
is ready. Plain image sources retain their existing placeholders and independent
hydration; image positions are filled directly in original layer order instead
of repeatedly searching/reordering a growing live scene. Custom scene properties
and Fabric's canonical resource mapping are preserved.

Preparation failure does not replace the old scene with partial content. This
also corrects an observed baseline behavior: Fabric's default reviver silently
omitted a failed top-level child before replacing the canvas. Cancellation or a
newer loader invocation abandons old preparation and releases even late objects.
The actual Board disposal path cancels unfinished loading; initial post-load
handlers recheck the owner before touching UI, registries or revision state.
Render-on-add/remove is suppressed only during the final synchronous install and
is restored on every exit. No await is inserted halfway through that install.

The existing register/unregister/rebuild lifecycle now maintains a separate Set
of transient previews and selection proxies. The 1.5-second maintenance callback
iterates that set, never all permanent canvas objects to locate expired previews.
In-place finalized objects retire on re-registration or their next maintenance
visit. Remove and full registry rebuild clear membership. Original expiry ages,
local selection ownership and authoritative reconciliation for awaiting-commit
previews remain unchanged: no unconfirmed visible work is discarded by timeout.
Existing lock, session and reconciliation maintenance is NOT disabled.

Unexpired remote cursors now return the existing React state array on a maintenance
tick. Only a real expiration publishes a new array; unchanged cursors no longer
cause this periodic state update.

## Verification and test boundaries

Baseline `npm run test:notebook`: 254/254. Two loader regressions failed against
the actual previous Board function (all 96 constructors precede input; failing
child omitted) before implementation. Three maintenance regressions failed before
its changes (full scene enumeration, changed cursor-array identity, no separate
membership). They now pass. Extra cases cover exact pixels including background,
overlay and clip, interleaved image placeholders, superseding a delayed load,
explicit cancellation and late resource disposal.

Seven shared browser/Node cases include an old six-page notebook whose other
pages stay serialized. The native gate additionally opens a real lesson with
1,200 board objects and six notebook pages, observes an actual task boundary during
production loading, invokes the real maintenance callback, writes the first stroke
without prewarming its controller, flushes and reloads. It does not replace model,
permission, persistence or pointer handling with a fake. Read the results for the
final delivered SHA before claiming either browser passed.

All selected local CI verify commands, connections/menu and build pass. The known
unrelated `test:capacity-cleanup` assertion still expects a direct duplicate_board_v8
RPC in an unchanged delegating adapter; it fails on the exact base as well. No test
is disabled. Existing large-bundle/dynamic-import warnings remain. A local Chromium
CLI probe did not finish in this environment; no local browser success is claimed.

## Native pixel oracle investigation

The first WebKit gate failed at 20 one-unit color channels while serialized scenes
were identical. Diagnostics proved the CANONICAL first render changed on its next
render; the candidate did not change. Further canonical-to-canonical and
canonical-to-candidate controls were both exactly equal. Failure artifacts are
retained. No product color, geometry, image quality or tolerance was changed.
The oracle now verifies consecutive stable canonical frames, then compares the
candidate's FIRST frame to that reference with zero tolerance and asserts equal
serialized scene properties. This changes the reference preparation, not the
candidate's rendering or the equality threshold. Chromium passed the original
startup gate; final native results still must be read for the delivered commit.

## Live replacement isolation found during review

An actual Board callback regression showed that routing live full-scene replacement
through cooperative hydration widened an existing applyingRemote suppression window:
a new local add could arrive while commitAddedObject intentionally ignores remote
installation events. The regression failed before the final isolation and passes
after it. Bounded hydration is now used ONLY by the actual initial painter. The
previous live replacement loader is preserved byte-for-byte; cooperative session
reconciliation from the earlier increment is unchanged. A separate test proves
the real cold painter selects the bounded loader. The screen-media test checks
the two explicit entry points and retains both post-load reconciliation assertions.
This avoids extending the unsafe window; it is not a claim of solving every old
full-scene refresh race, and that caller still needs a dedicated input contract.

## Explicit limitations and decisions

- Cold authority/session checkpoint cloning, immutable index construction, initial
  replay, serialized cache seeding and some initial registry/spatial passes remain.
  This increment bounds scene CONSTRUCTION, not every initial-load computation.
- One constructor or nested group, native decode/encode, resource property access
  and final canvas installation remain indivisible. Task boundaries may increase
  total loading time while allowing other work sooner; no physical Pencil latency
  or universal reduction in load time is inferred from an ordering probe.
- The atomic-install claim means no asynchronous partial frames during normal
  installation. Arbitrary exceptions thrown by external synchronous Canvas event
  consumers are not a transactional rollback of the entire preexisting canvas.
- A future site that marks an already attached object transient must call the
  existing registerCanvasObject boundary. Every current true-flag creation site
  does so through its subsequent canvas.add or explicit registration.
- No video files/compositor changes, no new servers, no storage schema/wire changes,
  no new periodic snapshot/compaction, no source quality reduction, no main merge.
- Author self-review only. Independent whole-branch review, real long lessons and
  physical iPad/Apple Pencil acceptance remain outstanding.
