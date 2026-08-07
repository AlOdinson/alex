# Alex Board 1.31.11

Large-board Apple Pencil selection-frame handoff fix.

- Based directly on 1.31.10; no changes to hit-test, transform persistence, finger/mouse drag, or object geometry.
- Fixes the active selection frame disappearing immediately after a Pencil drag stops on boards with 90+ Fabric objects.
- Keeps the lightweight moving controls overlay visible through the end of the Fabric `object:modified` task instead of disposing it while `renderTop` is still suppressed.
- On the next animation frame, restores Fabric render methods, repaints only the active object's/group's controls on `contextTop`, then disposes the temporary controls overlay.
- The stopped state therefore has one persistent Fabric frame at the destination, while pointermove still avoids full-board redraws.
- Cancels and disposes any one-frame handoff overlay if a new Pencil drag starts immediately, preventing stale controls or accumulation.
- Preserves 1.31.9 exact Pencil hit-testing, proximity tolerance, repeat-drag spatial-index fix, and `strokeUniform`.
