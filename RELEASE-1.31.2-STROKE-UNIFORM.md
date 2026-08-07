# Alex Board 1.31.2 — stroke-uniform rollback build

This build is intentionally based on Alex Board 1.31.2.

Only the confirmed stroke-scaling improvement was carried forward:

- Scaling a stroked vector object changes its geometry without multiplying the visual stroke thickness.
- Existing stroked objects receive Fabric `strokeUniform = true` when registered/loaded.
- Newly-created line objects and realtime line/path previews explicitly use uniform strokes.
- The existing 1.31.2 Pencil selection/transform code is otherwise unchanged.
