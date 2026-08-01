# Alex Board 1.15

Base: 1.14

## Precise cursor selection

- Single-click selection uses Fabric per-pixel target finding only while the cursor tool is active.
- Empty regions inside an object bounding rectangle are no longer selectable.
- A 2-screen-pixel tolerance keeps thin lines practical on touch and Apple Pencil.
- Marquee selection keeps the existing painted-pixel intersection test.
- Marquee selection no longer falls back to bounding-box intersection when an exact probe fails.
- Drawing tools, erasers, eyedropper, text, realtime, persistence and history formats are unchanged.
