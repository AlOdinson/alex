-- Alex Board capacity cleanup prerequisite.
-- Create destination boards without relying on legacy object storage.

begin;

create or replace function public.duplicate_board_v8(
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
set search_path = public, pg_temp
as $$
declare
  source_board public.boards%rowtype;
begin
  select * into source_board
  from public.boards
  where id = p_source_id
    and owner_key_hash = p_source_owner_key_hash
  for share;

  if not found then return false; end if;

  insert into public.boards (
    id,
    title,
    student_name,
    owner_key_hash,
    share_key_hash,
    realtime_key,
    guest_mode,
    game_library_visible,
    snapshot,
    snapshot_revision,
    background,
    object_store_version,
    object_count,
    next_order_key,
    revision,
    created_at,
    updated_at,
    last_lesson_at,
    owner_user_id
  ) values (
    p_new_id,
    coalesce(nullif(trim(p_new_title), ''), source_board.title || ' — копия'),
    source_board.student_name,
    p_new_owner_key_hash,
    p_new_share_key_hash,
    p_new_realtime_key,
    'edit',
    false,
    '{"version":2,"background":"grid","canvas":{"objects":[]}}'::jsonb,
    0,
    source_board.background,
    7,
    0,
    1024,
    0,
    now(),
    now(),
    null,
    auth.uid()
  );

  insert into public.board_action_heads_v8 (
    board_id,
    revision,
    log_floor_revision,
    updated_at
  ) values (
    p_new_id,
    0,
    0,
    now()
  )
  on conflict (board_id) do update set
    revision = 0,
    log_floor_revision = 0,
    updated_at = now();

  insert into public.board_object_state_heads_v8 (
    board_id,
    revision,
    updated_at
  ) values (
    p_new_id,
    0,
    now()
  )
  on conflict (board_id) do update set
    revision = 0,
    updated_at = now();

  return true;
end
$$;

revoke all on function public.duplicate_board_v8(text, text, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.duplicate_board_v8(text, text, text, text, text, text, text)
  to anon, authenticated, service_role;

do $revoke_legacy$
begin
  if to_regprocedure('public.duplicate_board_v7(text,text,text,text,text,text,text)') is not null then
    execute 'revoke execute on function public.duplicate_board_v7(text,text,text,text,text,text,text) from anon, authenticated';
  end if;
end
$revoke_legacy$;

commit;
