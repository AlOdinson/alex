-- Alex Board 0.4.0: durable actions, tombstones, checksums, snapshots and board library metadata.
-- Run this entire file once in Supabase SQL Editor.

create extension if not exists pgcrypto;

alter table public.boards add column if not exists student_name text not null default '';
alter table public.boards add column if not exists last_lesson_at timestamptz;

create table if not exists public.board_actions (
  board_id text not null references public.boards(id) on delete cascade,
  action_id text not null,
  revision bigint not null,
  client_id text,
  ops jsonb not null default '[]'::jsonb,
  background text,
  created_at timestamptz not null default now(),
  primary key (board_id, action_id)
);
create index if not exists board_actions_revision_idx
  on public.board_actions(board_id, revision);

create table if not exists public.board_tombstones (
  board_id text not null references public.boards(id) on delete cascade,
  object_id text not null,
  deleted_revision bigint not null,
  deleted_at timestamptz not null default now(),
  primary key (board_id, object_id)
);

create table if not exists public.board_snapshots (
  board_id text not null references public.boards(id) on delete cascade,
  revision bigint not null,
  snapshot jsonb not null,
  created_at timestamptz not null default now(),
  primary key (board_id, revision)
);
create index if not exists board_snapshots_recent_idx
  on public.board_snapshots(board_id, revision desc);

alter table public.board_actions enable row level security;
alter table public.board_tombstones enable row level security;
alter table public.board_snapshots enable row level security;
revoke all on table public.board_actions from anon, authenticated;
revoke all on table public.board_tombstones from anon, authenticated;
revoke all on table public.board_snapshots from anon, authenticated;

create or replace function public.get_board_access_v4(
  p_id text,
  p_key_hash text
)
returns table (
  permission text,
  title text,
  student_name text,
  guest_mode text,
  realtime_key text,
  snapshot jsonb,
  revision bigint,
  updated_at timestamptz,
  created_at timestamptz,
  last_lesson_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  b public.boards%rowtype;
begin
  select * into b from public.boards where id = p_id;
  if not found then return; end if;

  if p_key_hash = b.owner_key_hash then
    return query select
      'owner'::text,
      b.title,
      b.student_name,
      b.guest_mode,
      b.realtime_key,
      b.snapshot,
      b.revision,
      b.updated_at,
      b.created_at,
      coalesce(b.last_lesson_at, b.updated_at);
    return;
  end if;

  if p_key_hash = b.share_key_hash then
    if b.guest_mode = 'closed' then
      return query select
        'closed'::text,
        b.title,
        b.student_name,
        b.guest_mode,
        null::text,
        null::jsonb,
        b.revision,
        b.updated_at,
        b.created_at,
        coalesce(b.last_lesson_at, b.updated_at);
    else
      return query select
        b.guest_mode,
        b.title,
        b.student_name,
        b.guest_mode,
        b.realtime_key,
        b.snapshot,
        b.revision,
        b.updated_at,
        b.created_at,
        coalesce(b.last_lesson_at, b.updated_at);
    end if;
  end if;
end;
$$;

create or replace function public.apply_board_action_v4(
  p_id text,
  p_key_hash text,
  p_action_id text,
  p_client_id text default null,
  p_ops jsonb default '[]'::jsonb,
  p_background text default null,
  p_client_revision bigint default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  b public.boards%rowtype;
  previous_action public.board_actions%rowtype;
  current_snapshot jsonb;
  objects jsonb;
  op jsonb;
  object_value jsonb;
  v_object_id text;
  requested_index integer;
  object_count integer;
  server_revision_before bigint;
  new_revision bigint;
  new_updated_at timestamptz;
  changed boolean := false;
  allow_restore boolean;
  rejected boolean := false;
begin
  if p_action_id is null or trim(p_action_id) = '' then
    raise exception 'Action id is required';
  end if;

  select * into b
  from public.boards
  where id = p_id
  for update;

  if not found then return null; end if;
  if not (
    b.owner_key_hash = p_key_hash
    or (b.share_key_hash = p_key_hash and b.guest_mode = 'edit')
  ) then return null; end if;

  select * into previous_action
  from public.board_actions
  where board_id = p_id and action_id = p_action_id;

  if found then
    return jsonb_build_object(
      'revision', previous_action.revision,
      'needs_sync', b.revision > coalesce(p_client_revision, 0),
      'updated_at', b.updated_at,
      'already_applied', true,
      'changed', false
    );
  end if;

  server_revision_before := b.revision;
  new_revision := b.revision + 1;
  current_snapshot := case
    when jsonb_typeof(b.snapshot) = 'object' then b.snapshot
    else '{"version":2,"background":"grid","canvas":{"objects":[]}}'::jsonb
  end;

  if jsonb_typeof(current_snapshot -> 'canvas') is distinct from 'object' then
    current_snapshot := jsonb_set(current_snapshot, '{canvas}', '{"objects":[]}'::jsonb, true);
  end if;
  objects := current_snapshot #> '{canvas,objects}';
  if jsonb_typeof(objects) is distinct from 'array' then objects := '[]'::jsonb; end if;

  if p_ops is not null and jsonb_typeof(p_ops) = 'array' then
    for op in select value from jsonb_array_elements(p_ops)
    loop
      if op ->> 'type' = 'delete' then
        v_object_id := op ->> 'id';
        if v_object_id is null or v_object_id = '' then continue; end if;

        select coalesce(jsonb_agg(value order by ord), '[]'::jsonb)
        into objects
        from jsonb_array_elements(objects) with ordinality as existing(value, ord)
        where existing.value ->> 'boardObjectId' is distinct from v_object_id;

        insert into public.board_tombstones(board_id, object_id, deleted_revision, deleted_at)
        values (p_id, v_object_id, new_revision, now())
        on conflict (board_id, object_id) do update
        set deleted_revision = excluded.deleted_revision,
            deleted_at = excluded.deleted_at;
        changed := true;
        continue;
      end if;

      if op ->> 'type' = 'upsert' then
        object_value := op -> 'object';
        v_object_id := object_value ->> 'boardObjectId';
        if object_value is null or v_object_id is null or v_object_id = '' then continue; end if;
        allow_restore := coalesce((op ->> 'restore')::boolean, false);

        if exists (
          select 1 from public.board_tombstones
          where board_id = p_id and object_id = v_object_id
        ) then
          if not allow_restore then
            rejected := true;
            continue;
          end if;
          delete from public.board_tombstones
          where board_id = p_id and object_id = v_object_id;
        end if;

        select coalesce(jsonb_agg(value order by ord), '[]'::jsonb)
        into objects
        from jsonb_array_elements(objects) with ordinality as existing(value, ord)
        where existing.value ->> 'boardObjectId' is distinct from v_object_id;

        object_count := jsonb_array_length(objects);
        if coalesce(op ->> 'zIndex', '') ~ '^-?[0-9]+$' then
          requested_index := (op ->> 'zIndex')::integer;
        else requested_index := object_count;
        end if;
        requested_index := greatest(0, least(object_count, requested_index));

        select coalesce(jsonb_agg(item order by sort_order, source_order), '[]'::jsonb)
        into objects
        from (
          select
            existing.value as item,
            case
              when (existing.ord - 1) < requested_index then (existing.ord - 1) * 2
              else (existing.ord - 1) * 2 + 2
            end as sort_order,
            existing.ord as source_order
          from jsonb_array_elements(objects) with ordinality as existing(value, ord)
          union all
          select object_value, requested_index * 2 + 1, 0::bigint
        ) ordered_objects;
        changed := true;
      end if;
    end loop;
  end if;

  current_snapshot := jsonb_set(current_snapshot, '{version}', to_jsonb(2), true);
  current_snapshot := jsonb_set(current_snapshot, '{canvas,objects}', objects, true);

  if p_background in ('grid', 'dots', 'blank') then
    current_snapshot := jsonb_set(current_snapshot, '{background}', to_jsonb(p_background), true);
    changed := true;
  end if;

  if changed then
    new_updated_at := now();
    update public.boards
    set snapshot = current_snapshot,
        revision = new_revision,
        updated_at = new_updated_at,
        last_lesson_at = new_updated_at
    where id = p_id;
  else
    new_revision := b.revision;
    new_updated_at := b.updated_at;
  end if;

  insert into public.board_actions(
    board_id, action_id, revision, client_id, ops, background, created_at
  ) values (
    p_id, p_action_id, new_revision, p_client_id,
    case when changed then coalesce(p_ops, '[]'::jsonb) else '[]'::jsonb end,
    case when changed then p_background else null end,
    now()
  );

  if changed and new_revision % 100 = 0 then
    insert into public.board_snapshots(board_id, revision, snapshot)
    values (p_id, new_revision, current_snapshot)
    on conflict (board_id, revision) do nothing;

    delete from public.board_snapshots s
    where s.board_id = p_id
      and s.revision not in (
        select revision from public.board_snapshots
        where board_id = p_id
        order by revision desc
        limit 8
      );
  end if;

  return jsonb_build_object(
    'revision', new_revision,
    'needs_sync', server_revision_before > coalesce(p_client_revision, 0) or rejected,
    'updated_at', new_updated_at,
    'already_applied', false,
    'changed', changed
  );
end;
$$;

-- Route older 0.3.x clients through the same tombstone-aware server path.
create or replace function public.apply_board_ops(
  p_id text,
  p_key_hash text,
  p_ops jsonb default '[]'::jsonb,
  p_background text default null,
  p_client_revision bigint default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  return public.apply_board_action_v4(
    p_id,
    p_key_hash,
    'legacy-' || gen_random_uuid()::text,
    'legacy-client',
    p_ops,
    p_background,
    p_client_revision
  );
end;
$$;

create or replace function public.get_board_changes_v4(
  p_id text,
  p_key_hash text,
  p_since_revision bigint default 0,
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
security definer
set search_path = public
as $$
declare
  b public.boards%rowtype;
begin
  select * into b from public.boards where id = p_id;
  if not found then return; end if;
  if not (p_key_hash = b.owner_key_hash or p_key_hash = b.share_key_hash) then return; end if;

  return query
  select a.revision, a.action_id, a.client_id, a.ops, a.background, a.created_at
  from public.board_actions a
  where a.board_id = p_id
    and a.revision > coalesce(p_since_revision, 0)
  order by a.revision asc, a.created_at asc
  limit greatest(1, least(coalesce(p_limit, 500), 1000));
end;
$$;

create or replace function public.get_board_sync_state_v4(
  p_id text,
  p_key_hash text
)
returns table (
  revision bigint,
  object_count integer,
  state_hash text,
  updated_at timestamptz,
  permission text,
  guest_mode text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  b public.boards%rowtype;
  objects jsonb;
  canonical text;
  resolved_permission text;
begin
  select * into b from public.boards where id = p_id;
  if not found then return; end if;

  if p_key_hash = b.owner_key_hash then resolved_permission := 'owner';
  elsif p_key_hash = b.share_key_hash then resolved_permission := b.guest_mode;
  else return;
  end if;

  objects := b.snapshot #> '{canvas,objects}';
  if jsonb_typeof(objects) is distinct from 'array' then objects := '[]'::jsonb; end if;

  select coalesce(b.snapshot ->> 'background', 'grid') || '|' || coalesce(
    string_agg(
      (item.ord - 1)::text || ':' ||
      coalesce(item.value ->> 'boardObjectId', '') || ':' ||
      coalesce(item.value ->> 'updatedAt', '') || ':' ||
      coalesce(item.value ->> 'type', ''),
      '|' order by item.ord
    ),
    ''
  ) into canonical
  from jsonb_array_elements(objects) with ordinality as item(value, ord);

  return query select
    b.revision,
    jsonb_array_length(objects),
    rtrim(translate(encode(digest(convert_to(canonical, 'UTF8'), 'sha256'), 'base64'), '+/', '-_'), '='),
    b.updated_at,
    resolved_permission,
    b.guest_mode;
end;
$$;

create or replace function public.get_board_recovery_v4(
  p_id text,
  p_key_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  b public.boards%rowtype;
  snapshot_row public.board_snapshots%rowtype;
  result_snapshot jsonb;
  result_revision bigint;
  result_actions jsonb;
begin
  select * into b from public.boards where id = p_id;
  if not found then return null; end if;
  if not (p_key_hash = b.owner_key_hash or p_key_hash = b.share_key_hash) then return null; end if;

  select * into snapshot_row
  from public.board_snapshots
  where board_id = p_id
  order by revision desc
  limit 1;

  if found then
    result_snapshot := snapshot_row.snapshot;
    result_revision := snapshot_row.revision;
    select coalesce(jsonb_agg(jsonb_build_object(
      'revision', a.revision,
      'ops', a.ops,
      'background', a.background
    ) order by a.revision, a.created_at), '[]'::jsonb)
    into result_actions
    from public.board_actions a
    where a.board_id = p_id and a.revision > result_revision;
  else
    result_snapshot := b.snapshot;
    result_revision := b.revision;
    result_actions := '[]'::jsonb;
  end if;

  return jsonb_build_object(
    'snapshot_revision', result_revision,
    'snapshot', result_snapshot,
    'actions', result_actions,
    'current_revision', b.revision
  );
end;
$$;

create or replace function public.set_board_metadata_v4(
  p_id text,
  p_owner_key_hash text,
  p_title text default null,
  p_student_name text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.boards
  set title = case
        when p_title is null then title
        else coalesce(nullif(trim(p_title), ''), title)
      end,
      student_name = case
        when p_student_name is null then student_name
        else left(trim(p_student_name), 120)
      end,
      updated_at = now()
  where id = p_id and owner_key_hash = p_owner_key_hash;
  return found;
end;
$$;

create or replace function public.delete_board_v4(
  p_id text,
  p_owner_key_hash text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.boards where id = p_id and owner_key_hash = p_owner_key_hash;
  return found;
end;
$$;

create or replace function public.duplicate_board_v4(
  p_source_id text,
  p_source_owner_key_hash text,
  p_new_id text,
  p_new_title text,
  p_new_owner_key_hash text,
  p_new_share_key_hash text,
  p_new_realtime_key text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  source_board public.boards%rowtype;
begin
  select * into source_board
  from public.boards
  where id = p_source_id and owner_key_hash = p_source_owner_key_hash;
  if not found then return false; end if;

  insert into public.boards(
    id, title, student_name, owner_key_hash, share_key_hash, realtime_key,
    guest_mode, snapshot, revision, created_at, updated_at, last_lesson_at
  ) values (
    p_new_id,
    coalesce(nullif(trim(p_new_title), ''), source_board.title || ' — копия'),
    source_board.student_name,
    p_new_owner_key_hash,
    p_new_share_key_hash,
    p_new_realtime_key,
    'edit',
    source_board.snapshot,
    0,
    now(),
    now(),
    null
  );
  return true;
end;
$$;

revoke all on function public.get_board_access_v4(text, text) from public;
revoke all on function public.apply_board_action_v4(text, text, text, text, jsonb, text, bigint) from public;
revoke all on function public.get_board_changes_v4(text, text, bigint, integer) from public;
revoke all on function public.get_board_sync_state_v4(text, text) from public;
revoke all on function public.get_board_recovery_v4(text, text) from public;
revoke all on function public.set_board_metadata_v4(text, text, text, text) from public;
revoke all on function public.delete_board_v4(text, text) from public;
revoke all on function public.duplicate_board_v4(text, text, text, text, text, text, text) from public;

grant execute on function public.get_board_access_v4(text, text) to anon, authenticated;
grant execute on function public.apply_board_action_v4(text, text, text, text, jsonb, text, bigint) to anon, authenticated;
grant execute on function public.get_board_changes_v4(text, text, bigint, integer) to anon, authenticated;
grant execute on function public.get_board_sync_state_v4(text, text) to anon, authenticated;
grant execute on function public.get_board_recovery_v4(text, text) to anon, authenticated;
grant execute on function public.set_board_metadata_v4(text, text, text, text) to anon, authenticated;
grant execute on function public.delete_board_v4(text, text) to anon, authenticated;
grant execute on function public.duplicate_board_v4(text, text, text, text, text, text, text) to anon, authenticated;

select 'Alex Board 0.4.0 collaboration upgrade installed' as result;
