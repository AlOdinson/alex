# Alex Board 1.20

- Undo after deleting objects now restores them through the same authoritative realtime operation for every participant.
- Restored history records receive a fresh `updatedAt`/`updatedBy`, so server conflict checks cannot treat them as stale pre-delete objects.
- Realtime fanout preserves the client-side `restore`, `reorder`, and `preserveOrder` intent flags even when a Supabase RPC normalizes them out of `applied_ops`.
- Rejected authoritative actions are no longer broadcast as successful object operations; receivers are told to reconcile instead.
- Undo/Redo waits for the restoration/deletion action to enter and complete the durable collaboration queue.
- Toolbar history controls and Ctrl/Cmd+Z use the same fixed path.
