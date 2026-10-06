# Notebook viewport quality and retained cache memory

Base: `fd79dab4371dd52937f507277e7ad2a15596671f`, exact source tree
`632e5087c9c81cf43bce96323b5c97944b66608e`. Approved no-video item 10
continuation. Experimental branch only, not a production release or full-plan completion.

## Rendering contract

The real Board wheel, pinch, explicit zoom controls and non-video viewport-follow
paths emit a local Fabric viewport event. No transport message is added. A
translation-only change does not start or prolong a zoom refinement interval.

A clean, unchanged top-level notebook with the ordinary page clip may reuse its
existing pixels during a viewport interaction while the requested cache density
stays within a factor of 1.2 in each axis. Larger density steps render canonically.
After 120 ms without another scale change, visible pending notebooks refine at
canonical Fabric density, one per normal canvas frame. These are quality scheduling
parameters, NOT a bound on the duration of an individual native canvas call.

The cache's exact original matrix, source page identity, geometry, count, clip,
retina scaling and lifetime are guarded. Real content changes, frame transforms,
unknown masks and stale surfaces bypass interpolation. Append and damage readiness
is disabled while an old density is borrowed; editing is never postponed merely
to wait for a quality timer. The implementation does not quantize settled density,
rewrite vector data, flatten text, alter the export format or enlarge geometry tolerances.

Only the canvas's normal rendering context can borrow a viewport cache. Export,
hit-test and compositor contexts use the canonical path. In particular, video
composition is neither modified nor bypassed. A compositor pass may therefore
remove the opportunity for this viewport optimisation; no video-speed claim is made.

A timer handles a pending quiet deadline, followed by one pending refinement per
canvas frame. There is no permanent animation/polling loop. Removed pages retire
pending work; pages leaving the viewport are not recreated by refinement. Late
quality tasks do not apply old model snapshots or edit source records. Existing
page-local spatial indexes survive pure viewport-density changes.

## Memory and admission

The page clip has already been multiplied into the finished cache. Fabric creates
a new clip layer on the next canonical render, so the old clip canvas is now zeroed
and released immediately after baking instead of retained beside the page.
For a plain page this removes one of two equal-sized persistent raster surfaces.
This is NOT a claim that total browser memory halves.

The original 32 MiB per notebook and 64 MiB board retained-cache/explicit-repair
limits remain unchanged. Admission chooses offscreen owners before visible ones;
active temporary-repair reservations pin their source. If all retained candidates
are visible, a new visible page is painted as a transient rather than rotating
all visible residents out on every frame. Callers without visibility metadata
keep the previous LRU contract. Invalid surface sizes cannot turn accounting into NaN.

A refused admission can no longer clear the currently rendering page before
Fabric's immediately following drawImage. Such a surface is released after that
render completes, including exceptional exit. Original content is never deleted
in response to memory pressure.

## Evidence at creation

Eight targeted regressions first failed on the exact base, then passed:
actual Board wheel rendered 2400 old children for 24 small steps rather than zero;
zoom rebuilt the local spatial index; the full clip surface remained; a >32 MiB
page threw before blitting; visibility priority, stable visible admission and
reservation pinning were missing; invalid dimensions corrupted accounting.

After implementation the actual wheel probe performs zero old-child renders during
those steps and one 100-child exact refinement after quiet. Ten shared cases cover
fractional density, retina, exact settled/export pixels, live edits, translation-only
pan, three separate refinement frames, offscreen work, removal, large jumps and
retina changes. The native gate also dispatches WheelEvents to the real Board DOM.
Native results must be read for the delivered commit before claiming browser success.

The local notebook254 suite, 50 existing focused rendering/eraser tests, and all
21 verify-job commands (using the checksum-verified existing locked dependencies)
passed, along with connections/menu. A combined local invocation hit its outer
execution timeout; the interrupted media command and remaining commands passed
when executed separately. Three cursor tests initially used a canvas stub without
Fabric.fire; the stub now records the real event and asserts it in addition to
all original midpoint checks. No previous assertion was removed.

The unrelated `test:capacity-cleanup` assertion still fails on the exact base and
candidate: it expects a direct `duplicate_board_v8` RPC in a delegating adapter.
It is neither changed nor disabled. Existing bundle/dynamic-import warnings remain.
Local Chromium navigation is administrator-blocked; no local browser success is claimed.

## Explicit limits and review decisions

- Intermediate zoom pixels are interpolated; exact sharpness returns after quiet.
  Rapid repeated edits/unsupported effects can still require full canonical renders.
- One canonical page refinement is indivisible; this change does not cap frame time.
  Primary Fabric allocation and transient native clip/GPU memory are not a hard
  global browser RAM budget. Explicit scratch repairs retain their existing accounting.
- Pages too large or numerous to retain still require transient full rendering.
  Quality is not permanently reduced to fit more pages in memory.
- Object resizing and unsupported/nested rendering paths remain canonical. Initial
  load, generic structural operations, legacy clipping, partial erasing and global
  board rendering remain subject to the other approved plan tasks.
- No changes to video files or video viewport setup, signaling, servers, TURN,
  snapshots, storage schema, authority/outbox semantics, export quality or main.
- Review performed by the author only; independent whole-branch review, long real
  lessons and physical iPad/Apple Pencil acceptance are still outstanding.
