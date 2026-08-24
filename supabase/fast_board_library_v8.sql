-- Alex Board 1.32.19
-- Fast creation and lightweight per-device owner library operations.
-- Run once before publishing the 1.32.19 client.

begin;

create or replace function public.create_board_fast_v8(
  p_id text,
  p_title text,
  p_student_name text,
  p_owner_key_hash text,
  p_share_key_hash text,
  p_realtime_key text
)
returns table (
  board_id text,
  created_at timestamptz
)
language sql
security definer
set search_path = public, pg_temp
as $$
  with inserted as (
    insert into public.boards (
      id,
      title,
      student_name,
      owner_key_hash,
      share_key_hash,
      realtime_key,
      snapshot,
      snapshot_revision,
      background,
      object_store_version,
      object_count,
      next_order_key
    ) values (
      p_id,
      coalesce(nullif(trim(p_title), ''), 'Новая доска'),
      left(trim(coalesce(p_student_name, '')), 120),
      p_owner_key_hash,
      p_share_key_hash,
      p_realtime_key,
      '{"version":2,"background":"grid","canvas":{"objects":[]}}'::jsonb,
      0,
      'grid',
      7,
      0,
      1024
    )
    returning id, created_at
  )
  select inserted.id::text, inserted.created_at
  from inserted;
$$;

create or replace function public.get_owned_board_summaries_v8(p_entries jsonb)
returns table (
  board_id text,
  title text,
  student_name text,
  created_at timestamptz,
  updated_at timestamptz,
  last_lesson_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with requested as (
    select
      nullif(entry.value->>'boardId', '') as board_id,
      nullif(entry.value->>'ownerKeyHash', '') as owner_key_hash,
      entry.ordinality
    from jsonb_array_elements(
      case when jsonb_typeof(p_entries) = 'array' then p_entries else '[]'::jsonb end
    ) with ordinality as entry(value, ordinality)
    where entry.ordinality <= 50
  )
  select
    b.id::text,
    b.title::text,
    coalesce(b.student_name, '')::text,
    b.created_at,
    b.updated_at,
    coalesce(b.last_lesson_at, b.updated_at)
  from requested r
  join public.boards b
    on b.id = r.board_id
   and b.owner_key_hash = r.owner_key_hash
  order by r.ordinality;
$$;

create or replace function public.delete_owned_boards_v8(p_entries jsonb)
returns table (board_id text)
language sql
security definer
set search_path = public, pg_temp
as $$
  with requested as (
    select distinct
      nullif(entry.value->>'boardId', '') as board_id,
      nullif(entry.value->>'ownerKeyHash', '') as owner_key_hash
    from jsonb_array_elements(
      case when jsonb_typeof(p_entries) = 'array' then p_entries else '[]'::jsonb end
    ) with ordinality as entry(value, ordinality)
    where entry.ordinality <= 20
  ), deleted as (
    delete from public.boards b
    using requested r
    where b.id = r.board_id
      and b.owner_key_hash = r.owner_key_hash
    returning b.id
  )
  select deleted.id::text
  from deleted;
$$;

revoke all on function public.create_board_fast_v8(text, text, text, text, text, text)
  from public, anon, authenticated;
revoke all on function public.get_owned_board_summaries_v8(jsonb)
  from public, anon, authenticated;
revoke all on function public.delete_owned_boards_v8(jsonb)
  from public, anon, authenticated;

grant execute on function public.create_board_fast_v8(text, text, text, text, text, text)
  to anon, authenticated, service_role;
grant execute on function public.get_owned_board_summaries_v8(jsonb)
  to anon, authenticated, service_role;
grant execute on function public.delete_owned_boards_v8(jsonb)
  to anon, authenticated, service_role;

commit;
