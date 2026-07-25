-- Alex Board 0.3.6: reliable multi-device synchronization.
-- Run this entire file once in Supabase SQL Editor.

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
declare
  b public.boards%rowtype;
  current_snapshot jsonb;
  objects jsonb;
  op jsonb;
  object_value jsonb;
  object_id text;
  requested_index integer;
  object_count integer;
  server_revision_before bigint;
  new_revision bigint;
  new_updated_at timestamptz;
  changed boolean := false;
begin
  select * into b
  from public.boards
  where id = p_id
  for update;

  if not found then return null; end if;

  if not (
    b.owner_key_hash = p_key_hash
    or (b.share_key_hash = p_key_hash and b.guest_mode = 'edit')
  ) then
    return null;
  end if;

  server_revision_before := b.revision;
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
        object_id := op ->> 'id';
        if object_id is null or object_id = '' then continue; end if;

        select coalesce(jsonb_agg(value order by ord), '[]'::jsonb)
        into objects
        from jsonb_array_elements(objects) with ordinality as existing(value, ord)
        where existing.value ->> 'boardObjectId' is distinct from object_id;
        changed := true;
        continue;
      end if;

      if op ->> 'type' = 'upsert' then
        object_value := op -> 'object';
        object_id := object_value ->> 'boardObjectId';
        if object_value is null or object_id is null or object_id = '' then continue; end if;

        select coalesce(jsonb_agg(value order by ord), '[]'::jsonb)
        into objects
        from jsonb_array_elements(objects) with ordinality as existing(value, ord)
        where existing.value ->> 'boardObjectId' is distinct from object_id;

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

  if not changed then
    return jsonb_build_object(
      'revision', b.revision,
      'needs_sync', b.revision > coalesce(p_client_revision, 0),
      'updated_at', b.updated_at
    );
  end if;

  new_revision := b.revision + 1;
  new_updated_at := now();

  update public.boards
  set snapshot = current_snapshot,
      revision = new_revision,
      updated_at = new_updated_at
  where id = p_id;

  return jsonb_build_object(
    'revision', new_revision,
    'needs_sync', server_revision_before > coalesce(p_client_revision, 0),
    'updated_at', new_updated_at
  );
end;
$$;

create or replace function public.save_board_snapshot(
  p_id text,
  p_key_hash text,
  p_snapshot jsonb,
  p_client_revision bigint default 0
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Disabled for 0.3.6 clients. Whole-board saves from an old browser tab can
  -- overwrite concurrent edits. Current clients use apply_board_ops instead.
  return null;
end;
$$;

revoke all on function public.apply_board_ops(text, text, jsonb, text, bigint) from public;
grant execute on function public.apply_board_ops(text, text, jsonb, text, bigint) to anon, authenticated;

create or replace function public.get_board_revision(
  p_id text,
  p_key_hash text
)
returns table (
  revision bigint,
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
begin
  select * into b from public.boards where id = p_id;
  if not found then return; end if;

  if p_key_hash = b.owner_key_hash then
    return query select b.revision, b.updated_at, 'owner'::text, b.guest_mode;
    return;
  end if;

  if p_key_hash = b.share_key_hash then
    return query select b.revision, b.updated_at, b.guest_mode, b.guest_mode;
  end if;
end;
$$;

revoke all on function public.get_board_revision(text, text) from public;
grant execute on function public.get_board_revision(text, text) to anon, authenticated;

select 'Alex Board 0.3.6 synchronization upgrade installed' as result;
