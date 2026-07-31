# Alex Board 1.11

Base: 1.07 selection lifecycle.

- Removes the 1.08-1.10 ActiveSelection teardown/recreation state machine.
- Never calls ActiveSelection.removeAll() manually.
- Never recreates ActiveSelection after a group transform.
- Group transform persistence and Undo are committed on the next animation frame,
  after Fabric has completed its own mouse-up lifecycle.
- ActiveSelection wrappers are never serialized as board objects.
- Old serialized ActiveSelection wrappers are ignored during snapshot/action replay.
- Clicking blank canvas clears the current selection immediately.
- Realtime and Supabase operation formats are unchanged.
