# Alex Board 1.22

- Multi-object selections now display a dedicated high-contrast black hand handle below the bottom-center resize control.
- A connector line visually links the selection frame to the move handle.
- Dragging the hand moves the complete ActiveSelection without requiring a hit on a tiny line, text glyph, or shape inside the selection.
- The visible handle stays a fixed screen size while zooming, so it remains usable on strongly zoomed-out boards.
- The interaction area is enlarged separately for touch and stylus input.
- Movement uses Fabric's normal transform lifecycle, preserving live collaboration, object locks, history, Undo/Redo, and the existing object:modified commit path.
- Existing scale, height, width, corner, and rotation controls are unchanged.
- The handle is temporary UI only and is never serialized into board data.
