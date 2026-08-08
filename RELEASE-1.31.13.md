# Alex Board 1.31.13

- Marquee selection now uses rendered object geometry for partial overlaps instead of bounding-box/aCoords intersection.
- Empty areas inside an object frame no longer cause the object to be selected.
- Object eraser hit tolerance is 9 screen pixels and is zoom-independent.
- Tiny/thin objects can be erased reliably, including with a zero-movement tap.
- Eraser probes rendered geometry rather than empty frame area.
- Existing Pencil transform, large-board compositor and strokeUniform behavior are unchanged.
