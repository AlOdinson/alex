-- Alex Board 1.34.0
-- Teacher email accounts and one-time Mac pairing for account-wide remote browser access.

alter table public.boards
  add column if not exists owner_user_id uuid references auth.users(id) on delete set null;

create index if not exists boards_owner_user_id_idx
  on public.boards (owner_user_id, updated_at desc)
  where owner_user_id is not null;

create table if not exists public.teacher_accounts_v9 (
  user_id uuid primary key references auth.users(id) on delete cascade,
  realtime_key text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint teacher_accounts_v9_realtime_key_length check (length(realtime_key) >= 40)
);

create table if not exists public.teacher_mac_agents_v9 (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  token_hash text not null unique,
  pairing_code_hash text not null,
  name text not null default 'Mac',
  created_at timestamptz not null default now(),
  paired_at timestamptz,
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  constraint teacher_mac_agents_v9_token_hash_format check (token_hash ~ '^[A-Za-z0-9_-]{43}$'),
  constraint teacher_mac_agents_v9_pairing_hash_format check (pairing_code_hash ~ '^[A-Za-z0-9_-]{43}$')
);

create index if not exists teacher_mac_agents_v9_user_idx
  on public.teacher_mac_agents_v9 (user_id, last_seen_at desc)
  where revoked_at is null;

create index if not exists teacher_mac_agents_v9_pairing_idx
  on public.teacher_mac_agents_v9 (pairing_code_hash, last_seen_at desc)
  where user_id is null and revoked_at is null;

alter table public.teacher_accounts_v9 enable row level security;
alter table public.teacher_mac_agents_v9 enable row level security;
revoke all on public.teacher_accounts_v9 from anon, authenticated;
revoke all on public.teacher_mac_agents_v9 from anon, authenticated;

create or replace function public.ensure_teacher_account_v9()
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_account public.teacher_accounts_v9%rowtype;
begin
  if v_user_id is null then
    raise exception 'authentication_required' using errcode = '42501';
  end if;

  insert into public.teacher_accounts_v9 (user_id, realtime_key)
  values (v_user_id, encode(extensions.gen_random_bytes(32), 'hex'))
  on conflict (user_id) do update set updated_at = now()
  returning * into v_account;

  return jsonb_build_object(
    'userId', v_account.user_id,
    'realtimeKey', v_account.realtime_key
  );
end;
$$;

create or replace function public.claim_owned_boards_for_account_v9(p_entries jsonb)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_claimed integer := 0;
begin
  if v_user_id is null then
    raise exception 'authentication_required' using errcode = '42501';
  end if;
  if jsonb_typeof(p_entries) <> 'array' or jsonb_array_length(p_entries) > 100 then
    raise exception 'invalid_board_entries';
  end if;

  with supplied as (
    select distinct
      left(trim(entry->>'boardId'), 160) as board_id,
      trim(entry->>'ownerKeyHash') as owner_key_hash
    from jsonb_array_elements(p_entries) entry
    where length(trim(entry->>'boardId')) between 1 and 160
      and trim(entry->>'ownerKeyHash') ~ '^[A-Za-z0-9_-]{43}$'
  ), updated as (
    update public.boards b
    set owner_user_id = v_user_id
    from supplied s
    where b.id = s.board_id
      and b.owner_key_hash = s.owner_key_hash
      and (b.owner_user_id is null or b.owner_user_id = v_user_id)
    returning b.id
  )
  select count(*) into v_claimed from updated;

  perform public.ensure_teacher_account_v9();
  return v_claimed;
end;
$$;

create or replace function public.register_teacher_mac_agent_v9(
  p_token_hash text,
  p_pairing_code_hash text,
  p_name text default 'Mac'
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_agent public.teacher_mac_agents_v9%rowtype;
  v_realtime_key text;
begin
  p_token_hash := trim(coalesce(p_token_hash, ''));
  p_pairing_code_hash := trim(coalesce(p_pairing_code_hash, ''));
  if p_token_hash !~ '^[A-Za-z0-9_-]{43}$' or p_pairing_code_hash !~ '^[A-Za-z0-9_-]{43}$' then
    raise exception 'invalid_agent_credentials';
  end if;

  insert into public.teacher_mac_agents_v9 (
    token_hash, pairing_code_hash, name, last_seen_at, revoked_at
  ) values (
    p_token_hash,
    p_pairing_code_hash,
    left(coalesce(nullif(trim(p_name), ''), 'Mac'), 80),
    now(),
    null
  )
  on conflict (token_hash) do update set
    pairing_code_hash = case
      when teacher_mac_agents_v9.user_id is null then excluded.pairing_code_hash
      else teacher_mac_agents_v9.pairing_code_hash
    end,
    name = excluded.name,
    last_seen_at = now()
  returning * into v_agent;

  if v_agent.user_id is not null and v_agent.revoked_at is null then
    select realtime_key into v_realtime_key
    from public.teacher_accounts_v9
    where user_id = v_agent.user_id;
  end if;

  return jsonb_build_object(
    'agentId', v_agent.id,
    'paired', v_agent.user_id is not null and v_agent.revoked_at is null,
    'realtimeKey', coalesce(v_realtime_key, ''),
    'lastSeenAt', v_agent.last_seen_at
  );
end;
$$;

create or replace function public.claim_teacher_mac_agent_v9(p_pairing_code_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_agent public.teacher_mac_agents_v9%rowtype;
  v_account jsonb;
begin
  if v_user_id is null then
    raise exception 'authentication_required' using errcode = '42501';
  end if;
  p_pairing_code_hash := trim(coalesce(p_pairing_code_hash, ''));
  if p_pairing_code_hash !~ '^[A-Za-z0-9_-]{43}$' then
    raise exception 'invalid_pairing_code';
  end if;

  select * into v_agent
  from public.teacher_mac_agents_v9
  where pairing_code_hash = p_pairing_code_hash
    and user_id is null
    and revoked_at is null
    and last_seen_at > now() - interval '15 minutes'
  order by last_seen_at desc
  limit 1
  for update skip locked;

  if not found then
    raise exception 'pairing_code_not_found';
  end if;

  update public.teacher_mac_agents_v9
  set user_id = v_user_id, paired_at = now(), last_seen_at = now()
  where id = v_agent.id;

  v_account := public.ensure_teacher_account_v9();
  return jsonb_build_object(
    'agentId', v_agent.id,
    'paired', true,
    'realtimeKey', v_account->>'realtimeKey'
  );
end;
$$;

create or replace function public.get_teacher_account_mac_status_v9()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'authentication_required' using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'agentId', a.id,
      'name', a.name,
      'online', a.last_seen_at > now() - interval '12 seconds',
      'lastSeenAt', a.last_seen_at,
      'pairedAt', a.paired_at
    ) order by a.last_seen_at desc)
    from public.teacher_mac_agents_v9 a
    where a.user_id = v_user_id and a.revoked_at is null
  ), '[]'::jsonb);
end;
$$;

create or replace function public.revoke_teacher_mac_agent_v9(p_agent_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'authentication_required' using errcode = '42501';
  end if;
  update public.teacher_mac_agents_v9
  set revoked_at = now(), last_seen_at = now()
  where id = p_agent_id and user_id = v_user_id and revoked_at is null;
  return found;
end;
$$;

create or replace function public.get_board_teacher_account_v9(p_id text, p_key_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_permission text;
  v_realtime_key text;
begin
  v_permission := public.board_v8_permission(p_id, p_key_hash);
  if v_permission is null or v_permission = 'closed' then return null; end if;

  select a.realtime_key into v_realtime_key
  from public.boards b
  join public.teacher_accounts_v9 a on a.user_id = b.owner_user_id
  where b.id = p_id;

  if v_realtime_key is null then return null; end if;
  return jsonb_build_object('realtimeKey', v_realtime_key);
end;
$$;

create or replace function public.authorize_teacher_mac_request_v9(
  p_token_hash text,
  p_board_id text,
  p_board_key_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_agent public.teacher_mac_agents_v9%rowtype;
  v_permission text;
  v_realtime_key text;
begin
  p_token_hash := trim(coalesce(p_token_hash, ''));
  p_board_key_hash := trim(coalesce(p_board_key_hash, ''));
  if p_token_hash !~ '^[A-Za-z0-9_-]{43}$' or p_board_key_hash !~ '^[A-Za-z0-9_-]{43}$' then
    return null;
  end if;

  select * into v_agent
  from public.teacher_mac_agents_v9
  where token_hash = p_token_hash and user_id is not null and revoked_at is null
  for update;
  if not found then return null; end if;

  select public.board_v8_permission(b.id, p_board_key_hash), b.realtime_key
  into v_permission, v_realtime_key
  from public.boards b
  where b.id = p_board_id and b.owner_user_id = v_agent.user_id;

  if v_permission is null or v_permission not in ('owner', 'edit') then return null; end if;
  update public.teacher_mac_agents_v9 set last_seen_at = now() where id = v_agent.id;

  return jsonb_build_object(
    'boardId', p_board_id,
    'realtimeKey', v_realtime_key,
    'permission', v_permission
  );
end;
$$;

-- Existing board creation keeps its external signature. Signed-in teachers gain
-- account ownership; signed-out and student workflows remain unchanged.
create or replace function public.create_board_fast_v8(
  p_id text,
  p_title text,
  p_student_name text,
  p_owner_key_hash text,
  p_share_key_hash text,
  p_realtime_key text
)
returns table(board_id text, created_at timestamptz)
language sql
security definer
set search_path = public, pg_temp
as $$
  with inserted as (
    insert into public.boards (
      id, title, student_name, owner_key_hash, share_key_hash, realtime_key,
      snapshot, snapshot_revision, background, object_store_version, object_count,
      next_order_key, owner_user_id
    ) values (
      p_id,
      coalesce(nullif(trim(p_title), ''), 'Новая доска'),
      left(trim(coalesce(p_student_name, '')), 120),
      p_owner_key_hash,
      p_share_key_hash,
      p_realtime_key,
      '{"version":2,"background":"grid","canvas":{"objects":[]}}'::jsonb,
      0, 'grid', 7, 0, 1024, auth.uid()
    )
    returning id, boards.created_at
  )
  select inserted.id::text, inserted.created_at from inserted;
$$;

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
set search_path = public, pg_temp
as $$
begin
  insert into public.boards (
    id, title, owner_key_hash, share_key_hash, realtime_key,
    snapshot, snapshot_revision, background, object_store_version, object_count,
    next_order_key, owner_user_id
  ) values (
    p_id,
    coalesce(nullif(trim(p_title), ''), 'Новая доска'),
    p_owner_key_hash,
    p_share_key_hash,
    p_realtime_key,
    '{"version":2,"background":"grid","canvas":{"objects":[]}}'::jsonb,
    0, 'grid', 7, 0, 1024, auth.uid()
  );
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
set search_path = public, pg_temp
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
    object_store_version, object_count, next_order_key, revision, created_at,
    updated_at, last_lesson_at, owner_user_id
  ) values (
    p_new_id,
    coalesce(nullif(trim(p_new_title), ''), source_board.title || ' — копия'),
    source_board.student_name,
    p_new_owner_key_hash,
    p_new_share_key_hash,
    p_new_realtime_key,
    'edit', false, source_snapshot, 0, source_board.background,
    7, source_board.object_count, source_board.next_order_key, 0, now(), now(), null,
    auth.uid()
  );

  insert into public.board_objects(
    board_id, object_id, object_json, z_index, updated_revision, updated_at
  )
  select p_new_id, object_id, object_json, z_index, 0, now()
  from public.board_objects where board_id = p_source_id;
  return true;
end;
$$;

revoke all on function public.ensure_teacher_account_v9() from public;
revoke all on function public.claim_owned_boards_for_account_v9(jsonb) from public;
revoke all on function public.register_teacher_mac_agent_v9(text, text, text) from public;
revoke all on function public.claim_teacher_mac_agent_v9(text) from public;
revoke all on function public.get_teacher_account_mac_status_v9() from public;
revoke all on function public.revoke_teacher_mac_agent_v9(uuid) from public;
revoke all on function public.get_board_teacher_account_v9(text, text) from public;
revoke all on function public.authorize_teacher_mac_request_v9(text, text, text) from public;

grant execute on function public.ensure_teacher_account_v9() to authenticated;
grant execute on function public.claim_owned_boards_for_account_v9(jsonb) to authenticated;
grant execute on function public.claim_teacher_mac_agent_v9(text) to authenticated;
grant execute on function public.get_teacher_account_mac_status_v9() to authenticated;
grant execute on function public.revoke_teacher_mac_agent_v9(uuid) to authenticated;
grant execute on function public.register_teacher_mac_agent_v9(text, text, text) to anon, authenticated;
grant execute on function public.get_board_teacher_account_v9(text, text) to anon, authenticated;
grant execute on function public.authorize_teacher_mac_request_v9(text, text, text) to anon, authenticated;

-- Supabase projects can have default function privileges for anon. Authenticated-only
-- account operations explicitly remove that default grant as defense in depth.
revoke execute on function public.ensure_teacher_account_v9() from anon;
revoke execute on function public.claim_owned_boards_for_account_v9(jsonb) from anon;
revoke execute on function public.claim_teacher_mac_agent_v9(text) from anon;
revoke execute on function public.get_teacher_account_mac_status_v9() from anon;
revoke execute on function public.revoke_teacher_mac_agent_v9(uuid) from anon;

grant execute on function public.create_board_fast_v8(text, text, text, text, text, text) to anon, authenticated;
grant execute on function public.create_board(text, text, text, text, text) to anon, authenticated;
grant execute on function public.duplicate_board_v7(text, text, text, text, text, text, text) to anon, authenticated;
