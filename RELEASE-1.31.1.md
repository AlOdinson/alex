# Alex Board 1.31.1

Apple Pencil selection-frame and hand-handle hotfix on top of the cropped transform compositor.

- ActiveSelection control coordinates are refreshed on every isolated Pencil move, so the border, corner controls, top rotation square and bottom hand remain one moving unit.
- The custom bottom hand control now reports each action tick directly to the same cropped compositor and realtime transform path used by dragging the selection body.
- Safari no longer waits for an `object:moving` event that the custom Fabric control may omit; the selected objects are visible at their live position instead of teleporting only after deselection.
- A top-only final frame is rendered after `object:modified`, keeping the selection border visible at the destination without repainting the lower board.
- Only one cancellable final top refresh is retained, so repeated moves do not accumulate render tasks.
- Lightweight transform persistence and dirty-region lower-canvas compositing from 1.29–1.31 remain unchanged.
