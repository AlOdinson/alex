# Alex Board 1.10 — Hard ActiveSelection teardown

- Group selections are explicitly dismantled after a transform instead of relying only on `discardActiveObject()`.
- Cleanup runs in `finally`, so a serialization, realtime or history error cannot leave the wrapper active.
- A mouse-up safety pass removes a wrapper if Fabric does not complete `object:modified`.
- Tool switching uses the same hard teardown and clears empty selection wrappers.
- Old per-member control-renderer overrides are restored and are no longer recreated.
- Group transform history still stores one operation using absolute matrices.
- Object eraser, drawing tools, Ably/Supabase payloads and snapshots are unchanged.
