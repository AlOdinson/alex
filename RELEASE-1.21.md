# Alex Board 1.21

- A pasted object batch is added to local history immediately when it appears, so Ctrl/Cmd+Z and the toolbar Undo button remove the complete batch as one action without waiting for realtime preview delivery.
- Durable paste operations are automatically split below the large staged-import threshold while retaining one logical history entry.
- All chunks are enqueued synchronously and in order before control returns to the user, so an immediate Undo is persisted after every paste chunk rather than racing ahead of it.
- Realtime preview delivery is now best-effort and never blocks paste completion or history creation.
- Large delete/restore/replace history operations use the same bounded durable chunking path.
- Existing oversized pending actions can fall back to deterministic normal RPC chunks when staged-import server functions are unavailable, allowing old IndexedDB queues to drain after the update.
- Staged import uploads the first chunk normally and then uploads up to four remaining chunks concurrently.
- Durable server requests have bounded timeouts and idempotent retries instead of being able to wait forever on one network promise.
- Missing Supabase RPC detection now also supports PostgREST PGRST202 and “Could not find the function” errors.
