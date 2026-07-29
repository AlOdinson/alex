# Alex Board 1.0.9 — Non-blocking Apple Pencil tool switch

- Tool changes now update global input ownership synchronously without scanning every board object.
- The expensive selectable/evented/controls refresh waits until Apple Pencil input and queued pointer events are idle.
- Drawing modes no longer rewrite every object because `skipTargetFind` already isolates Fabric from the board.
- Select and text preflight only the object under the Pencil before Fabric receives the first pointerdown.
- Completed lines and shapes request a render immediately when replacing their preview.
- Ably, Supabase, RPC, realtime formats, Undo/Redo and persistence are unchanged.
