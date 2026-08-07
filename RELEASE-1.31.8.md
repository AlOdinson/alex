# Alex Board 1.31.8

Base: exact 1.31.2 rollback plus the confirmed `strokeUniform` resize fix.

This release changes only the visual activation timing for a fresh single-object Apple Pencil selection:

- when Fabric emits `selection:created` during an active native Pencil contact, the new single object's controls are drawn synchronously on the upper canvas;
- the normal Fabric selection/drag path remains unchanged;
- touch, mouse, group selection, marquee selection, cropped transform rendering, hit testing and persistence are not modified;
- the existing `strokeUniform` fix remains enabled.

Reason: on a busy board `before:transform` can start the Pencil compositor and cancel Fabric's pending full render before the first active-object controls have ever been painted. The object is already selected internally, but its frame is visually delayed until release/next interaction. Painting only `_renderControls` on the top canvas before that cancellation avoids a full-board redraw and preserves the working 1.31.2 drag pipeline.
