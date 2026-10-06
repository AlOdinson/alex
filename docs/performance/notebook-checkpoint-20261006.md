# Cold notebook checkpoint preparation

Base: c06bb415f71c27c0a508003978643cf74cff362c, tree96724b78.
Approved no-video items1/11 continuation, not completion of all initial-load work.
Experimental branch only. No main, deployment, video, transport or schema changes.

## Implemented contract

Cold Board controller acquisition now prepares its checkpoint between bounded
chunks of graph and index work. Hidden pages remain serialized. A generator walks
record properties without allocating a full Object.values list, certifies deep
immutability through the existing private WeakSet, builds the identical balanced
board layout, and imports deletions through the existing persistent AVL map.
The scheduler checks its existing 4ms/32-unit budget between chunks of at most128
traversal steps. A property access, native Object.freeze or tree insertion is still
indivisible; this is cooperative scheduling, not a hard frame-time guarantee.

The existing teacher/student runtime getters return a detached native clone.
Cold preparation explicitly takes ownership of that fresh value; the session no
longer deep-clones the whole checkpoint AGAIN. Only a token certified in a private
WeakMap skips that old boundary. Serialized flags, shallow freezes and cloned
tokens cannot certify an external caller. Default preparation of arbitrary mutable
input still captures it synchronously with structuredClone before yielding, so a
caller changing its input after invocation cannot create a mixed-time checkpoint.

The preparation has no live controller, outbox publication or partial paint side
effect. Cancellation/lifetime checks between batches stop obsolete preparation.
The Board's currentness guard now includes the realtime runtime identity. Only a
complete, current checkpoint is used to construct the ordinary controller.

Commits can arrive during the new task boundaries. Cold acquisition compares the
runtime revision after preparing a draft and retries with a new snapshot. After
three changed drafts it uses the original synchronous construction boundary to
avoid endless retries. Board checks revision AGAIN immediately after its await,
before construction, to close the final microtask handoff window. These fallbacks
preserve liveness and correctness; continuous traffic may still incur a full cold
synchronous preparation. No action is silently dropped, merged or reassigned.

Live rebase remains on its previous synchronous checkpoint boundary; the earlier
cooperative pending replay is unchanged. This increment does not widen live full-
scene replacement or applyingRemote windows. Existing initial scene admission,
lease guards, conditional history, durable identities and save-before-send remain.

## Tests and evidence at delivery

The actual extracted Board cold acquisition initially failed the ordering probe:
no queued task ran during freeze/index construction before controller installation.
The revised acquisition passes task interleaving, a commit during preparation,
close/runtime replacement, and a final-await handoff regression (also verified
RED by temporarily removing its fence). Helper tests cover external mutation,
canonical contents, private certification, cancellation, cycles, bounded busy
fallback, independent sessions, guarded operations/deletions/inverses and duplicate
or missing IDs. The original twelve target tests and startup/recovery42 passed; the final
compatibility regression below raises the target count to thirteen. Notebook254
and all25 selected commands pass on that final source.

All25 selected local verify/connection/menu/build commands pass. One extra known
legacy test:capacity-cleanup still expects a direct duplicate_board_v8 RPC in the
unchanged delegating adapter; that command remains red, not disabled. A broad
local startup glob accidentally invoked the native browser script and failed to
import unavailable playwright-core; no local browser success is claimed.

The native startup gate now observes the actual checkpoint helper during the
first real UI stroke on a1201-object/six-page lesson. It requires a task before
preparation completes, owned snapshot reuse, durable flush and retention after
reload. No gate holds the scheduler or replaces product state/input. Read CI for
the final SHA before claiming Chromium/WebKit success. Existing native gates stay.

## Explicit limitations and rulings

- The FIRST runtime snapshot/tombstone export still makes native copies and may
  block. This removes the second session copy, not every full snapshot export.
- Initial persisted-intent construction, controller's full-layout diff, cold
  registry/cache seeding, final Canvas installation and individual huge operations
  are not made cooperative here. Prewarming before first input is not added.
- Live checkpoint preparation is deliberately unchanged in this increment; changing
  it requires a separate model/paint completion and input contract.
- Under continuous revision changes, or a commit in the final await handoff, the
  exact synchronous compatibility path remains rather than risking stale content.
- More task boundaries/AVL insertions may increase total setup time. Ordering
  probes are not browser/Pencil latency, total-RAM or universal speed claims.
- Owned mode requires exclusive ownership of the runtime's freshly isolated value;
  default external preparation preserves the original native-copy isolation.
- Author self-review only. Independent whole-branch review, long two-user lessons
  and physical iPad/Apple Pencil acceptance remain outstanding.

## Compatible older reader regression

The schema-compatible recovery gate intentionally uses older drawing/record code
with the new storage adapter. Self-review reproduced a named-import failure in
that exact combination before integration. The deletion index now relies only on
the older stable record exports. Cold preparation already certifies its values
in slices, so this does not add a second deep traversal on the new path. A direct
non-prepared caller retains an indivisible clone/freeze of each small deletion
record. The new regression imports the actual index against pinned 52a65f38 record
utilities and checks preserved values and nested isolation. Thirteen target tests
now pass; this keeps the existing browser recovery gate unchanged.
