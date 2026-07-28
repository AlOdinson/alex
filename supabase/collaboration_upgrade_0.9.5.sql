-- Alex Board 0.9.5: operation-only insurance sync, effective operation journal,
-- stable revisions and atomic logical actions.
-- Run this entire file once in Supabase SQL Editor after the earlier schema upgrades.

create extension if not exists pgcrypto;

-- The existing table is reused. Version 0.9.5 writes only operations that were
-- actually accepted by the server into board_actions.ops. Rejected atomic actions
-- are remembered as idempotent no-op records so a network retry cannot later apply them.
alter table public.board_actions
  add column if not exists rejected_object_ids jsonb not null default '[]'::jsonb;

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
  b public.boards%rowtype;
  previous_action public.board_actions%rowtype;
  current_snapshot jsonb;
  objects jsonb;
  op jsonb;
  object_value jsonb;
  effective_ops jsonb := '[]'::jsonb;
  rejected_object_ids jsonb := '[]'::jsonb;
  delete_ids jsonb := '[]'::jsonb;
  v_object_id text;
  requested_index integer;
  object_count integer;
  server_revision_before bigint;
  new_revision bigint;
  new_updated_at timestamptz;
  changed boolean := false;
  allow_restore boolean;
  background_changed boolean := false;
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
  current_snapshot := case
    when jsonb_typeof(b.snapshot) = 'object' then b.snapshot
    else '{"version":2,"background":"grid","canvas":{"objects":[]}}'::jsonb
  end;

  if jsonb_typeof(current_snapshot -> 'canvas') is distinct from 'object' then
    current_snapshot := jsonb_set(current_snapshot, '{canvas}', '{"objects":[]}'::jsonb, true);
  end if;
  objects := current_snapshot #> '{canvas,objects}';
  if jsonb_typeof(objects) is distinct from 'array' then objects := '[]'::jsonb; end if;

  -- Preflight the complete logical action before mutating anything. If one upsert
  -- would resurrect a tombstoned object without an explicit restore, reject the
  -- entire group/Undo/Redo action rather than applying only part of it.
  if p_ops is not null and jsonb_typeof(p_ops) = 'array' then
    for op in select value from jsonb_array_elements(p_ops)
    loop
      if op ->> 'type' = 'delete' and coalesce(op ->> 'id', '') <> '' then
        delete_ids := delete_ids || jsonb_build_array(op ->> 'id');
      end if;
    end loop;

    for op in select value from jsonb_array_elements(p_ops)
    loop
      if op ->> 'type' <> 'upsert' then continue; end if;
      object_value := op -> 'object';
      v_object_id := object_value ->> 'boardObjectId';
      if object_value is null or v_object_id is null or v_object_id = '' then continue; end if;
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

        effective_ops := effective_ops || jsonb_build_array(op);
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
            raise exception 'Atomic action preflight mismatch for object %', v_object_id;
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
        else
          requested_index := object_count;
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

        effective_ops := effective_ops || jsonb_build_array(
          jsonb_set(op, '{zIndex}', to_jsonb(requested_index), true)
        );
        changed := true;
      end if;
    end loop;
  end if;

  current_snapshot := jsonb_set(current_snapshot, '{version}', to_jsonb(2), true);
  current_snapshot := jsonb_set(current_snapshot, '{canvas,objects}', objects, true);

  if p_background in ('grid', 'dots', 'blank') then
    current_snapshot := jsonb_set(current_snapshot, '{background}', to_jsonb(p_background), true);
    background_changed := true;
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
    'needs_sync', server_revision_before > coalesce(p_client_revision, 0)
      or jsonb_array_length(rejected_object_ids) > 0,
    'updated_at', new_updated_at,
    'already_applied', false,
    'changed', changed,
    'applied_ops', case when changed then effective_ops else '[]'::jsonb end,
    'applied_background', case when background_changed then p_background else null end,
    'rejected_object_ids', rejected_object_ids
  );
end;
$$;

create or replace function public.get_board_changes_v5(
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


revoke all on function public.apply_board_action_v5(text, text, text, text, jsonb, text, bigint) from public;
revoke all on function public.get_board_changes_v5(text, text, bigint, integer) from public;
grant execute on function public.apply_board_action_v5(text, text, text, text, jsonb, text, bigint) to anon, authenticated;
grant execute on function public.get_board_changes_v5(text, text, bigint, integer) to anon, authenticated;

select 'Alex Board 0.9.5 collaboration upgrade installed' as result;
