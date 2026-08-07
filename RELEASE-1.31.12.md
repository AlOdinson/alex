# Alex Board 1.31.12

Large-board stale selection-control cleanup.

- Based directly on 1.31.11. No changes to hit-test, transform persistence, finger/mouse drag, object geometry, selection semantics, or strokeUniform.
- Fixes the two stale control remnants that could remain at the pre-drag position after a large-board group Pencil move: the offset top control and the custom hand handle.
- Hard-clears Fabric's physical upper-canvas backing store with an identity transform before capture, during isolation, and before the final controls paint. This prevents Safari from retaining old offset-control pixels while the cropped compositor interrupts Fabric's normal render lifecycle.
- Explicitly recalculates ActiveSelection `oCoords` after `setCoords()` for the large-board visual path, keeping offset controls attached to the current selection center.
- Removes any orphan `pen-transform-*` compositor canvases before a new isolated drag and after the final handoff, while preserving the current authoritative layer.
- The existing 1.31.11 handoff remains: the moving controls overlay stays visible until the final Fabric top frame has been painted at the destination.
