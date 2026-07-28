-- Alex Board 0.9.7: bounded client queue, batched logical actions and row-based board objects.
-- Run once after collaboration_upgrade_0.9.6.sql.

create extension if not exists pgcrypto;

alter table public.boards
  add column if not exists snapshot_revision bigint not null default 0,
  add column if not exists background text not null default 'grid',
  add column if not exists object_store_version integer not null default 0,
  add column if not exists object_count integer not null default 0,
  add column if not exists next_order_key bigint not null default 1024;

create table if not exists public.board_objects (
  board_id text not null references public.boards(id) on delete cascade,
  object_id text not null,
  object_json jsonb not null,
  z_index bigint not null default 0,
  updated_revision bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (board_id, object_id)
);

create index if not exists board_objects_order_idx
  on public.board_objects(board_id, z_index, object_id);
create index if not exists board_objects_revision_idx
  on public.board_objects(board_id, updated_revision);

alter table public.board_objects enable row level security;
revoke all on table public.board_objects from anon, authenticated;

-- One-time migration of every existing full snapshot into independently writable rows.
insert into public.board_objects(board_id, object_id, object_json, z_index, updated_revision, updated_at)
select
  b.id,
  item.value ->> 'boardObjectId',
  item.value,
  (item.ord - 1) * 1024,
  b.revision,
  b.updated_at
from public.boards b
cross join lateral jsonb_array_elements(
  case
    when jsonb_typeof(b.snapshot #> '{canvas,objects}') = 'array'
      then b.snapshot #> '{canvas,objects}'
    else '[]'::jsonb
  end
) with ordinality as item(value, ord)
where b.object_store_version < 7
  and coalesce(item.value ->> 'boardObjectId', '') <> ''
on conflict (board_id, object_id) do nothing;

update public.boards b
set snapshot_revision = b.revision,
    background = case
      when b.snapshot ->> 'background' in ('grid', 'dots', 'blank') then b.snapshot ->> 'background'
      else 'grid'
    end,
    object_count = (select count(*)::integer from public.board_objects o where o.board_id = b.id),
    next_order_key = coalesce((select max(o.z_index) + 1024 from public.board_objects o where o.board_id = b.id), 1024),
    object_store_version = 7
where b.object_store_version < 7;

create or replace function public.create_board(
  p_id text,
  p_title text,
  p_owner_key_hash text,
  p_share_key_hash text,
  p_realtime_key text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.boards (
    id, title, owner_key_hash, share_key_hash, realtime_key,
    snapshot, snapshot_revision, background, object_store_version, object_count, next_order_key
  ) values (
    p_id,
    coalesce(nullif(trim(p_title), ''), 'Новая доска'),
    p_owner_key_hash,
    p_share_key_hash,
    p_realtime_key,
    '{"version":2,"background":"grid","canvas":{"objects":[]}}'::jsonb,
    0,
    'grid',
    7,
    0,
    1024
  );
end;
$$;

create or replace function public.build_board_snapshot_v7(p_id text)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'version', 2,
    'background', coalesce(b.background, 'grid'),
    'canvas', jsonb_build_object(
      'objects', coalesce(
        (
          select jsonb_agg(o.object_json order by o.z_index, o.object_id)
          from public.board_objects o
          where o.board_id = b.id
        ),
        '[]'::jsonb
      )
    ),
    'savedAt', to_jsonb(now())
  )
  from public.boards b
  where b.id = p_id;
$$;

create or replace function public.refresh_board_snapshot_v7(
  p_id text,
  p_revision bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  b public.boards%rowtype;
  next_snapshot jsonb;
  target_revision bigint;
begin
  select * into b from public.boards where id = p_id for update;
  if not found then return null; end if;
  target_revision := least(b.revision, coalesce(p_revision, b.revision));
  next_snapshot := public.build_board_snapshot_v7(p_id);

  update public.boards
  set snapshot = next_snapshot,
      snapshot_revision = target_revision
  where id = p_id;

  insert into public.board_snapshots(board_id, revision, snapshot)
  values (p_id, target_revision, next_snapshot)
  on conflict (board_id, revision) do update set snapshot = excluded.snapshot;

  delete from public.board_snapshots s
  where s.board_id = p_id
    and s.revision not in (
      select revision
      from public.board_snapshots
      where board_id = p_id
      order by revision desc
      limit 8
    );

  return next_snapshot;
end;
$$;

create or replace function public.apply_board_action_v7(
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
  op jsonb;
  object_value jsonb;
  effective_op jsonb;
  effective_ops jsonb := '[]'::jsonb;
  rejected_object_ids jsonb := '[]'::jsonb;
  delete_ids jsonb := '[]'::jsonb;
  reorder_ids jsonb := '[]'::jsonb;
  v_object_id text;
  requested_index integer;
  candidate_count integer;
  current_rank integer;
  old_order bigint;
  previous_order bigint;
  following_order bigint;
  target_order bigint;
  working_object_count integer;
  working_next_order bigint;
  new_revision bigint;
  new_updated_at timestamptz;
  server_revision_before bigint;
  changed boolean := false;
  allow_restore boolean;
  allow_reorder boolean;
  object_exists boolean;
  deleted_existing boolean;
  removed_reorder_count integer := 0;
  background_changed boolean := false;
begin
  if p_action_id is null or trim(p_action_id) = '' then
    raise exception 'Action id is required';
  end if;

  select * into b from public.boards where id = p_id for update;
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
      'action_id', p_action_id,
      'revision', previous_action.revision,
      'needs_sync', b.revision > coalesce(p_client_revision, 0)
        or jsonb_array_length(coalesce(previous_action.rejected_object_ids, '[]'::jsonb)) > 0,
      'updated_at', b.updated_at,
      'already_applied', true,
      'changed', jsonb_array_length(coalesce(previous_action.ops, '[]'::jsonb)) > 0
        or previous_action.background is not null,
      'applied_ops', coalesce(previous_action.ops, '[]'::jsonb),
      'applied_background', previous_action.background,
      'rejected_object_ids', coalesce(previous_action.rejected_object_ids, '[]'::jsonb)
    );
  end if;

  server_revision_before := b.revision;
  new_revision := b.revision + 1;
  working_object_count := greatest(0, coalesce(b.object_count, 0));
  working_next_order := greatest(1024, coalesce(b.next_order_key, 1024));

  -- Atomic preflight: one forbidden resurrection rejects the whole logical action.
  if p_ops is not null and jsonb_typeof(p_ops) = 'array' then
    for op in select value from jsonb_array_elements(p_ops)
    loop
      if op ->> 'type' = 'delete' and coalesce(op ->> 'id', '') <> '' then
        delete_ids := delete_ids || jsonb_build_array(op ->> 'id');
      elsif op ->> 'type' = 'upsert' then
        object_value := op -> 'object';
        v_object_id := object_value ->> 'boardObjectId';
        if coalesce(v_object_id, '') <> ''
          and ((op ->> 'reorder') = 'true' or (op ->> 'restore') = 'true')
          and not (reorder_ids ? v_object_id) then
          reorder_ids := reorder_ids || jsonb_build_array(v_object_id);
        end if;
      end if;
    end loop;

    for op in select value from jsonb_array_elements(p_ops)
    loop
      if op ->> 'type' <> 'upsert' then continue; end if;
      object_value := op -> 'object';
      v_object_id := object_value ->> 'boardObjectId';
      if object_value is null or coalesce(v_object_id, '') = '' then continue; end if;
      allow_restore := coalesce((op ->> 'restore')::boolean, false);
      if not allow_restore and (
        delete_ids ? v_object_id
        or exists (
          select 1 from public.board_tombstones
          where board_id = p_id and object_id = v_object_id
        )
      ) then
        rejected_object_ids := rejected_object_ids || jsonb_build_array(v_object_id);
      end if;
    end loop;
  end if;

  if jsonb_array_length(rejected_object_ids) > 0 then
    insert into public.board_actions(
      board_id, action_id, revision, client_id, ops, background, rejected_object_ids, created_at
    ) values (
      p_id, p_action_id, b.revision, p_client_id,
      '[]'::jsonb, null, rejected_object_ids, now()
    );
    return jsonb_build_object(
      'action_id', p_action_id,
      'revision', b.revision,
      'needs_sync', true,
      'updated_at', b.updated_at,
      'already_applied', false,
      'changed', false,
      'applied_ops', '[]'::jsonb,
      'applied_background', null,
      'rejected_object_ids', rejected_object_ids
    );
  end if;

  -- Explicit layer changes and Undo restorations are applied as one ordering group.
  -- Removing every affected row first makes final zIndex values deterministic even
  -- when several selected objects move across unselected objects in one action.
  if jsonb_array_length(reorder_ids) > 0 then
    select count(*)::integer into removed_reorder_count
    from public.board_objects o
    where o.board_id = p_id and reorder_ids ? o.object_id;

    delete from public.board_objects o
    where o.board_id = p_id and reorder_ids ? o.object_id;
    working_object_count := greatest(0, working_object_count - removed_reorder_count);
  end if;

  if p_ops is not null and jsonb_typeof(p_ops) = 'array' then
    for op in
      select item.value
      from jsonb_array_elements(p_ops) with ordinality as item(value, ordinality)
      order by
        case
          when item.value ->> 'type' = 'upsert'
            and ((item.value ->> 'reorder') = 'true' or (item.value ->> 'restore') = 'true')
            then 1
          else 0
        end,
        case
          when item.value ->> 'type' = 'upsert'
            and ((item.value ->> 'reorder') = 'true' or (item.value ->> 'restore') = 'true')
            and coalesce(item.value ->> 'zIndex', '') ~ '^-?[0-9]+$'
            then (item.value ->> 'zIndex')::bigint
          else item.ordinality::bigint
        end,
        item.ordinality
    loop
      if op ->> 'type' = 'delete' then
        v_object_id := op ->> 'id';
        if coalesce(v_object_id, '') = '' then continue; end if;

        old_order := null;
        delete from public.board_objects
        where board_id = p_id and object_id = v_object_id
        returning z_index into old_order;
        deleted_existing := found;
        if deleted_existing then
          working_object_count := greatest(0, working_object_count - 1);
        end if;

        insert into public.board_tombstones(board_id, object_id, deleted_revision, deleted_at)
        values (p_id, v_object_id, new_revision, now())
        on conflict (board_id, object_id) do update
        set deleted_revision = excluded.deleted_revision,
            deleted_at = excluded.deleted_at;

        effective_ops := effective_ops || jsonb_build_array(op);
        changed := true;
        continue;
      end if;

      if op ->> 'type' <> 'upsert' then continue; end if;
      object_value := op -> 'object';
      v_object_id := object_value ->> 'boardObjectId';
      if object_value is null or coalesce(v_object_id, '') = '' then continue; end if;
      allow_restore := coalesce((op ->> 'restore')::boolean, false);
      allow_reorder := coalesce((op ->> 'reorder')::boolean, false) or allow_restore;

      if exists (
        select 1 from public.board_tombstones
        where board_id = p_id and object_id = v_object_id
      ) then
        if not allow_restore then
          raise exception 'Atomic action preflight mismatch for object %', v_object_id;
        end if;
        delete from public.board_tombstones
        where board_id = p_id and object_id = v_object_id;
      end if;

      old_order := null;
      select z_index into old_order
      from public.board_objects
      where board_id = p_id and object_id = v_object_id;
      object_exists := found;

      -- The handwriting/update hot path is constant-time: existing objects keep their
      -- row order and new objects append using a board-level monotonic key. Rank scans
      -- are reserved for explicit layer moves and Undo restoration only.
      if object_exists and not allow_reorder then
        target_order := old_order;
        requested_index := case
          when coalesce(op ->> 'zIndex', '') ~ '^-?[0-9]+$' then greatest(0, (op ->> 'zIndex')::integer)
          else 0
        end;
      elsif not object_exists and not allow_reorder then
        target_order := working_next_order;
        working_next_order := working_next_order + 1024;
        requested_index := working_object_count;
      else
        candidate_count := working_object_count - case when object_exists then 1 else 0 end;
        if coalesce(op ->> 'zIndex', '') ~ '^-?[0-9]+$' then
          requested_index := greatest(0, least(candidate_count, (op ->> 'zIndex')::integer));
        else
          requested_index := candidate_count;
        end if;

        current_rank := null;
        if object_exists then
          select count(*)::integer into current_rank
          from public.board_objects o
          where o.board_id = p_id
            and o.object_id is distinct from v_object_id
            and (o.z_index < old_order or (o.z_index = old_order and o.object_id < v_object_id));
        end if;

        if object_exists and current_rank = requested_index then
          target_order := old_order;
        elsif requested_index = candidate_count then
          target_order := working_next_order;
          working_next_order := working_next_order + 1024;
        else
          previous_order := null;
          following_order := null;
          if requested_index > 0 then
            select o.z_index into previous_order
            from public.board_objects o
            where o.board_id = p_id and o.object_id is distinct from v_object_id
            order by o.z_index, o.object_id
            offset requested_index - 1
            limit 1;
          end if;

          select o.z_index into following_order
          from public.board_objects o
          where o.board_id = p_id and o.object_id is distinct from v_object_id
          order by o.z_index, o.object_id
          offset requested_index
          limit 1;

          if previous_order is null and following_order is null then
            target_order := working_next_order;
            working_next_order := working_next_order + 1024;
          elsif previous_order is null then
            target_order := following_order - 1024;
          elsif following_order is null then
            target_order := greatest(working_next_order, previous_order + 1024);
            working_next_order := target_order + 1024;
          elsif following_order - previous_order > 1 then
            target_order := previous_order + ((following_order - previous_order) / 2);
          else
            -- Rare compaction for explicit ordering only; it is never reached by normal writing.
            with ranked as (
              select object_id, row_number() over (order by z_index, object_id) * 1024 as next_z
              from public.board_objects
              where board_id = p_id and object_id is distinct from v_object_id
            )
            update public.board_objects o
            set z_index = ranked.next_z
            from ranked
            where o.board_id = p_id and o.object_id = ranked.object_id;

            select coalesce(max(z_index) + 1024, 1024)
            into working_next_order
            from public.board_objects
            where board_id = p_id and object_id is distinct from v_object_id;

            previous_order := null;
            following_order := null;
            if requested_index > 0 then
              select o.z_index into previous_order
              from public.board_objects o
              where o.board_id = p_id and o.object_id is distinct from v_object_id
              order by o.z_index, o.object_id
              offset requested_index - 1
              limit 1;
            end if;
            select o.z_index into following_order
            from public.board_objects o
            where o.board_id = p_id and o.object_id is distinct from v_object_id
            order by o.z_index, o.object_id
            offset requested_index
            limit 1;

            if previous_order is null and following_order is null then
              target_order := working_next_order;
              working_next_order := working_next_order + 1024;
            elsif previous_order is null then target_order := following_order - 1024;
            elsif following_order is null then
              target_order := greatest(working_next_order, previous_order + 1024);
              working_next_order := target_order + 1024;
            else target_order := previous_order + ((following_order - previous_order) / 2);
            end if;
          end if;
        end if;
      end if;

      insert into public.board_objects(
        board_id, object_id, object_json, z_index, updated_revision, updated_at
      ) values (
        p_id, v_object_id, object_value, target_order, new_revision, now()
      )
      on conflict (board_id, object_id) do update
      set object_json = excluded.object_json,
          z_index = excluded.z_index,
          updated_revision = excluded.updated_revision,
          updated_at = excluded.updated_at;

      if not object_exists then
        working_object_count := working_object_count + 1;
      end if;
      if target_order >= working_next_order then
        working_next_order := target_order + 1024;
      end if;

      if object_exists and not allow_reorder then
        effective_op := jsonb_set(op, '{preserveOrder}', 'true'::jsonb, true);
      else
        effective_op := jsonb_set(op, '{zIndex}', to_jsonb(requested_index), true);
      end if;
      effective_ops := effective_ops || jsonb_build_array(effective_op);
      changed := true;
    end loop;
  end if;

  if p_background in ('grid', 'dots', 'blank') and p_background is distinct from b.background then
    background_changed := true;
    changed := true;
  end if;

  if changed then
    new_updated_at := now();
    update public.boards
    set revision = new_revision,
        background = case when background_changed then p_background else background end,
        object_count = working_object_count,
        next_order_key = working_next_order,
        updated_at = new_updated_at,
        last_lesson_at = new_updated_at,
        object_store_version = 7
    where id = p_id;
  else
    new_revision := b.revision;
    new_updated_at := b.updated_at;
  end if;

  insert into public.board_actions(
    board_id, action_id, revision, client_id, ops, background, rejected_object_ids, created_at
  ) values (
    p_id,
    p_action_id,
    new_revision,
    p_client_id,
    case when changed then effective_ops else '[]'::jsonb end,
    case when background_changed then p_background else null end,
    '[]'::jsonb,
    now()
  );

  -- Full JSON is rebuilt only once per 1000 accepted revisions, never per stroke.
  if changed and new_revision % 1000 = 0 then
    perform public.refresh_board_snapshot_v7(p_id, new_revision);
  end if;

  return jsonb_build_object(
    'action_id', p_action_id,
    'revision', new_revision,
    'needs_sync', server_revision_before > coalesce(p_client_revision, 0),
    'updated_at', new_updated_at,
    'already_applied', false,
    'changed', changed,
    'applied_ops', case when changed then effective_ops else '[]'::jsonb end,
    'applied_background', case when background_changed then p_background else null end,
    'rejected_object_ids', '[]'::jsonb
  );
end;
$$;

create or replace function public.apply_board_actions_batch_v7(
  p_id text,
  p_key_hash text,
  p_actions jsonb default '[]'::jsonb,
  p_client_revision bigint default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  action_value jsonb;
  result_value jsonb;
  results jsonb := '[]'::jsonb;
  known_revision bigint := coalesce(p_client_revision, 0);
  starting_revision bigint;
  client_was_behind boolean := false;
begin
  if jsonb_typeof(coalesce(p_actions, '[]'::jsonb)) <> 'array' then
    raise exception 'Actions must be a JSON array';
  end if;

  if jsonb_array_length(p_actions) > 50 then
    raise exception 'Too many actions in one transport batch';
  end if;

  select revision into starting_revision from public.boards where id = p_id;
  client_was_behind := coalesce(starting_revision, 0) > coalesce(p_client_revision, 0);

  for action_value in select value from jsonb_array_elements(p_actions)
  loop
    result_value := public.apply_board_action_v7(
      p_id,
      p_key_hash,
      action_value ->> 'action_id',
      action_value ->> 'client_id',
      coalesce(action_value -> 'ops', '[]'::jsonb),
      action_value ->> 'background',
      case when client_was_behind then coalesce(p_client_revision, 0) else known_revision end
    );
    if result_value is null then return null; end if;
    results := results || jsonb_build_array(result_value);
    known_revision := greatest(known_revision, coalesce((result_value ->> 'revision')::bigint, known_revision));
    -- Later local actions may depend on the rejected one. Leave them pending so the
    -- client can restore the server base and rebase them before another transport batch.
    if jsonb_array_length(coalesce(result_value -> 'rejected_object_ids', '[]'::jsonb)) > 0 then
      exit;
    end if;
  end loop;

  return results;
end;
$$;

create or replace function public.get_board_access_v7(
  p_id text,
  p_key_hash text
)
returns table (
  permission text,
  title text,
  student_name text,
  guest_mode text,
  game_library_visible boolean,
  realtime_key text,
  snapshot jsonb,
  snapshot_revision bigint,
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
      'owner'::text, b.title, b.student_name, b.guest_mode,
      b.game_library_visible, b.realtime_key, b.snapshot,
      b.snapshot_revision, b.revision, b.updated_at, b.created_at,
      coalesce(b.last_lesson_at, b.updated_at);
    return;
  end if;

  if p_key_hash = b.share_key_hash then
    if b.guest_mode = 'closed' then
      return query select
        'closed'::text, b.title, b.student_name, b.guest_mode,
        b.game_library_visible, null::text, null::jsonb,
        b.snapshot_revision, b.revision, b.updated_at, b.created_at,
        coalesce(b.last_lesson_at, b.updated_at);
    else
      return query select
        b.guest_mode, b.title, b.student_name, b.guest_mode,
        b.game_library_visible, b.realtime_key, b.snapshot,
        b.snapshot_revision, b.revision, b.updated_at, b.created_at,
        coalesce(b.last_lesson_at, b.updated_at);
    end if;
  end if;
end;
$$;

create or replace function public.get_board_recovery_v7(
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
  result_actions jsonb;
begin
  select * into b from public.boards where id = p_id;
  if not found then return null; end if;
  if not (p_key_hash = b.owner_key_hash or p_key_hash = b.share_key_hash) then return null; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'revision', a.revision,
    'action_id', a.action_id,
    'client_id', a.client_id,
    'ops', a.ops,
    'background', a.background
  ) order by a.revision, a.created_at), '[]'::jsonb)
  into result_actions
  from public.board_actions a
  where a.board_id = p_id and a.revision > b.snapshot_revision;

  return jsonb_build_object(
    'snapshot_revision', b.snapshot_revision,
    'snapshot', b.snapshot,
    'actions', result_actions,
    'current_revision', b.revision
  );
end;
$$;

create or replace function public.get_board_sync_state_v7(
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
  resolved_permission text;
  canonical text;
begin
  select * into b from public.boards where id = p_id;
  if not found then return; end if;
  if p_key_hash = b.owner_key_hash then resolved_permission := 'owner';
  elsif p_key_hash = b.share_key_hash then resolved_permission := b.guest_mode;
  else return;
  end if;

  select coalesce(b.background, 'grid') || '|' || coalesce(string_agg(
    (row_number_value - 1)::text || ':' || object_id || ':' ||
    coalesce(object_json ->> 'updatedAt', '') || ':' ||
    coalesce(object_json ->> 'type', ''),
    '|' order by row_number_value
  ), '')
  into canonical
  from (
    select o.object_id, o.object_json,
      row_number() over (order by o.z_index, o.object_id) as row_number_value
    from public.board_objects o
    where o.board_id = p_id
  ) ordered_objects;

  return query select
    b.revision,
    b.object_count,
    rtrim(translate(encode(digest(convert_to(canonical, 'UTF8'), 'sha256'), 'base64'), '+/', '-_'), '='),
    b.updated_at,
    resolved_permission,
    b.guest_mode;
end;
$$;

create or replace function public.duplicate_board_v7(
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
  source_snapshot jsonb;
begin
  select * into source_board
  from public.boards
  where id = p_source_id and owner_key_hash = p_source_owner_key_hash
  for share;
  if not found then return false; end if;

  source_snapshot := public.build_board_snapshot_v7(p_source_id);

  insert into public.boards(
    id, title, student_name, owner_key_hash, share_key_hash, realtime_key,
    guest_mode, game_library_visible, snapshot, snapshot_revision, background,
    object_store_version, object_count, next_order_key, revision, created_at, updated_at, last_lesson_at
  ) values (
    p_new_id,
    coalesce(nullif(trim(p_new_title), ''), source_board.title || ' — копия'),
    source_board.student_name,
    p_new_owner_key_hash,
    p_new_share_key_hash,
    p_new_realtime_key,
    'edit', false, source_snapshot, 0, source_board.background,
    7, source_board.object_count, source_board.next_order_key, 0, now(), now(), null
  );

  insert into public.board_objects(
    board_id, object_id, object_json, z_index, updated_revision, updated_at
  )
  select p_new_id, object_id, object_json, z_index, 0, now()
  from public.board_objects
  where board_id = p_source_id;

  return true;
end;
$$;

create or replace function public.commit_board_import_v7(
  p_id text,
  p_key_hash text,
  p_import_id text,
  p_chunk_count integer,
  p_action_id text,
  p_client_id text default null,
  p_background text default null,
  p_client_revision bigint default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actual_chunk_count integer;
  assembled_ops jsonb;
  result jsonb;
begin
  if p_import_id is null or trim(p_import_id) = ''
    or p_action_id is null or trim(p_action_id) = ''
    or p_chunk_count < 1 then return null; end if;

  select count(*) into actual_chunk_count
  from public.board_import_chunks
  where board_id = p_id and import_id = p_import_id and action_id = p_action_id
    and chunk_index >= 0 and chunk_index < p_chunk_count;
  if actual_chunk_count <> p_chunk_count then
    raise exception 'Bulk action is incomplete: expected %, received %', p_chunk_count, actual_chunk_count;
  end if;

  select coalesce(jsonb_agg(item.value order by c.chunk_index, item.ordinality), '[]'::jsonb)
  into assembled_ops
  from public.board_import_chunks c
  cross join lateral jsonb_array_elements(c.ops) with ordinality as item(value, ordinality)
  where c.board_id = p_id and c.import_id = p_import_id and c.action_id = p_action_id
    and c.chunk_index >= 0 and c.chunk_index < p_chunk_count;

  result := public.apply_board_action_v7(
    p_id, p_key_hash, p_action_id, p_client_id,
    assembled_ops, p_background, p_client_revision
  );

  if result is not null then
    delete from public.board_import_chunks
    where board_id = p_id and import_id = p_import_id;
  end if;
  return result;
end;
$$;


-- Compatibility wrappers keep an already-open 0.9.5/0.9.6 tab from writing to the
-- obsolete full-snapshot path after this migration.
create or replace function public.apply_board_action_v5(
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
  compatible_ops jsonb;
begin
  select coalesce(jsonb_agg(
    case
      when item.value ->> 'type' = 'upsert'
        then jsonb_set(item.value, '{reorder}', 'true'::jsonb, true)
      else item.value
    end
    order by item.ordinality
  ), '[]'::jsonb)
  into compatible_ops
  from jsonb_array_elements(coalesce(p_ops, '[]'::jsonb)) with ordinality as item(value, ordinality);

  return public.apply_board_action_v7(
    p_id, p_key_hash, p_action_id, p_client_id,
    compatible_ops, p_background, p_client_revision
  );
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
language sql
security definer
set search_path = public
as $$
  select public.apply_board_action_v5(
    p_id, p_key_hash, p_action_id, p_client_id,
    p_ops, p_background, p_client_revision
  );
$$;

create or replace function public.get_board_access_v5(
  p_id text,
  p_key_hash text
)
returns table (
  permission text,
  title text,
  student_name text,
  guest_mode text,
  game_library_visible boolean,
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
  current_snapshot jsonb;
begin
  select * into b from public.boards where id = p_id;
  if not found then return; end if;
  current_snapshot := public.build_board_snapshot_v7(p_id);

  if p_key_hash = b.owner_key_hash then
    return query select 'owner'::text, b.title, b.student_name, b.guest_mode,
      b.game_library_visible, b.realtime_key, current_snapshot, b.revision,
      b.updated_at, b.created_at, coalesce(b.last_lesson_at, b.updated_at);
    return;
  end if;
  if p_key_hash = b.share_key_hash then
    if b.guest_mode = 'closed' then
      return query select 'closed'::text, b.title, b.student_name, b.guest_mode,
        b.game_library_visible, null::text, null::jsonb, b.revision,
        b.updated_at, b.created_at, coalesce(b.last_lesson_at, b.updated_at);
    else
      return query select b.guest_mode, b.title, b.student_name, b.guest_mode,
        b.game_library_visible, b.realtime_key, current_snapshot, b.revision,
        b.updated_at, b.created_at, coalesce(b.last_lesson_at, b.updated_at);
    end if;
  end if;
end;
$$;

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
  current_snapshot jsonb;
begin
  select * into b from public.boards where id = p_id;
  if not found then return; end if;
  current_snapshot := public.build_board_snapshot_v7(p_id);

  if p_key_hash = b.owner_key_hash then
    return query select 'owner'::text, b.title, b.student_name, b.guest_mode,
      b.realtime_key, current_snapshot, b.revision, b.updated_at, b.created_at,
      coalesce(b.last_lesson_at, b.updated_at);
    return;
  end if;
  if p_key_hash = b.share_key_hash then
    if b.guest_mode = 'closed' then
      return query select 'closed'::text, b.title, b.student_name, b.guest_mode,
        null::text, null::jsonb, b.revision, b.updated_at, b.created_at,
        coalesce(b.last_lesson_at, b.updated_at);
    else
      return query select b.guest_mode, b.title, b.student_name, b.guest_mode,
        b.realtime_key, current_snapshot, b.revision, b.updated_at, b.created_at,
        coalesce(b.last_lesson_at, b.updated_at);
    end if;
  end if;
end;
$$;

create or replace function public.get_board_recovery_v4(p_id text, p_key_hash text)
returns jsonb
language sql
security definer
set search_path = public
as $$ select public.get_board_recovery_v7(p_id, p_key_hash); $$;

create or replace function public.get_board_sync_state_v4(p_id text, p_key_hash text)
returns table (
  revision bigint,
  object_count integer,
  state_hash text,
  updated_at timestamptz,
  permission text,
  guest_mode text
)
language sql
security definer
set search_path = public
as $$ select * from public.get_board_sync_state_v7(p_id, p_key_hash); $$;

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
language sql
security definer
set search_path = public
as $$
  select public.duplicate_board_v7(
    p_source_id, p_source_owner_key_hash, p_new_id, p_new_title,
    p_new_owner_key_hash, p_new_share_key_hash, p_new_realtime_key
  );
$$;

revoke all on function public.build_board_snapshot_v7(text) from public;
revoke all on function public.refresh_board_snapshot_v7(text, bigint) from public;
revoke all on function public.apply_board_action_v7(text, text, text, text, jsonb, text, bigint) from public;
revoke all on function public.apply_board_actions_batch_v7(text, text, jsonb, bigint) from public;
revoke all on function public.get_board_access_v7(text, text) from public;
revoke all on function public.get_board_recovery_v7(text, text) from public;
revoke all on function public.get_board_sync_state_v7(text, text) from public;
revoke all on function public.duplicate_board_v7(text, text, text, text, text, text, text) from public;
revoke all on function public.commit_board_import_v7(text, text, text, integer, text, text, text, bigint) from public;

grant execute on function public.apply_board_action_v7(text, text, text, text, jsonb, text, bigint) to anon, authenticated;
grant execute on function public.apply_board_actions_batch_v7(text, text, jsonb, bigint) to anon, authenticated;
grant execute on function public.get_board_access_v7(text, text) to anon, authenticated;
grant execute on function public.get_board_recovery_v7(text, text) to anon, authenticated;
grant execute on function public.get_board_sync_state_v7(text, text) to anon, authenticated;
grant execute on function public.duplicate_board_v7(text, text, text, text, text, text, text) to anon, authenticated;
grant execute on function public.commit_board_import_v7(text, text, text, integer, text, text, text, bigint) to anon, authenticated;
grant execute on function public.apply_board_action_v5(text, text, text, text, jsonb, text, bigint) to anon, authenticated;
grant execute on function public.apply_board_action_v4(text, text, text, text, jsonb, text, bigint) to anon, authenticated;
grant execute on function public.get_board_access_v5(text, text) to anon, authenticated;
grant execute on function public.get_board_access_v4(text, text) to anon, authenticated;
grant execute on function public.get_board_recovery_v4(text, text) to anon, authenticated;
grant execute on function public.get_board_sync_state_v4(text, text) to anon, authenticated;
grant execute on function public.duplicate_board_v4(text, text, text, text, text, text, text) to anon, authenticated;

select 'Alex Board 0.9.7 fast queue and row object storage installed' as result;
