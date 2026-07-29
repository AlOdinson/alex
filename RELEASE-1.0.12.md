# Alex Board 1.0.12 — Apple Pencil toolbar pointer-capture release

- Tool controls no longer call `preventDefault`, `stopPropagation` or `stopImmediatePropagation` for Pencil selection.
- Any implicit pointer capture assigned by Safari is released immediately, again on `gotpointercapture`, and through microtask/frame/timer fallbacks.
- Window-level `pointerup` and `pointercancel` cleanup ensures a toolbar control cannot remain the owner of a Pencil stream.
- Tool controls are blurred after activation without delaying the selected tool.
- Shape choices release pointer ownership before the palette portal closes and unmounts the selected item.
- Keyboard Enter/Space activation remains available.
- Canvas, Ably, Supabase, realtime operations, storage, Undo/Redo and object formats are unchanged.
