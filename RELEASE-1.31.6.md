# Alex Board 1.31.6

- First Apple Pencil contact on a single object now uses one native client-coordinate path for hit-test, activation, live drag and release.
- Single-object selection frame is rendered on the first Pencil contact.
- Direct Pencil hit testing no longer falls back to an object bounding box; it probes painted pixels with a small tolerance and uses geometric tolerance for lines.
- Thin/small stroked objects are easier to grab without making the empty selection frame clickable.
- Vector strokes use `strokeUniform: true`, including existing objects when registered, so resizing changes geometry without multiplying line thickness.
- Existing fast cropped Pencil compositor and group-drag path are preserved.
