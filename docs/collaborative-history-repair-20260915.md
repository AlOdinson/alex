# Collaborative undo/redo repair — 2026-09-15

## Behavior
Each participant undoes their own recorded actions, including their own modifications to other participants' objects. Conflicting later changes by another participant are preserved. This is not a global board rewind.

Mouse, keyboard and touch history commands share one FIFO queue. Entries stay on their source stack until confirmation. Redo is the authoritative inverse of only the changes actually applied, not an overbroad copy of the original request. Conflict-only entries are skipped without blocking older valid entries or manufacturing redo. New local edits during a pending undo start a new redo branch.

Unknown outcomes retain stable action IDs for retry. Negative permission/lock acknowledgements do not consume history. Network waits no longer suppress new history recording. Accepted history updates and delayed self-commit verification use the ordered authoritative Canvas queue and revision guards. Independent peer queues stop one slow participant from blocking everyone else. Write/acknowledgement waits are bounded.

Undo-add no longer depends on unrelated absolute layer indices. Restored selections normalize layer order. Responsive history controls no longer cover the phone Selection button. Toolbar history commands finalize active Fabric text editing, while native text-editor keyboard shortcuts and readonly permissions remain unchanged.

## Evidence
Both Chromium and WebKit matrix jobs passed before source finalization:
https://github.com/AlOdinson/alex/actions/runs/34929554730

33 targeted regressions cover history correctness, retries/deadlines, repeated inverses, responsive hit targets and text command routing. Existing authority and hosted-safe sync suites and production build also pass.

The matrix uses computer 1280x800, phone 390x844 and tablet 820x1180 profiles in three independent contexts. Every profile takes the teacher role and acts as a student. Nine owner/actor combinations per engine compare actual objects on all three canvases after drawing, color, rotation, deletion, repeated undo/redo and rapid commands. Chromium also runs the existing large-snapshot, source-of-truth and data-channel-recovery scenarios.

Chromium uses normal production ICE with automated mouse, CDP touch/pen and touchscreen toolbar taps. WebKit on macOS uses actual WebRTC through an authenticated loopback-only test TURN server, automated mouse/touchscreen toolbar taps, and scripted finger TouchEvents for mobile drawing. No test relay is deployed to production. WebKit pointer-only and stylus-only input probes did not produce a stroke and are NOT successful Apple Pencil tests. Physical iPhone/iPad/Pencil and arbitrary real networks were not tested.

## Rollout and limits
Refresh the teacher and every participant after deployment. An older teacher without authoritative inverse acknowledgements triggers an update message instead of unsafe history replay.

History is limited to 1000 entries per browser session, previously 100. Reload keeps durable board content but does not restore the local undo/redo stack. The stacks are not shared between the owner's different devices.

The three existing hosted-safe sync checks requiring pixel Canvas remain excluded by that runner; separate real Chromium render scenarios run. No production TURN, cloud persistence or authority transfer was added. The original owner browser must remain online.
