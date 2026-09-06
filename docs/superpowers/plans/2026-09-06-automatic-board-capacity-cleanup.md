# Automatic Board Capacity Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the Alex Board Supabase database below the Free-plan 500 MiB limit by running daily safe garbage cleanup and, at 470 MiB capacity pressure, deleting the least recently used boards until about 200 MiB of board data has been selected for removal.

**Architecture:** First remove the last runtime dependency on legacy `board_objects` by introducing a v8-native duplication RPC. Then add a Postgres cleanup subsystem that measures capacity pressure, prunes safe garbage, selects the oldest board prefix by estimated logical footprint, and cascade-deletes those boards atomically. A dedicated Edge Function performs Storage API cleanup for deleted/orphan `board-assets` prefixes, and Supabase Cron invokes it daily at 04:00 UTC+8; a non-blocking `VACUUM (ANALYZE)` job follows at 04:20 UTC+8.

**Tech Stack:** PostgreSQL 17, Supabase Postgres, `pgstattuple`, `pg_cron`, `pg_net`, Supabase Vault, Supabase Edge Functions (Deno + `@supabase/supabase-js`), React/Vite client, Node regression scripts.

**Spec:** `docs/superpowers/specs/2026-09-06-automatic-board-capacity-cleanup-design.md`

## Global Constraints

- Capacity threshold is exactly **470 MiB** (`492830720` bytes).
- One cleanup batch targets exactly **200 MiB** (`209715200` bytes) of estimated board data.
- Main schedule is exactly `0 20 * * *` UTC = **04:00 UTC+8**.
- Vacuum schedule is exactly `20 20 * * *` UTC = **04:20 UTC+8**.
- Oldest board ordering is `coalesce(last_lesson_at, updated_at, created_at), id` ascending.
- No board is pinned or protected from automatic deletion.
- Never delete `auth.*`, `teacher_accounts_v9`, `teacher_mac_agents_v9`, migrations, secrets, schema/RPC definitions, Realtime configuration, or Ably configuration.
- Never delete Storage objects with direct SQL against `storage.objects`; use the Storage API.
- Never schedule `VACUUM FULL`.
- Destructive cleanup must require a random token stored in Supabase Vault; a public anon/publishable key by itself is insufficient.
- Cleanup must be idempotent and safe after partial Storage failure.
- Do not enable production cron until v8 duplication and cleanup tests pass.

---

### Task 1: Remove the legacy `board_objects` dependency from board duplication

**Files:**
- Create: `supabase/duplicate_board_v8.sql`
- Modify: `src/lib/boardRepository.js` in `duplicateBoard(...)`
- Create: `scripts/test-board-capacity-cleanup.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces RPC: `public.duplicate_board_v8(p_source_id text, p_source_owner_key_hash text, p_new_id text, p_new_title text, p_new_owner_key_hash text, p_new_share_key_hash text, p_new_realtime_key text) returns boolean`.
- Consumes existing client flow: flush pending actions -> `getBoardRecovery()` -> copy images -> create destination shell -> `saveBoardSnapshot()`.
- Invariant: `duplicate_board_v8` does not read or write `public.board_objects`.

- [ ] **Step 1: Add failing regression assertions**

Create `scripts/test-board-capacity-cleanup.mjs` with source-level assertions:

```js
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const repository = await readFile(new URL('../src/lib/boardRepository.js', import.meta.url), 'utf8');
const duplicateSql = await readFile(new URL('../supabase/duplicate_board_v8.sql', import.meta.url), 'utf8').catch(() => '');

assert.match(repository, /supabase\.rpc\('duplicate_board_v8'/);
assert.doesNotMatch(repository, /supabase\.rpc\('duplicate_board_v7'/);
assert.match(duplicateSql, /create or replace function public\.duplicate_board_v8/);
assert.doesNotMatch(duplicateSql, /board_objects/);
assert.match(duplicateSql, /revoke execute on function public\.duplicate_board_v7/);
```

- [ ] **Step 2: Run RED**

Run: `node scripts/test-board-capacity-cleanup.mjs`
Expected: FAIL because the v8 duplication SQL does not exist and the client still calls `duplicate_board_v7`.

- [ ] **Step 3: Implement `duplicate_board_v8`**

Create a security-definer RPC that authorizes the source owner key, copies only board metadata into a revision-0 destination board, initializes v8 heads at revision 0, and leaves actual copied state to the existing `saveBoardSnapshot_v8` call:

```sql
create or replace function public.duplicate_board_v8(
  p_source_id text,
  p_source_owner_key_hash text,
  p_new_id text,
  p_new_title text,
  p_new_owner_key_hash text,
  p_new_share_key_hash text,
  p_new_realtime_key text
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  source_board public.boards%rowtype;
begin
  select * into source_board
  from public.boards
  where id = p_source_id and owner_key_hash = p_source_owner_key_hash
  for share;
  if not found then return false; end if;

  insert into public.boards(
    id, title, student_name, owner_key_hash, share_key_hash, realtime_key,
    guest_mode, game_library_visible, snapshot, snapshot_revision, background,
    object_store_version, object_count, next_order_key, revision,
    created_at, updated_at, last_lesson_at, owner_user_id
  ) values (
    p_new_id,
    coalesce(nullif(trim(p_new_title), ''), source_board.title || ' — копия'),
    source_board.student_name,
    p_new_owner_key_hash,
    p_new_share_key_hash,
    p_new_realtime_key,
    'edit', false,
    '{"version":2,"background":"grid","canvas":{"objects":[]}}'::jsonb,
    0,
    source_board.background,
    7, 0, 1024, 0,
    now(), now(), null, auth.uid()
  );

  insert into public.board_action_heads_v8(board_id, revision, log_floor_revision, updated_at)
  values (p_new_id, 0, 0, now());

  return true;
end
$$;

revoke all on function public.duplicate_board_v8(text,text,text,text,text,text,text)
  from public, anon, authenticated;
grant execute on function public.duplicate_board_v8(text,text,text,text,text,text,text)
  to anon, authenticated;
revoke execute on function public.duplicate_board_v7(text,text,text,text,text,text,text)
  from anon, authenticated;
```

- [ ] **Step 4: Switch the client to v8**

In `duplicateBoard(...)`, change only the RPC name from `duplicate_board_v7` to `duplicate_board_v8`. Preserve pending-action flush, exact `getBoardRecovery()`, image copying, rollback-on-failure, and `saveBoardSnapshot()` semantics.

- [ ] **Step 5: Run GREEN and build**

Run: `node scripts/test-board-capacity-cleanup.mjs && npm run build`
Expected: PASS / exit 0.

- [ ] **Step 6: Deploy the v8 duplication SQL before the client**

Apply `supabase/duplicate_board_v8.sql` to the test database first, then production. Only after the RPC exists should the frontend commit be allowed to deploy.

- [ ] **Step 7: End-to-end duplication check**

Create a temporary populated board containing at least one normal object and one Storage-backed image, duplicate it, reopen the duplicate, and compare recovered snapshots after removing volatile `savedAt` fields. Expected: same object IDs/count/geometry/content, image URLs point to the duplicate board prefix, and no row is created in legacy `board_objects`.

---

### Task 2: Add Postgres cleanup measurement, logging, garbage pruning, and oldest-board selection

**Files:**
- Create: `supabase/board_capacity_cleanup_v1.sql`
- Create: `supabase/tests/board_capacity_cleanup_v1.sql`
- Modify: `scripts/test-board-capacity-cleanup.mjs`

**Interfaces:**
- Produces: `public.board_cleanup_log`.
- Produces: `public.board_cleanup_capacity_pressure_v1() returns jsonb`.
- Produces: `public.board_cleanup_board_bytes_v1(p_board_id text) returns bigint`.
- Produces: `public.run_board_capacity_cleanup_v1(p_cleanup_token text, p_capacity_override bigint default null, p_target_bytes bigint default 209715200, p_dry_run boolean default false) returns jsonb`.
- Produces: `public.finish_board_capacity_cleanup_v1(p_run_id bigint, p_storage_objects integer, p_storage_bytes bigint, p_storage_error text) returns void`.
- Only `service_role` can execute destructive/finish RPCs.

- [ ] **Step 1: Extend static test to require safety properties**

Add assertions that the SQL contains the fixed thresholds, advisory lock, oldest-first ordering, `pgstattuple_approx`, 24-hour import retention, 30-day no-op retention, 90-day cleanup-log retention, and explicitly does not contain `vacuum full`, `truncate ... cascade`, `delete from auth`, or direct `delete from storage.objects`.

- [ ] **Step 2: Run RED**

Run: `node scripts/test-board-capacity-cleanup.mjs`
Expected: FAIL because `board_capacity_cleanup_v1.sql` does not exist.

- [ ] **Step 3: Add extension and cleanup log**

Start `board_capacity_cleanup_v1.sql` with:

```sql
create extension if not exists pgstattuple with schema extensions;

create table if not exists public.board_cleanup_log (
  id bigint generated by default as identity primary key,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null,
  raw_database_bytes_before bigint,
  raw_database_bytes_after bigint,
  capacity_pressure_bytes_before bigint,
  capacity_pressure_bytes_after bigint,
  estimated_garbage_bytes bigint not null default 0,
  estimated_board_bytes bigint not null default 0,
  boards_deleted integer not null default 0,
  deleted_board_ids text[] not null default '{}',
  storage_objects_deleted integer not null default 0,
  storage_bytes_deleted bigint not null default 0,
  storage_error text,
  error_text text,
  check (status in ('running','skipped_below_threshold','garbage_only','boards_deleted','failed','busy','unresolved_pressure'))
);

revoke all on public.board_cleanup_log from public, anon, authenticated;
```

- [ ] **Step 4: Implement reusable-space-aware capacity pressure**

`board_cleanup_capacity_pressure_v1()` must return raw bytes, reusable bytes and pressure bytes. For every existing board-owned table, call `extensions.pgstattuple_approx(regclass)` and subtract both `dead_tuple_len` and `approx_free_space` from raw database size, capped at zero. The fixed board table list is the one in the approved spec.

- [ ] **Step 5: Implement deterministic per-board logical footprint**

`board_cleanup_board_bytes_v1(board_id)` sums `pg_column_size(row)` for the board row and all dependent current/legacy board rows with the same board ID. Return at least `1` byte so every board participates in cumulative ordering even if empty.

- [ ] **Step 6: Implement authenticated cleanup RPC**

At function entry verify the supplied token against Vault inside the security-definer function:

```sql
if not exists (
  select 1
  from vault.decrypted_secrets s
  where s.name = 'board_cleanup_token'
    and s.decrypted_secret = p_cleanup_token
) then
  raise exception 'Invalid cleanup token' using errcode = '42501';
end if;
```

Acquire `pg_try_advisory_xact_lock(hashtext('alex-board-capacity-cleanup-v1'))`; if false, return status `busy` without deleting anything.

- [ ] **Step 7: Implement daily garbage pruning before threshold decision**

Inside the same controlled function:

```sql
delete from public.board_object_locks_v8 where expires_at <= now();
delete from public.board_import_chunks_v8 where created_at < now() - interval '24 hours';
delete from public.board_import_chunks where created_at < now() - interval '24 hours';
delete from public.board_action_noop_outcomes_v8 where created_at < now() - interval '30 days';
delete from public.board_cleanup_log where started_at < now() - interval '90 days';
```

Also clear rows from legacy protocol tables after the Task-1 v8 prerequisite has been deployed and old duplicate RPC execution revoked. Never touch current v8 authoritative rows except through board cascade deletion or the listed age-based garbage rules.

- [ ] **Step 8: Implement oldest-prefix selection**

Use one CTE that orders candidates by `coalesce(last_lesson_at, updated_at, created_at), id`, computes `board_cleanup_board_bytes_v1(id)`, and includes the smallest prefix whose cumulative total reaches `p_target_bytes`:

```sql
with sized as (
  select b.id,
         coalesce(b.last_lesson_at, b.updated_at, b.created_at) as age_key,
         public.board_cleanup_board_bytes_v1(b.id) as board_bytes
  from public.boards b
), ordered as (
  select *, sum(board_bytes) over (order by age_key, id) as cumulative_bytes
  from sized
), selected as (
  select * from ordered
  where cumulative_bytes - board_bytes < p_target_bytes
)
select array_agg(id order by age_key, id), coalesce(sum(board_bytes), 0)
from selected;
```

Delete selected boards only when effective pressure is `>= 492830720`. For deterministic SQL tests, `p_capacity_override` replaces measured pressure; production cron always passes `null`. `p_dry_run=true` returns selection without deleting.

- [ ] **Step 9: Implement atomic delete + result log**

Insert a `running` log row before destructive work, update it with selected IDs/bytes, delete only `public.boards` rows by selected ID (relying on existing `ON DELETE CASCADE` FKs), and return JSON containing `runId`, `status`, `deletedBoardIds`, and all size metrics. Exceptions update a failed log when possible and re-raise before any partial board selection can commit.

- [ ] **Step 10: Add SQL transaction regression suite**

`supabase/tests/board_capacity_cleanup_v1.sql` must `begin` and `rollback`, create uniquely prefixed fixture boards, then assert with PL/pgSQL exceptions that:

1. `p_capacity_override=492830719` deletes zero real boards.
2. Expired locks/imports are removed even below threshold.
3. `p_capacity_override=492830720` selects the oldest board first.
4. A small `p_target_bytes` includes the first row crossing the target and no newer board after it.
5. Dependent v8 action/state/head rows cascade away.
6. Teacher-account and Mac-agent row counts are unchanged.
7. Re-running with the same fixture state is idempotent.
8. `p_dry_run=true` never deletes boards.
9. Invalid cleanup token raises `42501`.

- [ ] **Step 11: Run static tests and SQL tests on a disposable Supabase branch**

Run static: `node scripts/test-board-capacity-cleanup.mjs`.

Before creating a Supabase development branch, call the cost API and obtain the user's required cost confirmation. Apply existing migrations plus Tasks 1–2 SQL to the branch, then execute the test SQL. Expected: transaction rolls back with no assertion exception.

---

### Task 3: Add Storage API cleanup Edge Function

**Files:**
- Create: `supabase/functions/board-capacity-cleanup/index.ts`
- Modify: `scripts/test-board-capacity-cleanup.mjs`

**Interfaces:**
- HTTP: `POST /functions/v1/board-capacity-cleanup` with header `x-board-cleanup-token`.
- Consumes `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from Edge Function runtime environment.
- Calls `run_board_capacity_cleanup_v1` with the supplied token.
- Calls `finish_board_capacity_cleanup_v1` after Storage work.

- [ ] **Step 1: Add failing Edge Function source tests**

Assert the function reads `x-board-cleanup-token`, rejects a missing token, uses a service-role Supabase client, calls `run_board_capacity_cleanup_v1`, uses `.storage.from('board-assets').list(...)` and `.remove(...)`, performs an orphan sweep, and never queries/deletes `storage.objects` directly.

- [ ] **Step 2: Run RED**

Run: `node scripts/test-board-capacity-cleanup.mjs`
Expected: FAIL because the Edge Function does not exist.

- [ ] **Step 3: Implement custom-auth request gate**

Use `verify_jwt=false` at deployment because authentication is the Vault-backed cleanup token. Reject non-POST and missing-token requests before constructing destructive work. Pass the token to the protected DB RPC; map SQLSTATE `42501` to HTTP 401/403.

- [ ] **Step 4: Implement paginated prefix removal**

Implement `removePrefix(boardId)` so it repeatedly lists files under `${boardId}/` in bounded pages and removes batches by full path. Count deleted objects and sum `metadata.size` when available. Continue until the prefix is empty.

- [ ] **Step 5: Implement orphan sweep**

List top-level entries in `board-assets`, extract board-ID prefixes, fetch existing board IDs with the service-role client, and call `removePrefix` only for prefixes that have no matching `public.boards` row. This sweep runs every invocation even when DB status is `skipped_below_threshold`, so old orphaned images are eventually removed.

- [ ] **Step 6: Implement failure logging and retry semantics**

If DB deletion succeeds but Storage cleanup fails, call `finish_board_capacity_cleanup_v1` with the error string and return a 5xx response. Do not recreate the board. On the next run, orphan sweep retries the leftover prefix.

- [ ] **Step 7: Run GREEN**

Run: `node scripts/test-board-capacity-cleanup.mjs && npm run build`
Expected: PASS / exit 0.

---

### Task 4: Add secure Vault token, daily Cron invocation, and normal vacuum

**Files:**
- Create: `supabase/board_capacity_cleanup_cron_v1.sql`
- Modify: `scripts/test-board-capacity-cleanup.mjs`

**Interfaces:**
- Vault secret name: `board_cleanup_token`.
- Cleanup cron job name: `alex-board-capacity-cleanup-v1`.
- Vacuum cron job name: `alex-board-capacity-vacuum-v1`.

- [ ] **Step 1: Add failing cron-source assertions**

Require `0 20 * * *`, `20 20 * * *`, `vault.decrypted_secrets`, `net.http_post`, `x-board-cleanup-token`, and `VACUUM (ANALYZE)`. Reject any `VACUUM FULL` string.

- [ ] **Step 2: Run RED**

Run: `node scripts/test-board-capacity-cleanup.mjs`
Expected: FAIL because cron SQL does not exist.

- [ ] **Step 3: Add supported extensions and schedules**

`board_capacity_cleanup_cron_v1.sql` enables:

```sql
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
```

Then upsert `alex-board-capacity-cleanup-v1` with `cron.schedule(..., '0 20 * * *', ...)`, making one `net.http_post` to `${project_url}/functions/v1/board-capacity-cleanup` and loading the random token from Vault into the `x-board-cleanup-token` header.

- [ ] **Step 4: Schedule only normal vacuum**

Schedule `alex-board-capacity-vacuum-v1` at `20 20 * * *` with one `VACUUM (ANALYZE)` over the board-owned tables. Do not include system/auth tables and do not use `VACUUM FULL`.

- [ ] **Step 5: Bound cron history growth**

The DB maintenance function deletes `cron.job_run_details` rows older than 90 days only for the two cleanup-owned job IDs. Do not prune unrelated cron history.

- [ ] **Step 6: Run GREEN**

Run: `node scripts/test-board-capacity-cleanup.mjs`
Expected: PASS.

---

### Task 5: Production deployment and end-to-end verification

**Files:**
- Modify only if verification exposes a proven defect.

- [ ] **Step 1: Run full local regressions**

Run:

```bash
node scripts/test-board-capacity-cleanup.mjs
npm run test:sync
npm run build
```

Expected: all PASS and build exit 0.

- [ ] **Step 2: Review diff before deployment**

Confirm changes are limited to v8 duplication, cleanup SQL/tests, cleanup Edge Function, cron SQL, package test registration, and docs. Confirm no service-role key or cleanup token appears in Git history.

- [ ] **Step 3: Deploy Task 1 compatibility prerequisite**

Apply `duplicate_board_v8.sql`, deploy frontend using it, and run the populated-board duplication verification. Confirm legacy `board_objects` remains empty after the test.

- [ ] **Step 4: Apply cleanup database migration**

Apply `board_capacity_cleanup_v1.sql`. Verify:

```sql
select pg_size_pretty(pg_database_size(current_database()));
select count(*) from public.boards;
select current_setting('default_transaction_read_only');
```

Expected: database remains writable and installation itself has not deleted real boards while pressure is below 470 MiB.

- [ ] **Step 5: Deploy Edge Function with custom authentication**

Deploy `board-capacity-cleanup` with `verify_jwt=false`; this is intentional because the function delegates authentication to the Vault token verified by the DB RPC. Test a request without the token: expected 401/403 and zero cleanup-log destructive activity.

- [ ] **Step 6: Create Vault secrets without committing values**

Generate a cryptographically random cleanup token and store it as `board_cleanup_token`. Store the project URL as `board_cleanup_project_url`. Never print the token in user-visible output or commit it to GitHub.

- [ ] **Step 7: Install cron schedules only after all previous checks pass**

Apply `board_capacity_cleanup_cron_v1.sql`. Query `cron.job` and verify exact schedules:

- `alex-board-capacity-cleanup-v1` -> `0 20 * * *`
- `alex-board-capacity-vacuum-v1` -> `20 20 * * *`

- [ ] **Step 8: Run one immediate authenticated cleanup invocation**

Invoke the Edge Function once using the Vault-backed token. Because the database is currently far below threshold, expected DB result is `skipped_below_threshold`; orphan sweep must nevertheless remove stale `board-assets` prefixes left by the September 6 reset.

- [ ] **Step 9: Verify Storage and database state**

Confirm no orphan prefix remains in `board-assets`, no current board asset was removed, database is writable, teacher/auth records still exist, and the latest `board_cleanup_log` row records the Storage sweep.

- [ ] **Step 10: Verify cron execution path without waiting a day**

Manually execute the exact scheduled HTTP statement once, then inspect `cron.job_run_details`/cleanup log. Expected: successful authenticated run, no real board deletion below threshold.

- [ ] **Step 11: Final production checks**

Query current database size, capacity-pressure function output, two cron jobs, latest cleanup log, Edge Function ACTIVE version, and current board count. Only then report the automation enabled.
