# Alex Board 1.31

Apple Pencil movement no longer clears, rebuilds or snapshots the whole visible board.

- The 1.30 full-board frozen-scene renderer was removed. It could temporarily blank the teacher board because it mutated Fabric's private object list and replaced the lower scene during a live transform.
- A move now creates two cropped canvases only around the selected bounds: an origin patch and a moving-selection raster. The rest of the existing lower canvas stays visible and untouched.
- The origin patch redraws only nearby objects found through a scene-space grid index, so its preparation cost does not scan or render the full board.
- Pointer movement changes one CSS transform and schedules only the Fabric top/control layer. The lower scene is never redrawn while the Pencil is down.
- Pointer release composites the two small cropped rasters directly into the existing lower canvas. No delayed whole-board reconciliation render is scheduled.
- Full-retina temporary canvases from 1.30 were replaced by cropped canvases and their backing stores are released immediately, preventing Safari GPU-memory buildup after repeated moves.
- The spatial index is updated incrementally on add, delete, local transform and remote transform; layer order is refreshed only after an actual reorder.
- Lightweight transform persistence from 1.29 remains unchanged: no full object serialization and no snapshot compaction for move-only actions.

Expected cost is proportional to the selected objects and objects overlapping the selection's old area, not to the total object count on the board.
- Selection and deselection through Apple Pencil now render only Fabric's top/control layer; they no longer trigger a full lower-canvas repaint on a busy board.
- Fabric's trailing render request after `object:modified` is suppressed through the end of the current event task, preventing a hidden whole-board redraw immediately after every move.
