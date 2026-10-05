# Addressed display changes and local page-cache repair

Base: `1872b70d8d06a23d8a027da8ff3f7cfda06e69cf`. Continuation of approved
no-video tasks 3/6; not completion of the whole performance plan or a release.

Related persistent page trees now report inserts, replacements, removals and layer
moves without exporting the retained page array. Projection prepares only visually
changed children; unchanged Fabric objects retain identity. Installation validates
every claimed delta and source slot before changing group membership, runs normal
Fabric enter/exit/layout lifecycle, and preserves an atomic synchronous install.
Native dense Fabric arrays still shift slots for structural inserts/removals; this
is not a claim that every operation in the renderer is constant time.

A visible-page spatial grid selects children that intersect the old/new paint
footprints. A valid existing page cache is repaired only inside its already-clipped
interior. Retained candidates, including ordered partial erasers, are drawn once
in original layer order. Text stays editable; image/vector records and conditional
undo semantics are unchanged. Real Board history is tested, not just a bare reducer.

Direct rectangle clipping changed antialiasing on a few boundary pixels in strict
regressions. Repair therefore uses a short-lived scratch surface with the exact canonical
cache origin/extent, followed by an integer-pixel copy of only the damaged window.
Only intersecting candidate geometry is drawn. Native browser pixel failures showed
that shifting the origin can change vector as well as resampled-image rounding.
Scratch is reserved against the SAME 32MiB notebook/64MiB board budgets and is freed
synchronously; no getImageData/readback exists in production repair. Rendered child
mask surfaces are released, rather than retained outside the budget. Reservation
failure, oversized batches, dense regions, unknown effects, page edges, stale caches
and scale changes retain full canonical painting. No second persistent page bitmap.

An existing offset-child-shadow regression was reproduced against original1872:
Fabric Group disabled caching although the notebook still had a clip, then crashed
in the uncached clip path. BoardNotebook now honors the cache required by its clip,
including in this fallback. No video module, transport, schema4, outbox, revision,
quality setting or stored format changes in this block.

Local red/green evidence: seven original damage/export tests failed, then passed;
additional strict pixel, incomplete-delta, temporary-budget, mask-release, scale,
and original shadow regressions were run before their corresponding fixes.
Local final new/updated focused set: 27 tests, including 21 shared pixel scenarios.
Existing95 optimization/model tests,169 storage/bounded tests,254 notebook tests,
authority/Pencil/sync/reading/media/storage/screen-share/connections and build pass.
The old assertion requiring a full undo repaint was replaced with local-cost AND
exact-pixel assertions; pixel tolerances were not widened. One exploratory test glob
incorrectly included a native-browser entry without Playwright; the unit list was
corrected, and native checks remain required. A verbose typed-array failure exhausted
a diagnostic runner; compact zero-difference assertions preserve the same requirement.

An additional review regression caught non-advancing grid loops at extreme finite
coordinates; unsafe grid integers now take the global-footprint path.

Native Chromium and macOS WebKit must pass the exact new21-case pixel gate, existing
input/projection/storage/undo/PDF/video gates and build for the delivered commit.
Local Node pixels are not a physical iPad/Pencil or browser latency claim. Author
self-review only; independent whole-branch review and device acceptance remain.

Still outstanding: spatial-index integration into actual eraser hit-testing;
fully bounded preparation/splitting worker; zoom/cache quality policy; main-board
partial composition and remaining service/startup work; full-plan release review.
The main board still uses its normal requestRenderAll and unchanged video compositor.

Native correction: full canonical scratch coordinates resolved all 21 Chromium cases and 19/21 WebKit cases. For two remaining fractional-scale cases the next correction reproduces Fabric translate/scale calls instead of a numeric getTransform/setTransform round trip. Fresh native results remain required. Rich per-character text styles and text on a path have unknown extra footprints and deliberately use canonical painting; a real 200px character-stroke regression reproduced 100368 differing channels before this guard.
