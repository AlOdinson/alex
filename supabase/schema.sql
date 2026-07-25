-- Run this entire file in Supabase SQL Editor.

create table if not exists public.boards (
  id text primary key,
  title text not null default 'Новая доска',
  owner_key_hash text not null,
  share_key_hash text not null,
  realtime_key text not null,
  guest_mode text not null default 'edit'
    check (guest_mode in ('edit', 'view', 'closed')),
  snapshot jsonb not null default '{"version":2,"background":"grid","canvas":{"objects":[]}}'::jsonb,
  revision bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.boards
  alter column snapshot set default '{"version":2,"background":"grid","canvas":{"objects":[]}}'::jsonb;

alter table public.boards enable row level security;
revoke all on table public.boards from anon, authenticated;

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
    id,
    title,
    owner_key_hash,
    share_key_hash,
    realtime_key
  ) values (
    p_id,
    coalesce(nullif(trim(p_title), ''), 'Новая доска'),
    p_owner_key_hash,
    p_share_key_hash,
    p_realtime_key
  );
end;
$$;

create or replace function public.get_board_access(
  p_id text,
  p_key_hash text
)
returns table (
  permission text,
  title text,
  guest_mode text,
  realtime_key text,
  snapshot jsonb,
  revision bigint,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  b public.boards%rowtype;
begin
  select * into b from public.boards where id = p_id;
  if not found then
    return;
  end if;

  if p_key_hash = b.owner_key_hash then
    return query select
      'owner'::text,
      b.title,
      b.guest_mode,
      b.realtime_key,
      b.snapshot,
      b.revision,
      b.updated_at;
    return;
  end if;

  if p_key_hash = b.share_key_hash then
    if b.guest_mode = 'closed' then
      return query select
        'closed'::text,
        b.title,
        b.guest_mode,
        null::text,
        null::jsonb,
        b.revision,
        b.updated_at;
    else
      return query select
        b.guest_mode,
        b.title,
        b.guest_mode,
        b.realtime_key,
        b.snapshot,
        b.revision,
        b.updated_at;
    end if;
  end if;
end;
$$;

create or replace function public.set_board_guest_mode(
  p_id text,
  p_owner_key_hash text,
  p_guest_mode text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_guest_mode not in ('edit', 'view', 'closed') then
    raise exception 'Invalid guest mode';
  end if;

  update public.boards
  set guest_mode = p_guest_mode,
      updated_at = now()
  where id = p_id
    and owner_key_hash = p_owner_key_hash;

  return found;
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
declare
  new_revision bigint;
begin
  update public.boards
  set snapshot = p_snapshot,
      revision = greatest(revision + 1, coalesce(p_client_revision, 0)),
      updated_at = now()
  where id = p_id
    and (
      owner_key_hash = p_key_hash
      or (share_key_hash = p_key_hash and guest_mode = 'edit')
    )
  returning revision into new_revision;

  return new_revision;
end;
$$;

revoke all on function public.create_board(text, text, text, text, text) from public;
revoke all on function public.get_board_access(text, text) from public;
revoke all on function public.set_board_guest_mode(text, text, text) from public;
revoke all on function public.save_board_snapshot(text, text, jsonb, bigint) from public;

grant execute on function public.create_board(text, text, text, text, text) to anon, authenticated;
grant execute on function public.get_board_access(text, text) to anon, authenticated;
grant execute on function public.set_board_guest_mode(text, text, text) to anon, authenticated;
grant execute on function public.save_board_snapshot(text, text, jsonb, bigint) to anon, authenticated;

-- Version 0.3.6 synchronization upgrade.
-- Object operations are applied atomically on the server. This prevents an
-- older full snapshot from one device overwriting newer edits from another.

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
  select *
  into b
  from public.boards
  where id = p_id
  for update;

  if not found then
    return null;
  end if;

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
    current_snapshot := jsonb_set(
      current_snapshot,
      '{canvas}',
      '{"objects":[]}'::jsonb,
      true
    );
  end if;

  objects := current_snapshot #> '{canvas,objects}';
  if jsonb_typeof(objects) is distinct from 'array' then
    objects := '[]'::jsonb;
  end if;

  if p_ops is not null and jsonb_typeof(p_ops) = 'array' then
    for op in select value from jsonb_array_elements(p_ops)
    loop
      if op ->> 'type' = 'delete' then
        object_id := op ->> 'id';
        if object_id is null or object_id = '' then
          continue;
        end if;

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
        if object_value is null or object_id is null or object_id = '' then
          continue;
        end if;

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

          select
            object_value as item,
            requested_index * 2 + 1 as sort_order,
            0::bigint as source_order
        ) ordered_objects;
        changed := true;
      end if;
    end loop;
  end if;

  current_snapshot := jsonb_set(current_snapshot, '{version}', to_jsonb(2), true);
  current_snapshot := jsonb_set(current_snapshot, '{canvas,objects}', objects, true);

  if p_background in ('grid', 'dots', 'blank') then
    current_snapshot := jsonb_set(
      current_snapshot,
      '{background}',
      to_jsonb(p_background),
      true
    );
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

-- Older browser tabs used whole-board saves. Keep the function for backwards
-- compatibility, but only accept a save based on the immediately previous
-- revision so stale tabs cannot erase newer operations.
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

-- Version 0.3.7 image storage.
-- HEIC/HEIF is converted in the browser to JPEG before upload. The board JSON
-- stores a short CDN URL instead of embedding the whole image as base64.
insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'board-assets',
  'board-assets',
  true,
  15728640,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']::text[]
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Alex Board image uploads" on storage.objects;
create policy "Alex Board image uploads"
on storage.objects
for insert
to anon, authenticated
with check (bucket_id = 'board-assets');
