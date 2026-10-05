# Persistent notebook page model — next no-video step

Base: verified `0e0b476265fc306a525b0e73b8167c978dda4f8b`. Implements the
next approved page-model step; not a release or completion of the whole plan.

## Scope

Owned immutable pages use two persistent AVL indexes: ordered layer keys to
children and child identities to keys. Evaluate, apply and inverse read/update
only addressed records and tree paths. Appends, patches and removals no longer
copy the complete page or build a fresh child map. Existing timestamp, field,
order, deletion-owner/mutation and atomic history guards remain canonical.

`notebookPages` is still an actual array. Its changed slot lazily exports an
ordinary deeply frozen child array only for a full reader/checkpoint. JSON,
structuredClone and IndexedDB retain the same wire format. No Proxy array,
method, tree node or order key enters the lesson format. Page-slot getters are
memoized; external shallow freezes/unknown accessors are not certified. Existing
unowned or malformed/duplicate layouts retain the prior canonical reducer.

Indexes are built once on first access to a deeply owned page. Initial loading,
unknown checkpoint comparison and explicit full exports remain linear. Slot
metadata copying scales with page count, not children. If repeated insertions in
one numeric layer-key gap exhaust floating-point spacing, that structural edit
relabels once from the current records. There is no growing rational-key string,
prototype chain or strong reference chain through prior page versions.

Projection/local capture and incoming single appends read index states rather
than forcing the lazy array. Equivalent optimistic/confirmed forks compare shared
tree branches and update only differing metadata records. A real visual patch is
never treated as a metadata update. Unknown families/layouts take the full path.

No change to the data schema4, video source files, transport, deletion retirement,
outbox guarantees, quality settings, servers, TURN or snapshot compaction.

## Verification contract

- Warm 5000-child evaluate/apply/inverse tests count retained numeric page reads
  for insert, patch and delete. Six tests failed before and passed after.
- Three projection/export integration tests failed before and passed after.
- Real Board callback capture+confirmation reproduced two full-array exports;
  sibling-version handling removes both without weakening state/history checks.
- Mixed320-operation differential sequence compares state, conflicts and inverses
  with the retained array path. Dense-gap insertion, immutable prior versions,
  duplicate legacy IDs, external mutation and independent exports are covered.
- The old test requiring exactly one retained-page copy is tightened to zero.
- Dedicated Chromium/WebKit gate checks indexed append, metadata confirmation,
  visual patch, guarded undo and real IndexedDB structured clone of lazy slots.
- Existing workload, pixel, notebook, PDF, migration/recovery and received-video
  checks are kept. Native timings compare with0e0b, not the initial old release.

Local Node suites pass. The recovered dependency archive lacks pdfjs-dist and
Playwright, so local `npm run build` and browser launch are not evidence of a
verified release. Native CI must build/install the exact commit before reporting
browser success. The standalone CPU benchmark is evaluate+apply+inverse only,
not physical pen latency, full browser latency or disk write volume.

## Still outstanding

General damaged-region rendering; addressed visual replacement/removal and spatial
eraser index; split worker; complete bounded preparation scheduling; zoom/cache
policy; initial-load/service work; full branch review and physical iPad/Pencil
acceptance. A visual patch/removal can still rebuild the displayed page even
though the reducer and inverse now use the page index. Author self-review only.
