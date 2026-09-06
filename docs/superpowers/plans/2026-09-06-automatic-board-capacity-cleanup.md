# Automatic Board Capacity Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep Alex Board's Supabase database below the Free-plan 500 MiB limit by cleaning safe garbage daily and, at 470 MiB effective capacity pressure, deleting the least recently used boards until about 200 MiB of estimated board data has been selected.

**Architecture:** First move board duplication fully to v8 so legacy `board_objects` is no longer a runtime dependency. Then install protected Postgres functions for capacity-pressure measurement, garbage pruning, oldest-board selection, atomic cascade deletion, and logging. A custom-auth Edge Function removes deleted/orphan `board-assets` files through the Storage API. Supabase Cron invokes cleanup at 04:00 UTC+8 and a normal `VACUUM (ANALYZE)` at 04:20 UTC+8.

**Tech Stack:** PostgreSQL/Supabase, `pgstattuple`, `pg_cron`, `pg_net`, Supabase Vault, Supabase Edge Functions, Supabase Storage API, Node regression scripts, Vite.

**Spec:** `docs/superpowers/specs/2026-09-06-automatic-board-capacity-cleanup-design.md`

## Global Constraints

- Threshold: **470 MiB = 492830720 bytes**.
- One destructive batch target: **200 MiB = 209715200 bytes**.
- Cleanup schedule: `0 20 * * *` UTC = **04:00 UTC+8**.
- Vacuum schedule: `20 20 * * *` UTC = **04:20 UTC+8**.
- Oldest ordering: `coalesce(last_lesson_at, updated_at, created_at), id` ascending.
- No board is pinned/protected.
- Never delete `auth.*`, `teacher_accounts_v9`, `teacher_mac_agents_v9`, migrations, Vault secrets, RPC definitions, Realtime config, or Ably config.
- Never directly delete `storage.objects`; Storage deletion must use the Storage API.
- Never schedule `VACUUM FULL`.
- A Vault-backed random token is required for destructive cleanup; a public Supabase key alone is insufficient.
- Cleanup must be idempotent and recover from Storage failure on the next orphan sweep.
- Production cron is the last step and is enabled only after tests pass.

---

### Task 1: Make board duplication v8-native

**Files:**
- Create: `supabase/duplicate_board_v8.sql`
- Modify: `src/lib/boardRepository.js` (`duplicateBoard`)
- Create: `scripts/test-board-capacity-cleanup.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces RPC: `duplicate_board_v8(text,text,text,text,text,text,text) returns boolean`.
- The RPC creates only a revision-0 destination shell; the existing client then saves the exact recovered/copied snapshot with `save_board_snapshot_v8`.
- `duplicate_board_v8` must not reference `board_objects`.

- [ ] **Step 1: Write failing duplication regression**

Add to `scripts/test-board-capacity-cleanup.mjs`:

```js
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const repo = await readFile(new URL('../src/lib/boardRepository.js', import.meta.url), 'utf8');
const dupSql = await readFile(new URL('../supabase/duplicate_board_v8.sql', import.meta.url), 'utf8').catch(() => '');
assert.match(repo, /supabase\.rpc\('duplicate_board_v8'/);
assert.doesNotMatch(repo, /supabase\.rpc\('duplicate_board_v7'/);
assert.match(dupSql, /create or replace function public\.duplicate_board_v8/);
assert.doesNotMatch(dupSql, /board_objects/);
assert.match(dupSql, /revoke execute on function public\.duplicate_board_v7/);
```

- [ ] **Step 2: Run RED**

Run: `node scripts/test-board-capacity-cleanup.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement the destination-shell RPC**

Use the existing `duplicate_board_v7` metadata fields, but do not call `build_board_snapshot_v7` and do not copy `board_objects`. Insert the new board with empty v2 snapshot, revision/snapshot revision 0, `object_count=0`, `next_order_key=1024`, and initialize `board_action_heads_v8` at 0. Grant the new RPC to `anon, authenticated` and revoke `duplicate_board_v7` execute from those roles.

Core shape:

```sql
create or replace function public.duplicate_board_v8(
  p_source_id text, p_source_owner_key_hash text, p_new_id text,
  p_new_title text, p_new_owner_key_hash text,
  p_new_share_key_hash text, p_new_realtime_key text
) returns boolean
language plpgsql security definer set search_path = public, pg_temp
as $$
declare source_board public.boards%rowtype;
begin
  select * into source_board from public.boards
  where id=p_source_id and owner_key_hash=p_source_owner_key_hash for share;
  if not found then return false; end if;

  insert into public.boards(
    id,title,student_name,owner_key_hash,share_key_hash,realtime_key,
    guest_mode,game_library_visible,snapshot,snapshot_revision,background,
    object_store_version,object_count,next_order_key,revision,
    created_at,updated_at,last_lesson_at,owner_user_id
  ) values (
    p_new_id,coalesce(nullif(trim(p_new_title),''),source_board.title || ' — копия'),
    source_board.student_name,p_new_owner_key_hash,p_new_share_key_hash,p_new_realtime_key,
    'edit',false,'{"version":2,"background":"grid","canvas":{"objects":[]}}'::jsonb,
    0,source_board.background,7,0,1024,0,now(),now(),null,auth.uid()
  );
  insert into public.board_action_heads_v8(board_id,revision,log_floor_revision,updated_at)
  values (p_new_id,0,0,now());
  return true;
end $$;
```

- [ ] **Step 4: Switch only the client RPC name**

Change `duplicate_board_v7` to `duplicate_board_v8` in `duplicateBoard`. Preserve pending flush, `getBoardRecovery`, image-copying, rollback, and `saveBoardSnapshot` logic unchanged.

- [ ] **Step 5: Register the focused test**

Add to `package.json`:

```json
"test:capacity-cleanup": "node scripts/test-board-capacity-cleanup.mjs"
```

Also add `node scripts/test-board-capacity-cleanup.mjs &&` to the existing `test:sync` chain.

- [ ] **Step 6: Run GREEN**

Run: `npm run test:capacity-cleanup && npm run build`
Expected: PASS / exit 0.

- [ ] **Step 7: Verify populated duplication end-to-end before legacy cleanup**

On a test environment, create a source board with a normal object and a Storage-backed image, duplicate it, recover both snapshots, remove volatile timestamps, and compare object count/content/geometry. Confirm the duplicate image path begins with the destination board ID and legacy `board_objects` remains empty.

---

### Task 2: Build the protected Postgres cleanup subsystem

**Files:**
- Create: `supabase/board_capacity_cleanup_v1.sql`
- Create: `supabase/tests/board_capacity_cleanup_v1.sql`
- Modify: `scripts/test-board-capacity-cleanup.mjs`

**Interfaces:**
- `board_cleanup_log` — 90-day audit table.
- `board_cleanup_effective_pressure_v1(raw_bytes bigint, reusable_bytes bigint) returns bigint immutable`.
- `board_cleanup_capacity_pressure_v1() returns jsonb`.
- `board_cleanup_board_bytes_v1(board_id text) returns bigint`.
- `run_board_capacity_cleanup_v1(cleanup_token text, capacity_override bigint default null, target_bytes bigint default 209715200, dry_run boolean default false) returns jsonb`.
- `finish_board_capacity_cleanup_v1(run_id bigint, storage_objects integer, storage_bytes bigint, storage_error text) returns void`.
- Destructive/finish RPCs are revoked from `public, anon, authenticated` and granted only to `service_role`.

- [ ] **Step 1: Extend static RED tests**

Require the SQL source to contain `492830720`, `209715200`, `pgstattuple_approx`, `pg_try_advisory_xact_lock`, the exact oldest ordering, 24-hour import retention, 30-day no-op retention, 90-day log retention, and no `VACUUM FULL`, `TRUNCATE ... CASCADE`, `DELETE FROM auth`, or `DELETE FROM storage.objects`.

- [ ] **Step 2: Run RED**

Run: `npm run test:capacity-cleanup`
Expected: FAIL.

- [ ] **Step 3: Create extension, log table, and pressure math helper**

```sql
create extension if not exists pgstattuple with schema extensions;

create or replace function public.board_cleanup_effective_pressure_v1(
  p_raw bigint, p_reusable bigint
) returns bigint language sql immutable as $$
  select greatest(0::bigint, coalesce(p_raw,0)-greatest(0::bigint,coalesce(p_reusable,0)))
$$;

create table if not exists public.board_cleanup_log (
  id bigint generated by default as identity primary key,
  started_at timestamptz not null default now(), finished_at timestamptz,
  status text not null,
  raw_database_bytes_before bigint, raw_database_bytes_after bigint,
  capacity_pressure_bytes_before bigint, capacity_pressure_bytes_after bigint,
  estimated_garbage_bytes bigint not null default 0,
  estimated_board_bytes bigint not null default 0,
  boards_deleted integer not null default 0,
  deleted_board_ids text[] not null default '{}',
  storage_objects_deleted integer not null default 0,
  storage_bytes_deleted bigint not null default 0,
  storage_error text, error_text text
);
revoke all on public.board_cleanup_log from public,anon,authenticated;
```

- [ ] **Step 4: Implement reusable-space-aware measurement**

For each existing board-owned table from the spec, call `extensions.pgstattuple_approx(regclass)` and sum `dead_tuple_len + approx_free_space`. Return JSON `{rawDatabaseBytes,reusableBytes,capacityPressureBytes}` where pressure is calculated only by `board_cleanup_effective_pressure_v1`.

- [ ] **Step 5: Implement deterministic board footprint**

`board_cleanup_board_bytes_v1(id)` sums `pg_column_size(row)` over the `boards` row and all current/legacy board rows with that `board_id`, returning at least 1 byte.

- [ ] **Step 6: Authenticate with Vault before any mutation**

At the top of `run_board_capacity_cleanup_v1`:

```sql
if not exists (
  select 1 from vault.decrypted_secrets
  where name='board_cleanup_token' and decrypted_secret=p_cleanup_token
) then
  raise exception 'Invalid cleanup token' using errcode='42501';
end if;
```

Then acquire `pg_try_advisory_xact_lock(hashtext('alex-board-capacity-cleanup-v1'))`; return `busy` if unavailable.

- [ ] **Step 7: Prune safe garbage every run**

Delete expired `board_object_locks_v8`; import chunks older than 24 hours in both v8/legacy chunk tables; no-op outcomes older than 30 days; cleanup-log rows older than 90 days; and cleanup-owned `cron.job_run_details` older than 90 days. After Task 1 is deployed and legacy duplication execute is revoked, empty the legacy protocol tables that no production client reads/writes.

- [ ] **Step 8: Select the smallest oldest prefix reaching target**

Use:

```sql
with sized as (
  select b.id,
    coalesce(b.last_lesson_at,b.updated_at,b.created_at) age_key,
    public.board_cleanup_board_bytes_v1(b.id) board_bytes
  from public.boards b
), ordered as (
  select *,sum(board_bytes) over(order by age_key,id) cumulative_bytes from sized
), selected as (
  select * from ordered where cumulative_bytes-board_bytes < p_target_bytes
)
select array_agg(id order by age_key,id),coalesce(sum(board_bytes),0) from selected;
```

Production uses measured effective pressure; `p_capacity_override` exists only for deterministic tests. If effective pressure is below 492830720, delete no real boards. `p_dry_run=true` returns selection without deleting.

- [ ] **Step 9: Delete atomically through `boards` only**

Record the run/selection, then delete selected IDs only from `public.boards`; existing `ON DELETE CASCADE` removes dependent board rows. Return JSON with run ID, status, deleted IDs, raw/effective sizes, garbage estimate, and selected bytes. No partial selected-board delete may commit on exception.

- [ ] **Step 10: Write SQL transaction tests**

`supabase/tests/board_capacity_cleanup_v1.sql` runs inside `BEGIN ... ROLLBACK` and asserts:

1. override `492830719` => zero real boards deleted;
2. daily garbage still prunes below threshold;
3. override `492830720` => oldest first;
4. first prefix crossing target is included, no newer board beyond it;
5. dependent v8 rows cascade;
6. auth/teacher/Mac-agent counts remain unchanged;
7. dry-run deletes nothing;
8. repeat run is idempotent;
9. invalid token raises `42501`;
10. `board_cleanup_effective_pressure_v1(524288000,104857600)=419430400`, proving high physical size plus 100 MiB reusable space stays below the 470 MiB trigger.

- [ ] **Step 11: Run on a disposable Supabase branch**

Before creating a branch, call Supabase cost discovery and obtain the required user cost confirmation. Apply Tasks 1–2 SQL and execute the SQL test file. Expected: no assertion exception and full rollback.

---

### Task 3: Implement Storage cleanup with retryable pure helpers

**Files:**
- Create: `supabase/functions/board-capacity-cleanup/storage.mjs`
- Create: `supabase/functions/board-capacity-cleanup/index.ts`
- Create: `scripts/test-board-capacity-cleanup-storage.mjs`
- Modify: `scripts/test-board-capacity-cleanup.mjs`
- Modify: `package.json`

**Interfaces:**
- `removeBoardPrefix(storageBucket, boardId) -> {objectsDeleted,bytesDeleted}`.
- `sweepOrphanPrefixes({storageBucket,existingBoardIds}) -> aggregate result`.
- HTTP `POST /functions/v1/board-capacity-cleanup`, header `x-board-cleanup-token`.

- [ ] **Step 1: Write RED unit tests for Storage helpers**

Use an in-memory fake bucket implementing `list(prefix, options)` and `remove(paths)`. Test that only requested/orphan prefixes are removed, current-board prefixes remain, pagination works, and a forced first `remove` failure leaves files which are successfully removed when the helper is run again.

Run: `node scripts/test-board-capacity-cleanup-storage.mjs`
Expected: FAIL because helper does not exist.

- [ ] **Step 2: Implement `storage.mjs` without Deno dependencies**

Keep it importable by Node and Deno. `removeBoardPrefix` repeatedly lists `${boardId}/` in bounded pages and removes full paths in batches; `sweepOrphanPrefixes` lists top-level prefixes and removes only those absent from `existingBoardIds`.

- [ ] **Step 3: Run Storage helper GREEN**

Run: `node scripts/test-board-capacity-cleanup-storage.mjs`
Expected: PASS, including failure-then-retry case.

- [ ] **Step 4: Write RED Edge Function source assertions**

Require `x-board-cleanup-token`, missing-token rejection, `SUPABASE_SERVICE_ROLE_KEY`, `run_board_capacity_cleanup_v1`, `board-assets`, helper imports, `finish_board_capacity_cleanup_v1`, and absence of direct `storage.objects` SQL.

- [ ] **Step 5: Implement custom-auth Edge Function**

Deploy with `verify_jwt=false` intentionally. Reject non-POST and missing token before work. Construct a service-role Supabase client, pass the header token to the protected DB RPC (Vault verifies it), remove prefixes for deleted IDs, then run orphan sweep even when DB status is `skipped_below_threshold`. Invalid Vault token maps to 401/403.

- [ ] **Step 6: Persist Storage outcome**

Call `finish_board_capacity_cleanup_v1`. If Storage fails after DB deletion, log the error and return 5xx; never recreate a deleted board. The pure-helper retry test proves the next orphan sweep can finish leftover files.

- [ ] **Step 7: Register tests and run GREEN**

Add:

```json
"test:capacity-cleanup": "node scripts/test-board-capacity-cleanup.mjs && node scripts/test-board-capacity-cleanup-storage.mjs"
```

Update the previously added package script to this final value and retain it in `test:sync`.

Run: `npm run test:capacity-cleanup && npm run build`
Expected: PASS / exit 0.

---

### Task 4: Install secure daily Cron and normal vacuum

**Files:**
- Create: `supabase/board_capacity_cleanup_cron_v1.sql`
- Modify: `scripts/test-board-capacity-cleanup.mjs`

**Interfaces:**
- Vault secret `board_cleanup_token`.
- Vault secret `board_cleanup_project_url`.
- Cron jobs `alex-board-capacity-cleanup-v1` and `alex-board-capacity-vacuum-v1`.

- [ ] **Step 1: Write RED schedule assertions**

Require `0 20 * * *`, `20 20 * * *`, `vault.decrypted_secrets`, `net.http_post`, `x-board-cleanup-token`, and `VACUUM (ANALYZE)`; reject `VACUUM FULL`.

- [ ] **Step 2: Implement supported extensions**

```sql
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
```

- [ ] **Step 3: Schedule the Edge Function invocation**

Use `cron.schedule('alex-board-capacity-cleanup-v1','0 20 * * *',...)`. The HTTP URL comes from Vault secret `board_cleanup_project_url`; header `x-board-cleanup-token` comes from Vault secret `board_cleanup_token`. No secret literal is committed.

- [ ] **Step 4: Schedule only normal board-table vacuum**

Use `cron.schedule('alex-board-capacity-vacuum-v1','20 20 * * *',...)` with one `VACUUM (ANALYZE)` command covering board-owned tables. Do not include auth/system schemas and do not use `FULL`.

- [ ] **Step 5: Limit cron history**

Daily DB maintenance removes `cron.job_run_details` older than 90 days only for these two job IDs.

- [ ] **Step 6: Run GREEN**

Run: `npm run test:capacity-cleanup`
Expected: PASS.

---

### Task 5: Deploy in safe order and verify production

**Files:**
- Modify only if a verification step proves a defect.

- [ ] **Step 1: Full repo verification**

Run:

```bash
npm run test:capacity-cleanup
npm run test:sync
npm run build
```

Expected: all PASS.

- [ ] **Step 2: Review diff and secret scan**

Confirm only duplication/cleanup/cron/Edge/tests/docs/package changes. Search for service-role values and cleanup-token literals; expected none.

- [ ] **Step 3: Deploy duplication prerequisite first**

Apply `duplicate_board_v8.sql`, then deploy frontend, then run the populated-board duplication test. Confirm `board_objects` remains empty and old `duplicate_board_v7` cannot be executed by anon/authenticated.

- [ ] **Step 4: Apply cleanup SQL but do not enable cron yet**

Verify DB stays writable and, while effective pressure is below 470 MiB, installing/calling with dry-run deletes no real board.

- [ ] **Step 5: Deploy `board-capacity-cleanup` Edge Function**

Deploy with `verify_jwt=false` because custom Vault-token authentication is mandatory. Request without token and request carrying only a public Supabase key must both fail 401/403 with zero board deletion.

- [ ] **Step 6: Create Vault secrets out-of-band**

Generate a cryptographically random token and save it as `board_cleanup_token`; save the project URL as `board_cleanup_project_url`. Never print the token to the user or commit it.

- [ ] **Step 7: Install cron only now**

Apply `board_capacity_cleanup_cron_v1.sql`. Query `cron.job` and verify exactly `0 20 * * *` and `20 20 * * *`.

- [ ] **Step 8: Run one immediate authenticated invocation**

Expected DB status at the current small database is `skipped_below_threshold`, but orphan sweep still runs and removes stale `board-assets` prefixes from the September 6 reset.

- [ ] **Step 9: Verify current assets are protected**

If any current board exists at deployment time, place/retain a test asset under its prefix and verify orphan sweep leaves it intact while deleting an orphan test prefix.

- [ ] **Step 10: Verify Storage retry in deployed environment**

Use a disposable test prefix and a controlled test client/fake for failure behavior rather than corrupting production Storage. The automated helper test must already prove failure-then-retry; production verification only confirms normal orphan removal.

- [ ] **Step 11: Verify cron path without waiting a day**

Execute the same `net.http_post` statement once manually, then inspect `cron.job_run_details` and `board_cleanup_log`. Expected: successful authenticated run and no real board deletion below threshold.

- [ ] **Step 12: Final evidence before claiming completion**

Record: raw DB size, effective pressure, board count, latest cleanup log, Storage orphan count, two cron schedules, Edge Function ACTIVE version, and `default_transaction_read_only=off`. Only then report automation enabled.
