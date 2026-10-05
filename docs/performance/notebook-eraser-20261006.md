# Notebook object eraser: addressed hit testing and release

Base: `ebf989968a0a4ee3a81fd3789654f5ab88bad4c1`. Next approved no-video
step (object eraser, item 8). No release/main deployment in this increment.

## Implementation and boundaries

`notebookEraserCandidates` reuses the visible child spatial grid. It transforms
the scene contact and viewport pixel-tolerance extent into notebook-local space,
then returns nearby children in the persistent model's descending layer order.
Board retains its EXACT prior `!isEraserPath && containsPoint(scenePoint) &&
!isTargetTransparent(child, viewportX, viewportY)` predicate. Empty bounding-box
interiors, translucent pixels and unknown/global footprints retain old selection
semantics. The broader query padding does not enlarge the final eraser hit area.
No change to pointer throttling, collecting repeated hits, or gesture boundaries.

Dirty/unindexed/unowned pages, changed parent scale, incompatible memberships,
invalid transforms and legacy layouts use the previous live scan. Querying never
forces a raster rebuild. Index creation on a cold imported page remains linear;
dense intersections or unsupported/global footprints can still yield many candidates.
Above256 candidates the helper retains the full live-order scan, avoiding a
page-wide rank/sort overhead; it never truncates candidates or skips lower ink.
Exact pixel testing still reads pixels, but only for nearby exact-hit candidates.

At release, prepared immutable pages resolve selected IDs through the persistent
page model rather than filtering and copying every child. Guarded deletes preserve
canonical page order, object-version conditions, one atomic operation and one
history entry per gesture. The actual optimistic controller result, not assumed
success, feeds the existing addressed damage installer. Unknown model families
keep the prior synchronous live deletion/sync fallback, filtered against the
actual canonical result. Rejected children remain visible. An older controller
without a readable view keeps its prior fallback. No original ink is removed before successful enqueue.

This does not remove Fabric's dense slot shifting on deletion or optimize every
part of the outer-board target search. Main-board rendering and the video
compositor are unchanged. Partial-eraser input/geometry, splitting, remaining
queues, zoom policy, cold startup and final physical-device acceptance remain.
No transport, schema, outbox, wire operation, snapshot compaction or quality changes.

## Evidence

The actual Board eraser function was tested before/after: 5000 distant children
plus one target required 5001 exact bounding tests and one complete page read;
the new path uses one exact test and zero complete page reads. On empty indexed
space no exact child test is needed. This is a structural count, NOT a claim of
5001x application speed or physical pen latency.

A prepared-page release regression first observed four full page reads and
redrawing unrelated content. The new path observes zero page reads and zero
render calls for distant retained children, then checks exact pixels against a
full render and restores original order through actual Board conditional undo.
The first real edit deliberately establishes the imported page's canonical
family before cost measurement; cold-import cost is not hidden as constant time.

Targeted tests cover transforms/zoom/tolerance, transparent interiors, ignored
partial erasers, rich text/shadows, stale/same-length replacements, layer changes,
multiple hits per gesture, enqueue refusal, unchanged guarded results, old-page
entries, persisted authority state and undo. The original path fails both cost
regressions and the guarded-noop visual-retention test; the candidate passes.

Local project notebook, Pencil, sync, authority, reading, media, storage,
screen-share and connection suites and build are checked. An exploratory unit
glob accidentally included a native browser entry; its missing browser executable
was not a product failure. The corrected explicit unit set passes. Local browser
navigation was blocked by the environment's administrator, so native verification
is delegated to the existing Chromium/Linux and WebKit/macOS CI with no relaxed
assertions. Read results for the exact delivered commit before claiming it passes.

The new native gate compares seven spatial/pixel cases and drives the real UI's
eraser gesture, undo, redo and reload. Existing page-model, migration/recovery,
22-case local-damage, eight append-pixel, input, PDF and video compatibility gates
remain. Author self-review only; independent branch review and real iPad/Pencil
acceptance are still outstanding.
