-- Alex Board 1.32.0
-- Strict authoritative operation log v8.
-- Run once in the Supabase SQL editor before deploying the v1.32.0 client.

begin;

create table if not exists public.board_actions_v8 (
  board_id text not null references public.boards(id) on delete cascade,
  revision bigint not null,
  action_id text not null,
  client_id text not null default '',
  ops jsonb not null default '[]'::jsonb,
  background text,
  created_at timestamptz not null default now(),
  primary key (board_id, revision),
  unique (board_id, action_id),
  check (jsonb_typeof(ops) = 'array'),
  check (background is null or background in ('grid', 'dots', 'blank'))
);

create table if not exists public.board_action_heads_v8 (
  board_id text primary key references public.boards(id) on delete cascade,
  revision bigint not null default 0,
  log_floor_revision bigint not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.board_import_chunks_v8 (
  board_id text not null references public.boards(id) on delete cascade,
  import_id text not null,
  chunk_index integer not null check (chunk_index >= 0),
  action_id text not null,
  client_id text not null default '',
  ops jsonb not null check (jsonb_typeof(ops) = 'array'),
  created_at timestamptz not null default now(),
  primary key (board_id, import_id, chunk_index)
);

-- Reuse the previous durable journal when it has the conventional v5-v7 schema.
-- Legacy servers could record no-op retries at an already-used revision. They carry no
-- state, so importing them into a strict one-row-per-revision log would be both ambiguous
-- and unsafe. Only state-changing rows are copied; the preflight audit must confirm that
-- these meaningful rows are unique and continuous for every board.
do $bootstrap$
declare
  v_table text;
begin
  for v_table in
    select c.table_name
    from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name <> 'board_actions_v8'
    group by c.table_name
    having count(*) filter (where c.column_name in (
      'board_id', 'revision', 'action_id', 'client_id', 'ops', 'background', 'created_at'
    )) = 7
      and bool_or(c.column_name = 'ops' and c.data_type in ('json', 'jsonb'))
  loop
    execute format($copy$
      insert into public.board_actions_v8 (
        board_id, revision, action_id, client_id, ops, background, created_at
      )
      select
        board_id::text,
        revision::bigint,
        action_id::text,
        coalesce(client_id::text, ''),
        coalesce(ops::jsonb, '[]'::jsonb),
        background::text,
        coalesce(created_at, now())
      from public.%I
      where jsonb_array_length(coalesce(ops::jsonb, '[]'::jsonb)) > 0
         or background is not null
      on conflict do nothing
    $copy$, v_table);
  end loop;
end
$bootstrap$;

insert into public.board_action_heads_v8 (board_id, revision, log_floor_revision, updated_at)
select
  b.id::text,
  coalesce(b.revision, 0)::bigint,
  greatest(0, coalesce((
    select min(a.revision) - 1
    from public.board_actions_v8 a
    where a.board_id = b.id::text
  ), coalesce(b.revision, 0)::bigint)),
  coalesce(b.updated_at, now())
from public.boards b
on conflict (board_id) do update set
  revision = greatest(public.board_action_heads_v8.revision, excluded.revision),
  log_floor_revision = least(
    public.board_action_heads_v8.log_floor_revision,
    excluded.log_floor_revision
  ),
  updated_at = greatest(public.board_action_heads_v8.updated_at, excluded.updated_at);

alter table public.board_actions_v8 enable row level security;
alter table public.board_import_chunks_v8 enable row level security;
alter table public.board_action_heads_v8 enable row level security;

drop policy if exists board_action_heads_v8_realtime_read on public.board_action_heads_v8;
create policy board_action_heads_v8_realtime_read
  on public.board_action_heads_v8
  for select
  using (true);

revoke all on public.board_actions_v8 from public, anon, authenticated;
revoke all on public.board_import_chunks_v8 from public, anon, authenticated;
revoke all on public.board_action_heads_v8 from public, anon, authenticated;
grant select on public.board_action_heads_v8 to anon, authenticated;

create or replace function public.board_v8_permission(p_id text, p_key_hash text)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when b.owner_key_hash = p_key_hash then 'owner'
    when b.share_key_hash = p_key_hash then b.guest_mode::text
    else null
  end
  from public.boards b
  where b.id = p_id
$$;

revoke all on function public.board_v8_permission(text, text) from public, anon, authenticated;

create or replace function public.get_board_protocol_v8(p_id text, p_key_hash text)
returns table (protocol_version integer, revision bigint, log_floor_revision bigint)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_revision bigint;
begin
  if public.board_v8_permission(p_id, p_key_hash) is null then return; end if;
  select coalesce(b.revision, 0)::bigint into v_revision
  from public.boards b where b.id = p_id;

  insert into public.board_action_heads_v8 (board_id, revision, log_floor_revision)
  values (p_id, v_revision, v_revision)
  on conflict (board_id) do update set
    revision = greatest(public.board_action_heads_v8.revision, excluded.revision),
    updated_at = now();

  return query
  select 8, h.revision, h.log_floor_revision
  from public.board_action_heads_v8 h where h.board_id = p_id;
end
$$;

create or replace function public.get_board_revision_v8(p_id text, p_key_hash text)
returns table (revision bigint, updated_at timestamptz, permission text, guest_mode text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    coalesce(b.revision, 0)::bigint,
    b.updated_at,
    public.board_v8_permission(p_id, p_key_hash),
    b.guest_mode::text
  from public.boards b
  where b.id = p_id and public.board_v8_permission(p_id, p_key_hash) is not null
$$;

create or replace function public.get_board_access_v8(p_id text, p_key_hash text)
returns table (
  permission text,
  title text,
  student_name text,
  guest_mode text,
  game_library_visible boolean,
  realtime_key text,
  snapshot jsonb,
  revision bigint,
  snapshot_revision bigint,
  updated_at timestamptz,
  created_at timestamptz,
  last_lesson_at timestamptz,
  protocol_version integer,
  log_floor_revision bigint
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_permission text;
begin
  v_permission := public.board_v8_permission(p_id, p_key_hash);
  if v_permission is null then return; end if;

  insert into public.board_action_heads_v8 (board_id, revision, log_floor_revision)
  select b.id::text, coalesce(b.revision, 0)::bigint, coalesce(b.revision, 0)::bigint
  from public.boards b where b.id = p_id
  on conflict (board_id) do update set
    revision = greatest(public.board_action_heads_v8.revision, excluded.revision),
    updated_at = now();

  return query
  select
    v_permission,
    b.title::text,
    coalesce(to_jsonb(b)->>'student_name', ''),
    b.guest_mode::text,
    coalesce((to_jsonb(b)->>'game_library_visible')::boolean, false),
    b.realtime_key::text,
    b.snapshot::jsonb,
    coalesce(b.revision, 0)::bigint,
    coalesce(b.snapshot_revision, b.revision, 0)::bigint,
    b.updated_at,
    b.created_at,
    coalesce((to_jsonb(b)->>'last_lesson_at')::timestamptz, b.updated_at),
    8,
    h.log_floor_revision
  from public.boards b
  join public.board_action_heads_v8 h on h.board_id = b.id::text
  where b.id = p_id;
end
$$;

create or replace function public.get_board_changes_v8(
  p_id text,
  p_key_hash text,
  p_since_revision bigint,
  p_limit integer default 500
)
returns table (
  revision bigint,
  action_id text,
  client_id text,
  ops jsonb,
  background text,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_floor bigint;
begin
  if public.board_v8_permission(p_id, p_key_hash) is null then return; end if;
  select h.log_floor_revision into v_floor
  from public.board_action_heads_v8 h where h.board_id = p_id;
  if p_since_revision < coalesce(v_floor, 0) then
    raise exception 'BOARD_V8_LOG_FLOOR:%', coalesce(v_floor, 0)
      using errcode = 'P0001';
  end if;
  return query
  select a.revision, a.action_id, a.client_id, a.ops, a.background, a.created_at
  from public.board_actions_v8 a
  where a.board_id = p_id and a.revision > p_since_revision
  order by a.revision
  limit greatest(1, least(coalesce(p_limit, 500), 1000));
end
$$;

create or replace function public.get_board_recovery_v8(p_id text, p_key_hash text)
returns table (
  snapshot jsonb,
  snapshot_revision bigint,
  current_revision bigint,
  actions jsonb
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_snapshot jsonb;
  v_snapshot_revision bigint;
  v_current_revision bigint;
  v_floor bigint;
begin
  if public.board_v8_permission(p_id, p_key_hash) is null then return; end if;
  select
    b.snapshot::jsonb,
    coalesce(b.snapshot_revision, b.revision, 0)::bigint,
    coalesce(b.revision, 0)::bigint
  into v_snapshot, v_snapshot_revision, v_current_revision
  from public.boards b where b.id = p_id;

  select h.log_floor_revision into v_floor
  from public.board_action_heads_v8 h where h.board_id = p_id;
  if v_snapshot_revision < coalesce(v_floor, 0) then
    raise exception 'BOARD_V8_BOOTSTRAP_SNAPSHOT_REQUIRED:%:%', v_snapshot_revision, v_floor
      using errcode = 'P0001';
  end if;

  return query select
    v_snapshot,
    v_snapshot_revision,
    v_current_revision,
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'revision', a.revision,
        'actionId', a.action_id,
        'clientId', a.client_id,
        'ops', a.ops,
        'background', a.background,
        'createdAt', a.created_at
      ) order by a.revision)
      from public.board_actions_v8 a
      where a.board_id = p_id and a.revision > v_snapshot_revision
    ), '[]'::jsonb);
end
$$;

create or replace function public.apply_board_action_v8(
  p_id text,
  p_key_hash text,
  p_action_id text,
  p_client_id text,
  p_ops jsonb,
  p_background text,
  p_client_revision bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_permission text;
  v_before bigint;
  v_revision bigint;
  v_existing public.board_actions_v8%rowtype;
  v_ops jsonb := coalesce(p_ops, '[]'::jsonb);
  v_changed boolean;
begin
  if p_action_id is null or length(p_action_id) < 8 then
    raise exception 'Invalid action id' using errcode = '22023';
  end if;
  if jsonb_typeof(v_ops) <> 'array' then
    raise exception 'Operations must be a JSON array' using errcode = '22023';
  end if;
  if p_background is not null and p_background not in ('grid', 'dots', 'blank') then
    raise exception 'Invalid board background' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_ops) op
    where coalesce(op->>'type', '') not in ('upsert', 'delete', 'transform', 'patch')
  ) then
    raise exception 'Unsupported board operation' using errcode = '22023';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(v_ops) op
    where case op->>'type'
      when 'upsert' then
        jsonb_typeof(op->'object') is distinct from 'object'
        or nullif(op->'object'->>'boardObjectId', '') is null
      when 'delete' then
        nullif(op->>'id', '') is null
      when 'patch' then
        nullif(op->>'id', '') is null
        or jsonb_typeof(op->'patch') is distinct from 'object'
        or (
          op ? 'unset'
          and jsonb_typeof(op->'unset') is distinct from 'array'
        )
      when 'transform' then not (
        (
          nullif(op->>'id', '') is not null
          and jsonb_typeof(op->'transform') is not distinct from 'object'
        )
        or case
          when jsonb_typeof(op->'objects') is not distinct from 'array' then
            jsonb_array_length(op->'objects') > 0
            and not exists (
              select 1
              from jsonb_array_elements(op->'objects') entry
              where nullif(entry->>'id', '') is null
                or jsonb_typeof(entry->'transform') is distinct from 'object'
            )
          else false
        end
      )
      else true
    end
  ) then
    raise exception 'Malformed board operation' using errcode = '22023';
  end if;

  select case
    when b.owner_key_hash = p_key_hash then 'owner'
    when b.share_key_hash = p_key_hash then b.guest_mode::text
    else null
  end, coalesce(b.revision, 0)::bigint
  into v_permission, v_before
  from public.boards b
  where b.id = p_id
  for update;

  if v_permission is null or v_permission not in ('owner', 'edit') then
    raise exception 'Board is read-only' using errcode = '42501';
  end if;

  select * into v_existing
  from public.board_actions_v8 a
  where a.board_id = p_id and a.action_id = p_action_id;
  if found then
    return jsonb_build_object(
      'revision', v_existing.revision,
      'needs_sync', v_existing.revision > coalesce(p_client_revision, 0) + 1,
      'updated_at', v_existing.created_at,
      'already_applied', true,
      'changed', true,
      'applied_ops', v_existing.ops,
      'applied_background', v_existing.background,
      'rejected_object_ids', '[]'::jsonb
    );
  end if;

  v_changed := jsonb_array_length(v_ops) > 0 or p_background is not null;
  if not v_changed then
    return jsonb_build_object(
      'revision', v_before,
      'needs_sync', v_before > coalesce(p_client_revision, 0),
      'updated_at', now(),
      'already_applied', false,
      'changed', false,
      'applied_ops', '[]'::jsonb,
      'applied_background', null,
      'rejected_object_ids', '[]'::jsonb
    );
  end if;

  v_revision := v_before + 1;
  insert into public.board_actions_v8 (
    board_id, revision, action_id, client_id, ops, background
  ) values (
    p_id, v_revision, p_action_id, coalesce(p_client_id, ''), v_ops, p_background
  );

  update public.boards
  set revision = v_revision, updated_at = now()
  where id = p_id;

  insert into public.board_action_heads_v8 (board_id, revision, log_floor_revision, updated_at)
  values (p_id, v_revision, v_before, now())
  on conflict (board_id) do update set
    revision = excluded.revision,
    updated_at = excluded.updated_at;

  return jsonb_build_object(
    'revision', v_revision,
    'needs_sync', v_before > coalesce(p_client_revision, 0),
    'updated_at', now(),
    'already_applied', false,
    'changed', true,
    'applied_ops', v_ops,
    'applied_background', p_background,
    'rejected_object_ids', '[]'::jsonb
  );
end
$$;

create or replace function public.apply_board_actions_batch_v8(
  p_id text,
  p_key_hash text,
  p_actions jsonb,
  p_client_revision bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_action jsonb;
  v_result jsonb;
  v_results jsonb := '[]'::jsonb;
  v_revision bigint := coalesce(p_client_revision, 0);
begin
  if jsonb_typeof(coalesce(p_actions, '[]'::jsonb)) <> 'array' then
    raise exception 'Actions must be a JSON array' using errcode = '22023';
  end if;
  for v_action in select value from jsonb_array_elements(coalesce(p_actions, '[]'::jsonb)) loop
    v_result := public.apply_board_action_v8(
      p_id,
      p_key_hash,
      v_action->>'action_id',
      coalesce(v_action->>'client_id', ''),
      coalesce(v_action->'ops', '[]'::jsonb),
      v_action->>'background',
      v_revision
    );
    v_revision := coalesce((v_result->>'revision')::bigint, v_revision);
    v_results := v_results || jsonb_build_array(
      jsonb_build_object('action_id', v_action->>'action_id') || v_result
    );
  end loop;
  return v_results;
end
$$;

create or replace function public.upload_board_import_chunk_v8(
  p_id text,
  p_key_hash text,
  p_import_id text,
  p_chunk_index integer,
  p_action_id text,
  p_client_id text,
  p_ops jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(public.board_v8_permission(p_id, p_key_hash) in ('owner', 'edit'), false) is not true then
    raise exception 'Board is read-only' using errcode = '42501';
  end if;
  if p_import_id is null
    or p_action_id is null
    or length(p_action_id) < 8
    or p_chunk_index is null
    or p_chunk_index < 0
    or jsonb_typeof(coalesce(p_ops, '[]'::jsonb)) <> 'array'
  then
    raise exception 'Invalid import chunk' using errcode = '22023';
  end if;
  insert into public.board_import_chunks_v8 (
    board_id, import_id, chunk_index, action_id, client_id, ops
  ) values (
    p_id, p_import_id, p_chunk_index, p_action_id, coalesce(p_client_id, ''), p_ops
  )
  on conflict (board_id, import_id, chunk_index) do update set
    action_id = excluded.action_id,
    client_id = excluded.client_id,
    ops = excluded.ops,
    created_at = now();
  return true;
end
$$;

create or replace function public.commit_board_import_v8(
  p_id text,
  p_key_hash text,
  p_import_id text,
  p_chunk_count integer,
  p_action_id text,
  p_client_id text,
  p_background text,
  p_client_revision bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ops jsonb;
  v_chunk_count integer;
  v_distinct_chunk_count integer;
  v_min_chunk integer;
  v_max_chunk integer;
  v_result jsonb;
begin
  if coalesce(public.board_v8_permission(p_id, p_key_hash) in ('owner', 'edit'), false) is not true then
    raise exception 'Board is read-only' using errcode = '42501';
  end if;
  if p_import_id is null or p_action_id is null or length(p_action_id) < 8 then
    raise exception 'Invalid board import' using errcode = '22023';
  end if;

  -- Idempotent retry after a successful commit does not require the deleted chunks.
  if exists (
    select 1 from public.board_actions_v8
    where board_id = p_id and action_id = p_action_id
  ) then
    return public.apply_board_action_v8(
      p_id, p_key_hash, p_action_id, p_client_id, '[]'::jsonb, null, p_client_revision
    );
  end if;

  select
    count(*),
    count(distinct c.chunk_index),
    min(c.chunk_index),
    max(c.chunk_index)
  into v_chunk_count, v_distinct_chunk_count, v_min_chunk, v_max_chunk
  from public.board_import_chunks_v8 c
  where c.board_id = p_id
    and c.import_id = p_import_id
    and c.action_id = p_action_id;

  if p_chunk_count is null
    or p_chunk_count <= 0
    or v_chunk_count <> p_chunk_count
    or v_distinct_chunk_count <> p_chunk_count
    or v_min_chunk <> 0
    or v_max_chunk <> p_chunk_count - 1
  then
    raise exception 'Incomplete board import' using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(op order by chunk_index, op_index), '[]'::jsonb)
  into v_ops
  from (
    select c.chunk_index, e.ordinality as op_index, e.value as op
    from public.board_import_chunks_v8 c
    cross join lateral jsonb_array_elements(c.ops) with ordinality e(value, ordinality)
    where c.board_id = p_id
      and c.import_id = p_import_id
      and c.action_id = p_action_id
  ) ordered_ops;

  v_result := public.apply_board_action_v8(
    p_id, p_key_hash, p_action_id, p_client_id, v_ops, p_background, p_client_revision
  );
  delete from public.board_import_chunks_v8
  where board_id = p_id and import_id = p_import_id;
  return v_result;
end
$$;

create or replace function public.save_board_snapshot_v8(
  p_id text,
  p_key_hash text,
  p_snapshot jsonb,
  p_client_revision bigint
)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_permission text;
  v_current bigint;
  v_snapshot_revision bigint;
begin
  select case
    when b.owner_key_hash = p_key_hash then 'owner'
    when b.share_key_hash = p_key_hash then b.guest_mode::text
    else null
  end,
  coalesce(b.revision, 0)::bigint,
  coalesce(b.snapshot_revision, 0)::bigint
  into v_permission, v_current, v_snapshot_revision
  from public.boards b where b.id = p_id for update;

  if v_permission is null or v_permission not in ('owner', 'edit') then
    raise exception 'Board is read-only' using errcode = '42501';
  end if;
  if p_client_revision < v_snapshot_revision or p_client_revision > v_current then
    raise exception 'Snapshot revision is not authoritative' using errcode = 'P0001';
  end if;

  update public.boards
  set snapshot = p_snapshot,
      snapshot_revision = p_client_revision,
      updated_at = now()
  where id = p_id;
  return v_current;
end
$$;

revoke all on function public.get_board_protocol_v8(text, text) from public;
revoke all on function public.get_board_revision_v8(text, text) from public;
revoke all on function public.get_board_access_v8(text, text) from public;
revoke all on function public.get_board_changes_v8(text, text, bigint, integer) from public;
revoke all on function public.get_board_recovery_v8(text, text) from public;
revoke all on function public.apply_board_action_v8(text, text, text, text, jsonb, text, bigint) from public;
revoke all on function public.apply_board_actions_batch_v8(text, text, jsonb, bigint) from public;
revoke all on function public.upload_board_import_chunk_v8(text, text, text, integer, text, text, jsonb) from public;
revoke all on function public.commit_board_import_v8(text, text, text, integer, text, text, text, bigint) from public;
revoke all on function public.save_board_snapshot_v8(text, text, jsonb, bigint) from public;

grant execute on function public.get_board_protocol_v8(text, text) to anon, authenticated;
grant execute on function public.get_board_revision_v8(text, text) to anon, authenticated;
grant execute on function public.get_board_access_v8(text, text) to anon, authenticated;
grant execute on function public.get_board_changes_v8(text, text, bigint, integer) to anon, authenticated;
grant execute on function public.get_board_recovery_v8(text, text) to anon, authenticated;
grant execute on function public.apply_board_action_v8(text, text, text, text, jsonb, text, bigint) to anon, authenticated;
grant execute on function public.apply_board_actions_batch_v8(text, text, jsonb, bigint) to anon, authenticated;
grant execute on function public.upload_board_import_chunk_v8(text, text, text, integer, text, text, jsonb) to anon, authenticated;
grant execute on function public.commit_board_import_v8(text, text, text, integer, text, text, text, bigint) to anon, authenticated;
grant execute on function public.save_board_snapshot_v8(text, text, jsonb, bigint) to anon, authenticated;

-- Old synchronization RPCs are intentionally disabled. Old clients fail visibly instead
-- of writing a second history, running a full-board checker, or rebuilding a stale snapshot.
do $revoke_old_writers$
declare
  v_function regprocedure;
begin
  for v_function in
    select p.oid::regprocedure
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'apply_board_ops',
        'apply_board_action_v4',
        'apply_board_action_v5',
        'apply_board_action_v7',
        'apply_board_actions_batch_v7',
        'upload_board_import_chunk_v6',
        'commit_board_import_v6',
        'commit_board_import_v7',
        'save_board_snapshot',
        'build_board_snapshot_v7',
        'refresh_board_snapshot_v7',
        'get_board_access',
        'get_board_access_v4',
        'get_board_access_v5',
        'get_board_access_v7',
        'get_board_changes_v4',
        'get_board_changes_v5',
        'get_board_recovery_v4',
        'get_board_recovery_v7',
        'get_board_revision',
        'get_board_sync_state_v4',
        'get_board_sync_state_v7'
      )
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', v_function);
  end loop;
end
$revoke_old_writers$;

do $realtime$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'board_action_heads_v8'
  ) then
    alter publication supabase_realtime add table public.board_action_heads_v8;
  end if;
end
$realtime$;

commit;
