# Alex Board 1.31.7

- Removed the separate native direct-Pencil drag engine for a first unselected single object.
- First Pencil contact now only bootstraps selection; the same physical pointerdown continues into Fabric, matching the working finger path.
- The full selection frame is painted immediately on first contact.
- For that first pointerdown, Fabric resize/rotate hit zones are temporarily disabled until the transform action has already been classified as drag, preventing tiny objects from shrinking on release.
- Pencil move rendering now carries the selected object/group and the complete selection UI in separate cropped raster layers.
- The border, resize handles, top rotation square, connection lines and group hand move as one rigid overlay during Pencil drag.
- The real Fabric upper canvas remains the input surface but is visually hidden only during the isolated Pencil move, preventing stale control fragments from remaining at the origin.
- At release, the final selection controls are redrawn directly on the upper canvas only; the full lower board is not repainted.
- Clearing selection also clears the lightweight manually painted controls layer without a whole-board render.
- Existing painted-object Pencil hit testing and strokeUniform resizing from 1.31.6 are preserved.
