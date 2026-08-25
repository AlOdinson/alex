-- Alex Board 1.34.2
-- Correct the account/Mac hash format to match src/lib/ids.js.
-- sha256() returns a case-sensitive, unpadded Base64URL digest (43 chars),
-- not a lowercase hexadecimal digest (64 chars).

begin;

alter table public.teacher_mac_agents_v9
  drop constraint if exists teacher_mac_agents_v9_token_hash_format,
  drop constraint if exists teacher_mac_agents_v9_pairing_hash_format;

alter table public.teacher_mac_agents_v9
  add constraint teacher_mac_agents_v9_token_hash_format
    check (token_hash ~ '^[A-Za-z0-9_-]{43}$'),
  add constraint teacher_mac_agents_v9_pairing_hash_format
    check (pairing_code_hash ~ '^[A-Za-z0-9_-]{43}$');

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
  if p_token_hash !~ '^[A-Za-z0-9_-]{43}$'
    or p_pairing_code_hash !~ '^[A-Za-z0-9_-]{43}$' then
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
  if p_token_hash !~ '^[A-Za-z0-9_-]{43}$'
    or p_board_key_hash !~ '^[A-Za-z0-9_-]{43}$' then
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

commit;
