# Automatic Board Capacity Cleanup Design

## Goal

Keep the Supabase Free-plan Postgres database safely below its 500 MB database-size limit without manual maintenance. The system checks capacity once per day, automatically removes safe garbage, and when capacity pressure reaches 470 MiB deletes the least recently used boards until approximately 200 MiB of board data has been removed.

The cleanup must preserve the Alex Board application schema, RPC functions, migrations, authentication, teacher account records, Mac-agent records, Ably configuration, and all other system configuration.

## Fixed policy

- Capacity threshold: **470 MiB** (`492830720` bytes).
- Cleanup target after threshold crossing: delete approximately **200 MiB** (`209715200` bytes) of board data.
- Schedule: **once per day at 04:00 UTC+8** (`20:00 UTC`), using Supabase Cron / `pg_cron`.
- Oldest board first, ordered by:
  1. `last_lesson_at`, when present;
  2. otherwise `updated_at`;
  3. otherwise `created_at`.
- No board is protected from automatic deletion.
- If fewer than 200 MiB of boards exist, delete all available oldest boards and stop.
- The cleanup must be idempotent and safe to run again after a partial failure.

## Why the trigger is not raw `pg_database_size()` alone

Postgres normally reuses space inside table files after rows are deleted, but a normal `DELETE` does not necessarily reduce `pg_database_size()` immediately. If the job looked only at the raw physical database size, it could see the same 470 MiB on the next day and delete another batch even though the previous 200 MiB had become reusable space.

To avoid repeated over-deletion, install the supported `pgstattuple` extension and calculate a **capacity-pressure size**:

`capacity_pressure = pg_database_size(current_database()) - reusable_free_space_in_board_tables`

Reusable free space is estimated with `pgstattuple_approx` for the board-owned tables. The cleanup trigger uses this capacity-pressure value, while the raw physical database size is still logged for diagnostics.

A separate normal `VACUUM (ANALYZE)` job runs after cleanup so deleted tuples become reusable free space. `VACUUM FULL` is explicitly not scheduled because it takes stronger locks and can interrupt a lesson.

## Board-owned data

The following tables are board data and may be cleaned or cascade-deleted with a board:

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

The implementation must not delete or truncate:

- `auth.*`
- `public.teacher_accounts_v9`
- `public.teacher_mac_agents_v9`
- Supabase migrations
- RPC/function definitions
- cron definitions except the cleanup jobs owned by this feature
- Vault/secrets
- Realtime configuration
- Ably configuration

## Garbage cleanup

Before deleting real boards, each triggered cleanup removes data that is safe independently of lesson history:

1. Empty legacy board tables that are no longer authoritative in protocol v8, where current production code does not require their contents.
2. Expired object locks.
3. Abandoned import chunks older than 24 hours.
4. Old no-op outcome rows that are no longer needed for idempotency, using a conservative retention window defined by the implementation tests.
5. Old cleanup-job run history so `cron.job_run_details` does not grow without bound.
6. Storage assets whose path belongs to a board that no longer exists.

Garbage cleanup alone may satisfy the pressure target. After garbage cleanup the job recalculates capacity pressure. Real boards are deleted only if pressure is still at or above 470 MiB.

## Measuring board size for the 200 MiB target

The cleanup function calculates a deterministic logical footprint for each candidate board by summing the row payload sizes belonging to that board across `boards`, v8 action/state tables, and any remaining legacy board tables.

This is used only to decide how many oldest boards to remove. It does not claim to equal exact on-disk bytes because indexes, TOAST, and free pages add overhead.

Candidates are ordered oldest-first. The selected set is the smallest prefix of that ordered list whose cumulative estimated footprint is at least 200 MiB. If all boards together are smaller, all candidates are selected.

## Database deletion flow

The database cleanup runs in one controlled server-side function with an advisory lock so two executions cannot overlap.

1. Acquire the cleanup advisory lock. If another cleanup owns it, exit without changes.
2. Measure raw physical database size and capacity-pressure size.
3. If pressure is below 470 MiB, write a `skipped_below_threshold` log row and return.
4. Remove safe garbage.
5. Recalculate pressure.
6. If pressure is now below 470 MiB, write a `garbage_only` log row and return.
7. Calculate per-board logical footprints and select the oldest prefix totaling about 200 MiB.
8. Record the selected board IDs and size estimates in the cleanup log.
9. Delete the selected rows from `public.boards`; existing `ON DELETE CASCADE` foreign keys remove dependent board rows.
10. Return the deleted board IDs to the caller for Storage cleanup.

The function must not use `TRUNCATE ... CASCADE` on shared/system schemas.

## Storage asset cleanup

Board images are stored in the `board-assets` bucket under paths beginning with the board ID (`<boardId>/...`). Current client code uses exactly this prefix convention.

Storage objects must be deleted through the Supabase Storage API, not by directly deleting rows from `storage.objects`, because direct SQL deletion can leave physical files orphaned.

A dedicated Edge Function performs the Storage portion with server-side credentials:

1. Invoke the database cleanup RPC and receive deleted board IDs.
2. For every deleted board ID, recursively list and remove all objects under `<boardId>/` from `board-assets`.
3. Perform an orphan sweep: remove board-ID prefixes in `board-assets` for which no row exists in `public.boards`.
4. Record Storage deletion counts/bytes or failures in the cleanup log.

A Storage failure must not restore a deleted board. The next daily run retries orphan cleanup, making the operation eventually consistent and idempotent.

The first deployment should also run the orphan sweep once so the existing old `board-assets` files left after the September 6 database reset are removed.

## Scheduling

Use Supabase Cron (`pg_cron`). Supabase cron expressions are evaluated in GMT/UTC for this deployment.

- Main cleanup: `0 20 * * *` = 04:00 UTC+8.
- Normal vacuum: `20 20 * * *` = 04:20 UTC+8.

The vacuum job runs `VACUUM (ANALYZE)` only on board-owned tables. It does not use `VACUUM FULL`.

Supabase recommends cron jobs remain under 10 minutes. The implementation therefore deletes one bounded batch per day and paginates Storage deletion rather than attempting unbounded work.

## Observability

Create `public.board_cleanup_log` with one row per cleanup run. At minimum record:

- run timestamp
- status (`skipped_below_threshold`, `garbage_only`, `boards_deleted`, `failed`)
- raw database bytes before and after
- capacity-pressure bytes before and after
- estimated garbage bytes removed
- estimated board bytes selected
- number of boards selected/deleted
- deleted board IDs
- Storage object count/bytes deleted
- error text when applicable

Retain a bounded history, e.g. the most recent 90 days, and prune older cleanup-log and cron-run-history rows as part of maintenance.

## Failure handling

- Advisory lock prevents overlapping cleanup runs.
- Database selection/deletion is atomic.
- If Storage cleanup fails after DB deletion, the failure is logged and the next orphan sweep retries it.
- If size measurement fails, no board is deleted.
- If board-size estimation fails, no board is deleted.
- If no candidate boards exist, the run exits cleanly and logs the unresolved pressure.
- No cleanup step may delete auth/system rows.

## Verification requirements

Before enabling the daily cron job, implementation must verify in a non-destructive test path that:

1. Below 470 MiB, zero boards are deleted.
2. At/above the simulated threshold, garbage is removed before board selection.
3. Oldest boards are selected first according to `coalesce(last_lesson_at, updated_at, created_at)`.
4. Selection stops at the first oldest prefix reaching approximately 200 MiB.
5. FK cascades remove every dependent row for deleted board IDs.
6. Teacher/auth/system rows remain unchanged.
7. Re-running the cleanup is idempotent.
8. Storage cleanup removes only deleted/orphan board prefixes.
9. A simulated Storage failure is retried on a later orphan sweep.
10. Cron schedules resolve to 04:00 and 04:20 UTC+8.
11. The production database remains writable after installation.

## Out of scope

- Changing the 500 MB Supabase Free-plan quota.
- Protecting/pinning selected boards from deletion.
- Sending user notifications before deletion.
- Archiving boards externally before deletion.
- `VACUUM FULL` or other blocking physical compaction.
- Changing Alex Board realtime, Ably, or v8 synchronization behavior.