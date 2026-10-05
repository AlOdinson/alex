# Bounded notebook preparation and mutation queue fairness

Base: e54e45ed4ab79cfbac8319ecfbd971c4ff449c64. Approved no-video item 6
continuation, not completion of the whole queue plan or a production release.

## Changes and invariants

The actual Board mutation Promise tail now shares a cooperative work budget.
After a consecutive burst exceeds 4ms (or 32 units), the next complete job
waits for a browser task. A one-shot task marker resets the burst on natural
I/O waits; waiting for an image or lease is not treated as measured CPU work.
The first short job keeps its immediate Promise semantics. Rejected jobs do
not poison the tail. Canvas identity and lifetime epoch are checked after a
yield and before starting; a stale queued callback cannot act on a new board.
The original tail still gates page flips, history and held transform projection.
No accepted action is dropped, merged or removed from the durable queue.

Detached child preparation starts at most eight Fabric constructors per batch.
Navigation, projection, incoming page deltas and full notebook restoration use
this shared helper. Between batches it checks the same four-millisecond budget,
abort signal and caller's source/lifetime guard. Nothing is installed until the
complete target is ready and existing consistency checks pass. Independent
notebook preparations have independent budgets; an image in one does not hold
another notebook's preparation. The outer Board gesture queue still preserves
global FIFO and is not claimed to allow all independent capture jobs in parallel.

Stale navigation stops remaining construction, disposes temporary objects and
retries only when its own target page changed, preserving the existing three
attempt bound. Incoming operations keep their guarded merge/retry and wire order.
A preparation exception releases all constructed objects and leaves the old
page intact. Abort rejects promptly and also releases constructors/fallbacks
that resolve later. Async reviver cleanup has its own red/green regressions.
Missing/failed children without an explicit successful fallback reject the whole
page, rather than silently returning a partial page.

There is no production polling loop, new server, worker, wire/schema change,
outbox change, image quality reduction or video change. All changes live on the
performance branch; main remains untouched.

## Limits

This is cooperative scheduling, not preemption. One complicated child or nested
group, large synchronous model diff/export, final synchronous installation,
raster repair and geometry splitting can still exceed the budget. Session
create/enqueue/ack/rebase remain synchronous because callers require immediately
consistent state. Large session reconstruction is still outstanding; it was not
wrapped in an unsafe timer. Full priority/keyed scheduling and independent capture
admission are not completed. More task boundaries may increase total page load
time while improving input responsiveness; no pen-latency improvement is claimed
from a timer-ordering test. Native iPad/Apple Pencil acceptance is still required.

## Evidence and verification status at commit creation

The original Board callback starved a pending input task until all four heavy
jobs finished; its new lifetime/fairness regressions now pass. The original
navigation/projection/delta/full-load paths constructed all 96 probe children
before input; bounded preparation admits input between batches, keeps the old
page visible, and abandons stale work. Original failing-child navigation silently
installed a partial page; the new regression rejects it without changing the page.
Nineteen focused tests cover the above plus short jobs, I/O waits, independent
notebooks, failures, abort, late constructors and revivers. Existing notebook254,
optimization134 and storage/bounded169 passed locally. Project suites and build
are logged separately; final native results must be read for the delivered SHA.

One extra legacy test command, test:capacity-cleanup, FAILS unchanged on both
this candidate and the exact previous source: its assertion still expects a
direct duplicate_board_v8 RPC in boardRepository.js, which delegates to the
browser compatibility repository. This unrelated test is not disabled or patched
in this increment. Existing selected CI gates remain intact.

Local browser navigation is administrator-blocked. The new native gate has nine
ordering/atomicity/cancellation scenarios; existing real pointer, history, 22
exact damage-pixel, 8 append-pixel, storage/migration, PDF and video gates remain.
Author self-review only, not independent whole-branch approval or deployment.
