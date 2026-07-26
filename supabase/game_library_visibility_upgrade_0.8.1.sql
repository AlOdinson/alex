-- Alex Board 0.8.1: скрытая игротека, которую владелец открывает для всех.
-- Запустите файл один раз целиком в Supabase SQL Editor.

alter table public.boards
  add column if not exists game_library_visible boolean not null default false;

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
begin
  select * into b from public.boards where id = p_id;
  if not found then return; end if;

  if p_key_hash = b.owner_key_hash then
    return query select
      'owner'::text,
      b.title,
      b.student_name,
      b.guest_mode,
      b.game_library_visible,
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
        b.game_library_visible,
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
        b.game_library_visible,
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

create or replace function public.set_game_library_visibility_v5(
  p_id text,
  p_owner_key_hash text,
  p_visible boolean
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.boards
  set game_library_visible = coalesce(p_visible, false),
      updated_at = now()
  where id = p_id and owner_key_hash = p_owner_key_hash;
  return found;
end;
$$;

revoke all on function public.get_board_access_v5(text, text) from public;
revoke all on function public.set_game_library_visibility_v5(text, text, boolean) from public;

grant execute on function public.get_board_access_v5(text, text) to anon, authenticated;
grant execute on function public.set_game_library_visibility_v5(text, text, boolean) to anon, authenticated;

select 'Alex Board 0.8.1 hidden game library installed' as result;
