# Alex Board 1.16

- Enabled high-density Canvas rendering, capped at 2x device pixel ratio for performance.
- Added one recursive sharp-rendering policy for every current and future vector object.
- Paths, lines, shapes, text, groups, previews and revived objects no longer reuse a scaled bitmap cache during zoom.
- Kept raster images at their native source resolution.
- Updated the custom grid/dots renderer for Retina backing-store coordinates.
- No realtime, persistence or serialized board format changes.
