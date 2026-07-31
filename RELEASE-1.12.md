# Alex Board 1.12

Base: 1.11 stable selection lifecycle.

- Keeps single and multi-object selection active after moving objects.
- Clicking empty canvas or switching to another tool clears the selection.
- Serializes members of an ActiveSelection in absolute board coordinates without dismantling the visible selection.
- Swaps eraser mode buttons so Object appears first.
- Object eraser is the default mode on board load.
- Stores independent color, opacity and width for Pencil, Line and Shapes.
- Eyedropper updates only the currently active drawing tool style.
- Adds the eyedropper to Shapes.
- Uses native pointer movement and pointer-up coordinates for desktop Line and Shape creation.
- Removes the expensive per-pixel target scan from the drawing eyedropper and uses Fabric's normal target result first.
- Realtime, Supabase operation formats, snapshots, object eraser logic and Pencil fallback are unchanged.
