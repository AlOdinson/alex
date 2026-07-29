# Alex Board 1.0.10 — Apple Pencil toolbar release fix

- Removed `preventDefault()` from Pencil/touch tool-button `pointerdown`.
- Tool selection now commits synchronously on the real `pointerup`.
- Suppresses only the later compatibility `click`, without a blocking timer.
- Toolbar and shape buttons use `touch-action: none` and disable the native iOS tap highlight.
- Buttons are blurred immediately after Pencil/touch selection.
- Canvas, Ably, Supabase, RPC, Undo/Redo and object formats are unchanged.
