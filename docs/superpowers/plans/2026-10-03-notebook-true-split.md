# Notebook true split implementation plan

> Execute with superpowers:executing-plans; use a failing/passing test cycle per task.

**Goal:** Retain only real visible geometry/pixels in each notebook capture fragment.
**Architecture:** Keep the existing atomic capture/history protocol. Lazily load a geometry cutter for partial intersections; boolean-cut vector paints, bake and crop bitmap/text fragments. Do not migrate saved lessons in place.
**Tech stack:** Fabric 7.4.0, Clipper 6.4.2 (pinned), Canvas, existing authority/outbox.
**Spec:** User-approved conversation: text option A (partial text becomes noneditable image fragments; fully contained text stays text); drawings stay vector; images contain only retained pixels; outside removed region remains empty after moving/export/reload. First image insertion remains independent. Source retained only where Undo/history requires it.

## Global constraints
- No changes to transport, screen-share modes, read-only viewing or permissions.
- No full-source clipPath duplicates in newly cut fragments.
- Prepare fully before changing source/canvas/history. Null visible intersection means no capture.
- One logical undo/redo for both sides; restore original text/source and teacher/student convergence.
- Preserve page/frame coordinates, opacity, stroke width, transforms, paint order and legacy masks.
- Vector curve approximation must have a declared bounded tolerance. Resource failures must not delete input.

## Review focus
- Rotated/scaled groups, strokeUniform, dash gaps, thin curves and holes.
- Transparent images, central cut-outs, source/crop coordinate transforms.
- Existing clip masks and eraser compositing; no hidden contents resurrect after a later cut.
- Empty intersections and generation changes during asynchronous work.
- Source identity, derived asset references, conditional history and return from offline reading.

## Tasks
- [x] 1. Add failing true-fragment/pixel tests; implement vector paint extraction, stroke outlines and polygon boolean split in separate geometry module.
- [x] 2. Implement bounded raster rendering and true pixel crop/erase for images and cut text; keep source immutable, preserve fully contained text.
- [x] 3. Wire capture into existing actions, adapt obsolete mask-specific tests to stronger geometry/pixel invariants; test actual authority, group capture and undo/redo.
- [ ] 4. Run notebook, reading, media, authority, pencil, sync, screen suites and production build; native Chromium/WebKit product/pixel tests; inspect and document limits.
- [ ] 5. Publish reviewed exact tree in PR, all release gates, merge into main and verify GitHub Pages deployment. No success claim before evidence.
