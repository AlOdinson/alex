# Automatic Board Capacity Cleanup Design

## Goal

Keep the Supabase Free-plan Postgres database safely below its 500 MB database-size limit without manual maintenance. The system checks capacity once per day, cleans safe garbage, and when capacity pressure reaches 470 MiB deletes the least recently used boards until approximately 200 MiB of board data has been removed.

The cleanup must preserve the Alex Board application schema, RPC functions, migrations, authentication, teacher account records, Mac-agent records, Ably configuration, and all other system configuration.

## Fixed policy

- Capacity threshold: **470 MiB** (`492830720` bytes).
- Cleanup target after threshold crossing: **200 MiB** (`209715200` bytes) of estimated board data.
- Schedule: **once per day at 04:00 UTC+8** (`20:00 UTC`), using Supabase Cron / `pg_cron`.
- Oldest board first, ordered by `coalesce(last_lesson_at, updated_at, created_at)` ascending.
- No board is protected from automatic deletion.
- If fewer than 200 MiB of boards exist, delete all available oldest boards and stop.
- The cleanup must be idempotent and safe to run again after a partial failure.

## Required compatibility prerequisite

The current production client still calls `duplicate_board_v7`, and that server function reads the legacy `public.board_objects` table. Therefore `board_objects` must **not** be globally purged while that dependency exists.

Before the automatic cleaner is enabled, duplication must be made v8-native: either introduce `duplicate_board_v8` or change the existing duplication RPC so its source state comes from the authoritative v8 snapshot/materialized state rather than `board_objects`. The client must use the v8-safe path, and regression tests must prove that duplicating a populated board preserves all objects and images.

Only after that prerequisite passes may `board_objects` and the other legacy protocol tables be treated as globally disposable garbage.

## Capacity-pressure measurement

A raw `pg_database_size()` check is insufficient by itself. Postgres normally reuses space inside table files after rows are deleted, but ordinary `DELETE` does not necessarily shrink the physical files. Looking only at raw physical size could therefore cause another 200 MiB of boards to be deleted the next day even though the previous deletion created reusable space.

Install the supported `pgstattuple` extension and calculate:

`capacity_pressure = pg_database_size(current_database()) - reusable_free_space_in_board_tables`

Reusable free space is estimated with `pgstattuple_approx` across the board-owned tables. The trigger uses `capacity_pressure`; raw physical size is logged separately for diagnostics.

A normal `VACUUM (ANALYZE)` job runs after cleanup so dead tuples become reusable space. `VACUUM FULL` is explicitly excluded because its stronger locks can interrupt a lesson.

## Board-owned data

The following tables contain board data and may be cascade-deleted with a board:

- `public.boards`
- `public.board_actions_v8`
- `public.board_object_states_v8`
- `public.board_action_heads_v8`
- `public.board_object_state_heads_v8`
- `public.board_action_noop_outcomes_v8`
- `public.board_object_locks_v8`
- `public.board_import_chunks_v8`
- legacy `public.board_actions`
- legacy `public.board_objects`
- legacy `public.board_snapshots`
- legacy `public.board_tombstones`
- legacy `public.board_import_chunks`

The implementation must never delete or truncate:

- `auth.*`
- `public.teacher_accounts_v9`
- `public.teacher_mac_agents_v9`
- Supabase migrations
- RPC/function definitions
- cron definitions except the cleanup jobs owned by this feature
- Vault/secrets
- Realtime configuration
- Ably configuration

## Daily garbage maintenance

Safe operational garbage is pruned on every daily run, even when board capacity is below 470 MiB:

1. Delete expired `board_object_locks_v8` rows.
2. Delete abandoned import chunks older than **24 hours** from both current and legacy import-chunk tables.
3. Delete `board_action_noop_outcomes_v8` rows older than **30 days**.
4. Delete `board_cleanup_log` rows older than **90 days**.
5. Delete cleanup-owned `cron.job_run_details` history older than **90 days**.
6. Remove Storage objects whose top-level path prefix is a board ID that no longer exists.
7. After the v8 duplication prerequisite is complete, empty legacy protocol tables that production no longer reads or writes.

Garbage maintenance is separate from real-board deletion. After garbage cleanup the job calculates capacity pressure. Real boards are deleted only if pressure remains at or above 470 MiB.

## Measuring board size for the 200 MiB target

The database function calculates a deterministic logical footprint for each board by summing row payload sizes belonging to that board across `boards`, v8 action/state tables, and any remaining legacy board tables.

This estimate is used only to choose how many oldest boards to remove. It is not presented as exact physical disk usage because indexes, TOAST, and reusable pages add overhead.

Candidates are ordered by `coalesce(last_lesson_at, updated_at, created_at)` ascending. The selected set is the smallest oldest-first prefix whose cumulative estimated footprint is at least 200 MiB. If all boards together are smaller, all candidates are selected.

## Database cleanup flow

The destructive database portion runs in one controlled server-side function with an advisory lock so two cleanups cannot overlap.

1. Acquire the cleanup advisory lock. If another cleanup owns it, exit without changes.
2. Perform daily safe garbage maintenance that belongs in Postgres.
3. Measure raw physical database size and capacity-pressure size.
4. If pressure is below 470 MiB, write `skipped_below_threshold` to the cleanup log and return no board IDs.
5. Calculate per-board logical footprints.
6. Select the smallest oldest-first prefix totaling at least 200 MiB.
7. Record the selected board IDs and size estimates in the cleanup log.
8. Delete the selected rows from `public.boards`; existing `ON DELETE CASCADE` foreign keys remove dependent board rows.
9. Return the deleted board IDs to the caller for Storage cleanup.

The function must not use `TRUNCATE ... CASCADE` on shared or system schemas.

## Storage asset cleanup

Board images are stored in the `board-assets` bucket under `<boardId>/...`. The current client creates exactly this prefix convention.

Storage objects must be deleted through the Supabase Storage API, never by direct deletion from `storage.objects`, because direct SQL deletion can leave physical files orphaned.

A dedicated `board-capacity-cleanup` Edge Function orchestrates each run:

1. Authenticate the cron request using a random cleanup token stored in Supabase Vault; the token is never committed to GitHub.
2. Invoke the database cleanup RPC using the Edge Function's server-side Supabase credentials.
3. For every returned deleted board ID, list and remove all `board-assets` objects under `<boardId>/`.
4. Perform an orphan sweep of `board-assets`: any board-ID prefix with no matching row in `public.boards` is removed.
5. Update the cleanup log with Storage object count, byte estimate, and any failure.

A Storage failure must not restore a deleted board. The next daily orphan sweep retries it, making Storage cleanup eventually consistent and idempotent.

The first deployment must run the orphan sweep once immediately so old `board-assets` files left after the September 6 database reset are removed.

## Cron and authentication

Enable `pg_cron` and `pg_net` using the supported Supabase extensions. Store the cron-to-Edge-Function cleanup token in Supabase Vault.

- Main cleanup Edge Function invocation: `0 20 * * *` = **04:00 UTC+8**.
- Board-table vacuum: `20 20 * * *` = **04:20 UTC+8**.

The vacuum job runs one normal `VACUUM (ANALYZE)` command over the board-owned tables. It never runs `VACUUM FULL`.

The destructive Edge Function must reject requests that do not carry the Vault-backed cleanup token. Possession of the public anon/publishable key alone must not authorize cleanup.

Supabase recommends scheduled jobs remain under 10 minutes. Storage listing/removal must therefore be paginated, and one cleanup run deletes only the single configured ~200 MiB board batch.

## Observability

Create `public.board_cleanup_log` with one row per run containing at least:

- run timestamp
- status: `skipped_below_threshold`, `garbage_only`, `boards_deleted`, or `failed`
- raw database bytes before and after
- capacity-pressure bytes before and after
- estimated garbage bytes removed
- estimated board bytes selected
- number of boards selected/deleted
- deleted board IDs
- Storage object count and estimated bytes deleted
- error text when applicable

Cleanup-log history is retained for exactly **90 days**.

## Failure handling

- Advisory locking prevents overlapping database cleanups.
- Database board selection and deletion are atomic.
- If Storage cleanup fails after DB deletion, the failure is logged and the next orphan sweep retries it.
- If capacity measurement fails, no real board is deleted.
- If board-size estimation fails, no real board is deleted.
- If no candidate boards exist, the run exits cleanly and logs unresolved pressure.
- No cleanup step may delete auth, teacher-account, Mac-agent, schema, secret, or configuration rows.

## Verification requirements

Before enabling the production cron jobs, tests must prove:

1. Below a simulated 470 MiB pressure threshold, zero real boards are deleted.
2. Daily safe garbage cleanup runs independently of board deletion.
3. At/above the simulated threshold, oldest boards are selected first by `coalesce(last_lesson_at, updated_at, created_at)`.
4. Selection stops at the first oldest prefix reaching the simulated 200 MiB target.
5. FK cascades remove every dependent row for selected board IDs.
6. Auth, `teacher_accounts_v9`, `teacher_mac_agents_v9`, schema objects, and secrets remain unchanged.
7. Re-running database cleanup is idempotent.
8. A high raw physical size with substantial reusable free space does not cause repeated over-deletion.
9. Populated-board duplication remains exact after removal of the legacy `board_objects` dependency.
10. Storage cleanup removes only deleted/orphan board prefixes.
11. A simulated Storage failure is retried successfully by a later orphan sweep.
12. A request with only the public Supabase key cannot invoke destructive cleanup.
13. Cron schedules resolve to 04:00 and 04:20 UTC+8.
14. The production database remains writable after installation.

## Out of scope

- Changing the 500 MB Supabase Free-plan quota.
- Protecting or pinning selected boards from deletion.
- Sending notifications before deletion.
- Archiving boards externally before deletion.
- `VACUUM FULL` or other blocking physical compaction.
- Changing Alex Board realtime, Ably, or v8 synchronization semantics.