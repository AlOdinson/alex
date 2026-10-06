# Notebook split worker integration and safety

Base: 273255cad804e487024cf3a493e6563d20a1e818 (tree9655941d).
Continuation of approved no-video item7; NOT full-plan completion or main deployment.
The earlier pending eight-file worker patch was recovered with its exact checksum
and tree8d809bd9, then reviewed and extended before integration.

## Implemented

Unmasked native vector primitives are recorded as plain Canvas commands. Curve
flattening, stroke expansion and polygon clipping run in an isolated module worker;
no live Fabric object/DOM is transferred. The former geometry functions are shared
by the worker and the canonical mask fallback, preserving matrix evaluation order,
0.01 tolerance and existing complexity guards. A pinned test-only copy of the
previous geometry verifies nine shape families plus eighty exact matrix cases.

The real capture path passes cancellation and source/lifetime guards. Navigation,
detachment or disposal aborts an outstanding split. Worker cleanup removes listeners,
clears its deadline and terminates its dedicated thread. A worker with no response
fails after15seconds, preserving the source, rather than holding the gesture queue
indefinitely. Runtime/serialization failures reject instead of rerunning the heavy
calculation on the UI thread. Worker-unavailable/constructor-failure environments
retain the canonical compatibility calculation on a new task; that path is NOT
preemptible. Existing history/outbox/source replacement remains atomic.

Raster bounds use a dedicated transferable bitmap and OffscreenCanvas when usable.
Both worker and compatibility alpha scans read at most256x256 pixels per tile.
The compatibility scanner yields after at most four tiles or a4ms work slice;
a single native canvas call is still not preempted. Above4Mi pixels no extra full
bitmap/worker canvas is created: the existing surface is scanned in tiles without
resampling. The source asset is never transferred/detached. Bitmap creation aborts
promptly; a bitmap resolving after cancellation is closed. Unknown/invalid worker
raster results take the bounded scan fallback. New fragments retain original pixels
and the existing immutable image encoding path.

## Verification

Seven new safety/cost tests failed against the pending patch before the fixes;
large-raster-allocation and worker tile-read tests also failed before their fixes.
The exact existing stale-gesture message contract is preserved; old tests were not
weakened.26 worker-specific checks pass, including real Node worker_threads, guarded
capture cancellation, late bitmap disposal, tile read bounds and geometry equivalence.
The254 existing notebook tests pass. Other local suites/build are logged separately.

An existing unrelated test:capacity-cleanup assertion still expects direct
supabase.rpc('duplicate_board_v8') in a delegating repository adapter. It fails on
the reconstructed273255ca base too; this work neither changes nor disables it.
Existing large-bundle/dynamic-import build warnings remain.

Native CI checks actual worker creation, real crossing capture, cancellation,
bitmap/tiled fallback bounds and execution of the production-built worker through
a plain static server. Existing geometry/pixel/history/storage/migration/PDF/video
gates remain. Read results for the delivered commit before claiming browser success.
No physical iPad/Pencil latency claim. No independent reviewer available; author
self-review is not whole-branch release approval.

## Remaining limitations / explicit decisions

- Old/inherited masks keep canonical main-thread mask geometry in this increment.
- Initial clone, recording native commands, final Fabric fragment construction,
  raster draw/encoding and atomic installation still run on the main thread.
- Very dense/complex input may fail the existing guards or the worker deadline;
  failure preserves original content and reports the error instead of silently
  approximating geometry or losing source objects.
- A new worker is used per isolated job; worker warm-pooling and masked geometry
  are not implemented. No unbounded queue or retained page/bitmap cache is added.
- Large session rebase/pending reconstruction, zoom/cache quality, first load,
  service cleanup, whole-branch review and real-device acceptance remain.
- No video files, signaling, servers, TURN, schemas, snapshot compaction, transport
  or quality settings changed. Main-board composition remains unchanged.
