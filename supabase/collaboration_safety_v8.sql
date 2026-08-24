-- Alex Board 1.32.18
-- Collaborative safety upgrade for the authoritative v8 journal.
--
-- Adds:
--   1. Server-enforced per-object selection leases.
--   2. A materialized current-object state used by conditional Undo/Redo.
--   3. Conditional operations that apply only fields which were not changed later.
--
-- Run once in Supabase SQL Editor before publishing the 1.32.18 client.

begin;

alter table public.board_actions_v8
  add column if not exists skipped_conflicts jsonb not null default '[]'::jsonb;

create table if not exists public.board_object_states_v8 (
  board_id text not null references public.boards(id) on delete cascade,
  object_id text not null,
  object jsonb,
  z_index integer,
  deleted boolean not null default false,
  revision bigint not null default 0,
  action_id text not null default '',
  client_id text not null default '',
  mutation_id text not null default '',
  updated_at timestamptz not null default now(),
  primary key (board_id, object_id),
  check (object is null or jsonb_typeof(object) = 'object')
);

create table if not exists public.board_object_state_heads_v8 (
  board_id text primary key references public.boards(id) on delete cascade,
  revision bigint not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.board_object_locks_v8 (
  board_id text not null references public.boards(id) on delete cascade,
  object_id text not null,
  client_id text not null,
  lock_token text not null,
  acquired_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (board_id, object_id),
  check (length(client_id) between 1 and 160),
  check (length(lock_token) between 8 and 200)
);

create table if not exists public.board_action_noop_outcomes_v8 (
  board_id text not null references public.boards(id) on delete cascade,
  action_id text not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (board_id, action_id),
  check (jsonb_typeof(result) = 'object')
);

create index if not exists board_object_locks_v8_client_idx
  on public.board_object_locks_v8 (board_id, client_id);

create index if not exists board_object_locks_v8_expiry_idx
  on public.board_object_locks_v8 (expires_at);

alter table public.board_object_states_v8 enable row level security;
alter table public.board_object_state_heads_v8 enable row level security;
alter table public.board_object_locks_v8 enable row level security;
alter table public.board_action_noop_outcomes_v8 enable row level security;

revoke all on public.board_object_states_v8 from public, anon, authenticated;
revoke all on public.board_object_state_heads_v8 from public, anon, authenticated;
revoke all on public.board_object_locks_v8 from public, anon, authenticated;
revoke all on public.board_action_noop_outcomes_v8 from public, anon, authenticated;

create or replace function public.board_v8_apply_materialized_ops(
  p_id text,
  p_revision bigint,
  p_action_id text,
  p_client_id text,
  p_ops jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_op jsonb;
  v_entry jsonb;
  v_id text;
  v_object jsonb;
  v_unset_key text;
  v_mutation_id text;
begin
  for v_op in select value from jsonb_array_elements(coalesce(p_ops, '[]'::jsonb)) loop
    v_mutation_id := coalesce(nullif(v_op->>'mutationId', ''), p_action_id);

    if v_op->>'type' = 'upsert' then
      v_id := nullif(v_op->'object'->>'boardObjectId', '');
      if v_id is null then continue; end if;
      insert into public.board_object_states_v8 (
        board_id, object_id, object, z_index, deleted, revision,
        action_id, client_id, mutation_id, updated_at
      ) values (
        p_id,
        v_id,
        v_op->'object',
        case when jsonb_typeof(v_op->'zIndex') = 'number' then (v_op->>'zIndex')::integer else null end,
        false,
        p_revision,
        p_action_id,
        coalesce(p_client_id, ''),
        v_mutation_id,
        now()
      )
      on conflict (board_id, object_id) do update set
        object = excluded.object,
        z_index = case
          when v_op ? 'zIndex' then excluded.z_index
          else public.board_object_states_v8.z_index
        end,
        deleted = false,
        revision = excluded.revision,
        action_id = excluded.action_id,
        client_id = excluded.client_id,
        mutation_id = excluded.mutation_id,
        updated_at = now();
      continue;
    end if;

    if v_op->>'type' = 'delete' then
      v_id := nullif(v_op->>'id', '');
      if v_id is null then continue; end if;
      insert into public.board_object_states_v8 (
        board_id, object_id, object, z_index, deleted, revision,
        action_id, client_id, mutation_id, updated_at
      ) values (
        p_id, v_id, null, null, true, p_revision,
        p_action_id, coalesce(p_client_id, ''), v_mutation_id, now()
      )
      on conflict (board_id, object_id) do update set
        deleted = true,
        revision = excluded.revision,
        action_id = excluded.action_id,
        client_id = excluded.client_id,
        mutation_id = excluded.mutation_id,
        updated_at = now();
      continue;
    end if;

    if v_op->>'type' = 'patch' then
      v_id := nullif(v_op->>'id', '');
      if v_id is null then continue; end if;
      select s.object into v_object
      from public.board_object_states_v8 s
      where s.board_id = p_id and s.object_id = v_id and not s.deleted;
      if v_object is null then continue; end if;

      for v_unset_key in
        select value from jsonb_array_elements_text(coalesce(v_op->'unset', '[]'::jsonb))
      loop
        v_object := v_object - v_unset_key;
      end loop;
      v_object := v_object || coalesce(v_op->'patch', '{}'::jsonb);
      v_object := v_object || jsonb_build_object(
        'boardObjectId', v_id,
        'updatedAt', coalesce(v_op->'updatedAt', v_object->'updatedAt', to_jsonb(0)),
        'updatedBy', coalesce(v_op->'updatedBy', v_object->'updatedBy', 'null'::jsonb)
      );

      update public.board_object_states_v8
      set object = v_object,
          z_index = case
            when coalesce((v_op->>'reorder')::boolean, false) and v_op ? 'zIndex'
              then (v_op->>'zIndex')::integer
            else z_index
          end,
          revision = p_revision,
          action_id = p_action_id,
          client_id = coalesce(p_client_id, ''),
          mutation_id = v_mutation_id,
          updated_at = now()
      where board_id = p_id and object_id = v_id and not deleted;
      continue;
    end if;

    if v_op->>'type' = 'transform' then
      for v_entry in
        select value
        from jsonb_array_elements(
          case
            when jsonb_typeof(v_op->'objects') = 'array' then v_op->'objects'
            else jsonb_build_array(jsonb_build_object(
              'id', v_op->>'id',
              'transform', v_op->'transform',
              'updatedAt', v_op->'updatedAt',
              'updatedBy', v_op->'updatedBy',
              'zIndex', v_op->'zIndex'
            ))
          end
        )
      loop
        v_id := nullif(v_entry->>'id', '');
        if v_id is null then continue; end if;
        update public.board_object_states_v8
        set object = object
              || coalesce(v_entry->'transform', '{}'::jsonb)
              || jsonb_build_object(
                'boardObjectId', v_id,
                'updatedAt', coalesce(v_entry->'updatedAt', object->'updatedAt', to_jsonb(0)),
                'updatedBy', coalesce(v_entry->'updatedBy', object->'updatedBy', 'null'::jsonb)
              ),
            z_index = case
              when coalesce((v_op->>'reorder')::boolean, false) and v_entry ? 'zIndex'
                then (v_entry->>'zIndex')::integer
              else z_index
            end,
            revision = p_revision,
            action_id = p_action_id,
            client_id = coalesce(p_client_id, ''),
            mutation_id = coalesce(nullif(v_entry->>'mutationId', ''), v_mutation_id),
            updated_at = now()
        where board_id = p_id and object_id = v_id and not deleted;
      end loop;
    end if;
  end loop;

  insert into public.board_object_state_heads_v8 (board_id, revision, updated_at)
  values (p_id, p_revision, now())
  on conflict (board_id) do update set
    revision = greatest(public.board_object_state_heads_v8.revision, excluded.revision),
    updated_at = now();
end
$$;

revoke all on function public.board_v8_apply_materialized_ops(text, bigint, text, text, jsonb)
  from public, anon, authenticated;

create or replace function public.board_v8_rebuild_materialized_states()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_board record;
  v_action record;
  v_head bigint;
begin
  for v_board in
    select
      b.id::text as board_id,
      b.snapshot::jsonb as snapshot,
      coalesce(b.snapshot_revision, 0)::bigint as snapshot_revision,
      coalesce(b.revision, 0)::bigint as current_revision
    from public.boards b
    order by b.id
  loop
    select h.revision into v_head
    from public.board_object_state_heads_v8 h
    where h.board_id = v_board.board_id;

    if v_head is null then
      delete from public.board_object_states_v8 where board_id = v_board.board_id;
      insert into public.board_object_states_v8 (
        board_id, object_id, object, z_index, deleted, revision,
        action_id, client_id, mutation_id, updated_at
      )
      select
        v_board.board_id,
        item.value->>'boardObjectId',
        item.value,
        (item.ordinality - 1)::integer,
        false,
        v_board.snapshot_revision,
        'snapshot',
        coalesce(item.value->>'updatedBy', 'snapshot'),
        'snapshot',
        now()
      from jsonb_array_elements(
        case
          when jsonb_typeof(v_board.snapshot->'canvas'->'objects') = 'array'
            then v_board.snapshot->'canvas'->'objects'
          else '[]'::jsonb
        end
      ) with ordinality item(value, ordinality)
      where nullif(item.value->>'boardObjectId', '') is not null
      on conflict (board_id, object_id) do update set
        object = excluded.object,
        z_index = excluded.z_index,
        deleted = false,
        revision = excluded.revision,
        action_id = excluded.action_id,
        client_id = excluded.client_id,
        mutation_id = excluded.mutation_id,
        updated_at = now();

      v_head := v_board.snapshot_revision;
      insert into public.board_object_state_heads_v8 (board_id, revision, updated_at)
      values (v_board.board_id, v_head, now())
      on conflict (board_id) do update set revision = excluded.revision, updated_at = now();
    end if;

    for v_action in
      select a.revision, a.action_id, a.client_id, a.ops
      from public.board_actions_v8 a
      where a.board_id = v_board.board_id and a.revision > v_head
      order by a.revision
    loop
      if v_action.revision <> v_head + 1 then
        raise exception 'BOARD_V8_MATERIALIZATION_GAP:%:%:%',
          v_board.board_id, v_head + 1, v_action.revision using errcode = 'P0001';
      end if;
      perform public.board_v8_apply_materialized_ops(
        v_board.board_id,
        v_action.revision,
        v_action.action_id,
        v_action.client_id,
        v_action.ops
      );
      v_head := v_action.revision;
    end loop;

    if v_head <> v_board.current_revision then
      raise exception 'BOARD_V8_MATERIALIZATION_INCOMPLETE:%:%:%',
        v_board.board_id, v_head, v_board.current_revision using errcode = 'P0001';
    end if;
  end loop;
end
$$;

revoke all on function public.board_v8_rebuild_materialized_states()
  from public, anon, authenticated;

select public.board_v8_rebuild_materialized_states();

create or replace function public.acquire_board_object_locks_v8(
  p_id text,
  p_key_hash text,
  p_client_id text,
  p_lock_token text,
  p_object_ids jsonb,
  p_ttl_seconds integer default 12
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_permission text;
  v_ids text[];
  v_conflicts jsonb;
  v_expires_at timestamptz;
begin
  if nullif(p_client_id, '') is null
    or nullif(p_lock_token, '') is null
    or length(p_lock_token) < 8
    or jsonb_typeof(coalesce(p_object_ids, '[]'::jsonb)) <> 'array'
  then
    raise exception 'Invalid object lock request' using errcode = '22023';
  end if;

  select array_agg(distinct value order by value) into v_ids
  from jsonb_array_elements_text(p_object_ids)
  where nullif(value, '') is not null;
  if coalesce(array_length(v_ids, 1), 0) = 0
    or array_length(v_ids, 1) > 10000
  then
    raise exception 'Invalid object lock count' using errcode = '22023';
  end if;

  select case
    when b.owner_key_hash = p_key_hash then 'owner'
    when b.share_key_hash = p_key_hash then b.guest_mode::text
    else null
  end into v_permission
  from public.boards b
  where b.id = p_id
  for update;

  if v_permission is null or v_permission not in ('owner', 'edit') then
    raise exception 'Board is read-only' using errcode = '42501';
  end if;

  delete from public.board_object_locks_v8
  where board_id = p_id and expires_at <= now();

  select coalesce(jsonb_agg(jsonb_build_object(
    'objectId', l.object_id,
    'clientId', l.client_id,
    'expiresAt', l.expires_at
  ) order by l.object_id), '[]'::jsonb)
  into v_conflicts
  from public.board_object_locks_v8 l
  where l.board_id = p_id
    and l.object_id = any(v_ids)
    and l.client_id <> p_client_id
    and l.expires_at > now();

  if jsonb_array_length(v_conflicts) > 0 then
    return jsonb_build_object(
      'granted', false,
      'conflicts', v_conflicts,
      'objectIds', to_jsonb(v_ids)
    );
  end if;

  v_expires_at := now() + make_interval(secs => greatest(6, least(coalesce(p_ttl_seconds, 12), 30)));

  -- Atomically replace this client's previous selection only after the new selection
  -- is known to be free. The board row lock serializes competing acquisitions.
  delete from public.board_object_locks_v8
  where board_id = p_id
    and client_id = p_client_id
    and not (object_id = any(v_ids));

  insert into public.board_object_locks_v8 (
    board_id, object_id, client_id, lock_token, acquired_at, expires_at
  )
  select p_id, object_id, p_client_id, p_lock_token, now(), v_expires_at
  from unnest(v_ids) object_id
  on conflict (board_id, object_id) do update set
    client_id = excluded.client_id,
    lock_token = excluded.lock_token,
    acquired_at = excluded.acquired_at,
    expires_at = excluded.expires_at;

  return jsonb_build_object(
    'granted', true,
    'objectIds', to_jsonb(v_ids),
    'lockToken', p_lock_token,
    'expiresAt', v_expires_at,
    'conflicts', '[]'::jsonb
  );
end
$$;

create or replace function public.refresh_board_object_locks_v8(
  p_id text,
  p_key_hash text,
  p_client_id text,
  p_lock_token text,
  p_ttl_seconds integer default 12
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_permission text;
  v_expires_at timestamptz;
  v_ids jsonb;
begin
  select case
    when b.owner_key_hash = p_key_hash then 'owner'
    when b.share_key_hash = p_key_hash then b.guest_mode::text
    else null
  end into v_permission
  from public.boards b
  where b.id = p_id;

  if v_permission is null or v_permission not in ('owner', 'edit') then
    raise exception 'Board is read-only' using errcode = '42501';
  end if;

  v_expires_at := now() + make_interval(secs => greatest(6, least(coalesce(p_ttl_seconds, 12), 30)));
  update public.board_object_locks_v8
  set expires_at = v_expires_at
  where board_id = p_id
    and client_id = p_client_id
    and lock_token = p_lock_token
    and expires_at > now();

  select coalesce(jsonb_agg(object_id order by object_id), '[]'::jsonb) into v_ids
  from public.board_object_locks_v8
  where board_id = p_id and client_id = p_client_id and lock_token = p_lock_token;

  return jsonb_build_object(
    'refreshed', jsonb_array_length(v_ids) > 0,
    'objectIds', v_ids,
    'lockToken', p_lock_token,
    'expiresAt', v_expires_at
  );
end
$$;

create or replace function public.release_board_object_locks_v8(
  p_id text,
  p_key_hash text,
  p_client_id text,
  p_lock_token text default null
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_permission text;
  v_count integer;
begin
  select case
    when b.owner_key_hash = p_key_hash then 'owner'
    when b.share_key_hash = p_key_hash then b.guest_mode::text
    else null
  end into v_permission
  from public.boards b
  where b.id = p_id;

  if v_permission is null then
    raise exception 'Board access denied' using errcode = '42501';
  end if;

  delete from public.board_object_locks_v8
  where board_id = p_id
    and client_id = p_client_id
    and (p_lock_token is null or lock_token = p_lock_token);
  get diagnostics v_count = row_count;
  return v_count;
end
$$;

create or replace function public.get_board_object_locks_v8(
  p_id text,
  p_key_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if public.board_v8_permission(p_id, p_key_hash) is null then
    raise exception 'Board access denied' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'objectId', l.object_id,
      'clientId', l.client_id,
      'expiresAt', l.expires_at
    ) order by l.object_id)
    from public.board_object_locks_v8 l
    where l.board_id = p_id and l.expires_at > now()
  ), '[]'::jsonb);
end
$$;

create or replace function public.apply_board_action_v8(
  p_id text,
  p_key_hash text,
  p_action_id text,
  p_client_id text,
  p_ops jsonb,
  p_background text,
  p_client_revision bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_permission text;
  v_before bigint;
  v_revision bigint;
  v_existing public.board_actions_v8%rowtype;
  v_prior_noop jsonb;
  v_ops jsonb := coalesce(p_ops, '[]'::jsonb);
  v_applied_ops jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_rejected jsonb := '[]'::jsonb;
  v_changed boolean;
  v_head bigint;
  v_op jsonb;
  v_entry jsonb;
  v_clean_op jsonb;
  v_safe_entries jsonb;
  v_safe_patch jsonb;
  v_safe_unset jsonb;
  v_skipped_fields jsonb;
  v_id text;
  v_key text;
  v_value jsonb;
  v_current public.board_object_states_v8%rowtype;
  v_ok boolean;
  v_field_ok boolean;
  v_reorder_ok boolean;
  v_conditioned boolean;
begin
  if p_action_id is null or length(p_action_id) < 8 then
    raise exception 'Invalid action id' using errcode = '22023';
  end if;
  if jsonb_typeof(v_ops) <> 'array' then
    raise exception 'Operations must be a JSON array' using errcode = '22023';
  end if;
  if p_background is not null and p_background not in ('grid', 'dots', 'blank') then
    raise exception 'Invalid board background' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_ops) op
    where coalesce(op->>'type', '') not in ('upsert', 'delete', 'transform', 'patch')
  ) then
    raise exception 'Unsupported board operation' using errcode = '22023';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(v_ops) op
    where case op->>'type'
      when 'upsert' then
        jsonb_typeof(op->'object') is distinct from 'object'
        or nullif(op->'object'->>'boardObjectId', '') is null
      when 'delete' then
        nullif(op->>'id', '') is null
      when 'patch' then
        nullif(op->>'id', '') is null
        or jsonb_typeof(op->'patch') is distinct from 'object'
        or (op ? 'unset' and jsonb_typeof(op->'unset') is distinct from 'array')
        or (op ? 'ifFields' and jsonb_typeof(op->'ifFields') is distinct from 'object')
        or (op ? 'ifAbsent' and jsonb_typeof(op->'ifAbsent') is distinct from 'array')
      when 'transform' then not (
        (
          nullif(op->>'id', '') is not null
          and jsonb_typeof(op->'transform') is not distinct from 'object'
        )
        or case
          when jsonb_typeof(op->'objects') is not distinct from 'array' then
            jsonb_array_length(op->'objects') > 0
            and not exists (
              select 1
              from jsonb_array_elements(op->'objects') entry
              where nullif(entry->>'id', '') is null
                or jsonb_typeof(entry->'transform') is distinct from 'object'
                or (entry ? 'ifTransform' and jsonb_typeof(entry->'ifTransform') is distinct from 'object')
            )
          else false
        end
      )
      else true
    end
  ) then
    raise exception 'Malformed board operation' using errcode = '22023';
  end if;

  select case
    when b.owner_key_hash = p_key_hash then 'owner'
    when b.share_key_hash = p_key_hash then b.guest_mode::text
    else null
  end, coalesce(b.revision, 0)::bigint
  into v_permission, v_before
  from public.boards b
  where b.id = p_id
  for update;

  if v_permission is null or v_permission not in ('owner', 'edit') then
    raise exception 'Board is read-only' using errcode = '42501';
  end if;

  select * into v_existing
  from public.board_actions_v8 a
  where a.board_id = p_id and a.action_id = p_action_id;
  if found then
    return jsonb_build_object(
      'revision', v_existing.revision,
      'needs_sync', v_existing.revision > coalesce(p_client_revision, 0) + 1,
      'updated_at', v_existing.created_at,
      'already_applied', true,
      'changed', true,
      'applied_ops', v_existing.ops,
      'applied_background', v_existing.background,
      'rejected_object_ids', '[]'::jsonb,
      'skipped_conflicts', coalesce(v_existing.skipped_conflicts, '[]'::jsonb)
    );
  end if;

  select n.result into v_prior_noop
  from public.board_action_noop_outcomes_v8 n
  where n.board_id = p_id and n.action_id = p_action_id;
  if v_prior_noop is not null then return v_prior_noop; end if;

  select h.revision into v_head
  from public.board_object_state_heads_v8 h where h.board_id = p_id;
  if v_head is null and v_before = 0 then
    insert into public.board_object_state_heads_v8 (board_id, revision, updated_at)
    values (p_id, 0, now())
    on conflict (board_id) do nothing;
    v_head := 0;
  end if;
  if v_head is distinct from v_before then
    raise exception 'BOARD_V8_MATERIALIZED_STATE_BEHIND:%:%', coalesce(v_head, -1), v_before
      using errcode = '40001';
  end if;

  delete from public.board_object_locks_v8
  where board_id = p_id and expires_at <= now();

  with affected(object_id) as (
    select op->>'id'
    from jsonb_array_elements(v_ops) op
    where op->>'type' in ('delete', 'patch') and nullif(op->>'id', '') is not null
    union
    select op->'object'->>'boardObjectId'
    from jsonb_array_elements(v_ops) op
    where op->>'type' = 'upsert' and nullif(op->'object'->>'boardObjectId', '') is not null
    union
    select entry->>'id'
    from jsonb_array_elements(v_ops) op
    cross join lateral jsonb_array_elements(
      case
        when jsonb_typeof(op->'objects') = 'array' then op->'objects'
        else jsonb_build_array(jsonb_build_object('id', op->>'id'))
      end
    ) entry
    where op->>'type' = 'transform' and nullif(entry->>'id', '') is not null
  )
  select coalesce(jsonb_agg(l.object_id order by l.object_id), '[]'::jsonb)
  into v_rejected
  from public.board_object_locks_v8 l
  join affected a on a.object_id = l.object_id
  where l.board_id = p_id
    and l.client_id <> coalesce(p_client_id, '')
    and l.expires_at > now();

  if jsonb_array_length(v_rejected) > 0 then
    return jsonb_build_object(
      'revision', v_before,
      'needs_sync', v_before > coalesce(p_client_revision, 0),
      'updated_at', now(),
      'already_applied', false,
      'changed', false,
      'applied_ops', '[]'::jsonb,
      'applied_background', null,
      'rejected_object_ids', v_rejected,
      'skipped_conflicts', '[]'::jsonb
    );
  end if;

  for v_op in select value from jsonb_array_elements(v_ops) loop
    v_conditioned := v_op ? 'ifFields'
      or v_op ? 'ifAbsent'
      or v_op ? 'ifObjectVersion'
      or v_op ? 'ifDeletedBy'
      or v_op ? 'ifDeletedMutationId'
      or v_op ? 'ifZIndex';

    if v_op->>'type' = 'upsert' then
      v_id := v_op->'object'->>'boardObjectId';
      select * into v_current from public.board_object_states_v8
      where board_id = p_id and object_id = v_id;
      v_ok := true;
      if v_op ? 'ifDeletedBy' then
        v_ok := found and v_current.deleted and v_current.client_id = v_op->>'ifDeletedBy';
      end if;
      if v_ok and v_op ? 'ifDeletedMutationId' then
        v_ok := found and v_current.deleted
          and v_current.mutation_id = v_op->>'ifDeletedMutationId';
      end if;
      if v_ok then
        v_applied_ops := v_applied_ops || jsonb_build_array(
          v_op - 'ifDeletedBy' - 'ifDeletedMutationId' - 'ifFields' - 'ifAbsent' - 'ifZIndex'
        );
      else
        v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
          'objectId', v_id, 'reason', 'object_changed'
        ));
      end if;
      continue;
    end if;

    if v_op->>'type' = 'delete' then
      v_id := v_op->>'id';
      select * into v_current from public.board_object_states_v8
      where board_id = p_id and object_id = v_id;
      v_ok := true;
      if v_op ? 'ifObjectVersion' then
        v_ok := found and not v_current.deleted and v_current.object is not null;
        if v_ok then
          for v_key, v_value in select key, value from jsonb_each(v_op->'ifObjectVersion') loop
            if not (v_current.object ? v_key) or v_current.object->v_key <> v_value then
              v_ok := false;
              exit;
            end if;
          end loop;
        end if;
      end if;
      if v_ok and v_op ? 'ifZIndex' then
        v_ok := v_current.z_index is not distinct from (v_op->>'ifZIndex')::integer;
      end if;
      if v_ok then
        v_applied_ops := v_applied_ops || jsonb_build_array(
          v_op - 'ifObjectVersion' - 'ifZIndex' - 'ifFields' - 'ifAbsent'
        );
      else
        v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
          'objectId', v_id, 'reason', 'object_changed'
        ));
      end if;
      continue;
    end if;

    if v_op->>'type' = 'patch' then
      v_id := v_op->>'id';
      select * into v_current from public.board_object_states_v8
      where board_id = p_id and object_id = v_id;
      if (not found or v_current.deleted or v_current.object is null) and v_conditioned then
        v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
          'objectId', v_id, 'reason', 'object_missing'
        ));
        continue;
      end if;
      if not found or v_current.deleted or v_current.object is null then
        v_applied_ops := v_applied_ops || jsonb_build_array(
          v_op - 'ifFields' - 'ifAbsent' - 'ifZIndex'
        );
        continue;
      end if;

      v_safe_patch := '{}'::jsonb;
      v_safe_unset := '[]'::jsonb;
      v_skipped_fields := '[]'::jsonb;
      for v_key, v_value in select key, value from jsonb_each(coalesce(v_op->'patch', '{}'::jsonb)) loop
        v_field_ok := true;
        if coalesce(v_op->'ifFields', '{}'::jsonb) ? v_key then
          v_field_ok := v_current.object ? v_key
            and v_current.object->v_key = v_op->'ifFields'->v_key;
        elsif coalesce(v_op->'ifAbsent', '[]'::jsonb) ? v_key then
          v_field_ok := not (v_current.object ? v_key);
        end if;
        if v_field_ok then
          v_safe_patch := v_safe_patch || jsonb_build_object(v_key, v_value);
        else
          v_skipped_fields := v_skipped_fields || jsonb_build_array(v_key);
        end if;
      end loop;

      for v_key in
        select value from jsonb_array_elements_text(coalesce(v_op->'unset', '[]'::jsonb))
      loop
        v_field_ok := true;
        if coalesce(v_op->'ifFields', '{}'::jsonb) ? v_key then
          v_field_ok := v_current.object ? v_key
            and v_current.object->v_key = v_op->'ifFields'->v_key;
        elsif coalesce(v_op->'ifAbsent', '[]'::jsonb) ? v_key then
          v_field_ok := not (v_current.object ? v_key);
        end if;
        if v_field_ok then
          v_safe_unset := v_safe_unset || jsonb_build_array(v_key);
        else
          v_skipped_fields := v_skipped_fields || jsonb_build_array(v_key);
        end if;
      end loop;

      v_reorder_ok := coalesce((v_op->>'reorder')::boolean, false);
      if v_reorder_ok and v_op ? 'ifZIndex' then
        v_reorder_ok := v_current.z_index is not distinct from (v_op->>'ifZIndex')::integer;
        if not v_reorder_ok then
          v_skipped_fields := v_skipped_fields || jsonb_build_array('__zIndex');
        end if;
      end if;

      if v_safe_patch <> '{}'::jsonb
        or jsonb_array_length(v_safe_unset) > 0
        or v_reorder_ok
        or not v_conditioned
      then
        v_clean_op := (v_op - 'ifFields' - 'ifAbsent' - 'ifZIndex')
          || jsonb_build_object('patch', v_safe_patch);
        if jsonb_array_length(v_safe_unset) > 0 then
          v_clean_op := v_clean_op || jsonb_build_object('unset', v_safe_unset);
        else
          v_clean_op := v_clean_op - 'unset';
        end if;
        if coalesce((v_op->>'reorder')::boolean, false) and not v_reorder_ok then
          v_clean_op := v_clean_op - 'reorder' - 'zIndex';
        end if;
        v_applied_ops := v_applied_ops || jsonb_build_array(v_clean_op);
      end if;
      if jsonb_array_length(v_skipped_fields) > 0 then
        v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
          'objectId', v_id, 'reason', 'fields_changed', 'fields', v_skipped_fields
        ));
      end if;
      continue;
    end if;

    if v_op->>'type' = 'transform' then
      v_safe_entries := '[]'::jsonb;
      for v_entry in
        select value from jsonb_array_elements(
          case
            when jsonb_typeof(v_op->'objects') = 'array' then v_op->'objects'
            else jsonb_build_array(jsonb_build_object(
              'id', v_op->>'id',
              'transform', v_op->'transform',
              'updatedAt', v_op->'updatedAt',
              'updatedBy', v_op->'updatedBy',
              'ifTransform', v_op->'ifTransform',
              'ifZIndex', v_op->'ifZIndex'
            ))
          end
        )
      loop
        v_id := v_entry->>'id';
        select * into v_current from public.board_object_states_v8
        where board_id = p_id and object_id = v_id;
        v_ok := true;
        if v_entry ? 'ifTransform' then
          v_ok := found and not v_current.deleted and v_current.object is not null;
          if v_ok then
            for v_key, v_value in select key, value from jsonb_each(v_entry->'ifTransform') loop
              if not (v_current.object ? v_key) or v_current.object->v_key <> v_value then
                v_ok := false;
                exit;
              end if;
            end loop;
          end if;
        end if;
        if v_ok and v_entry ? 'ifZIndex' then
          v_ok := v_current.z_index is not distinct from (v_entry->>'ifZIndex')::integer;
        end if;
        if v_ok then
          v_safe_entries := v_safe_entries || jsonb_build_array(
            v_entry - 'ifTransform' - 'ifZIndex'
          );
        else
          v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
            'objectId', v_id, 'reason', 'transform_changed'
          ));
        end if;
      end loop;
      if jsonb_array_length(v_safe_entries) > 0 then
        v_clean_op := (v_op - 'id' - 'transform' - 'updatedAt' - 'updatedBy'
          - 'ifTransform' - 'ifZIndex' - 'objects')
          || jsonb_build_object('objects', v_safe_entries);
        v_applied_ops := v_applied_ops || jsonb_build_array(v_clean_op);
      end if;
    end if;
  end loop;

  v_changed := jsonb_array_length(v_applied_ops) > 0 or p_background is not null;
  if not v_changed then
    v_prior_noop := jsonb_build_object(
      'revision', v_before,
      'needs_sync', v_before > coalesce(p_client_revision, 0),
      'updated_at', now(),
      'already_applied', false,
      'changed', false,
      'applied_ops', '[]'::jsonb,
      'applied_background', null,
      'rejected_object_ids', '[]'::jsonb,
      'skipped_conflicts', v_skipped
    );
    insert into public.board_action_noop_outcomes_v8 (board_id, action_id, result)
    values (p_id, p_action_id, v_prior_noop)
    on conflict (board_id, action_id) do nothing;
    return v_prior_noop;
  end if;

  v_revision := v_before + 1;
  insert into public.board_actions_v8 (
    board_id, revision, action_id, client_id, ops, background, skipped_conflicts
  ) values (
    p_id, v_revision, p_action_id, coalesce(p_client_id, ''),
    v_applied_ops, p_background, v_skipped
  );

  update public.boards
  set revision = v_revision, updated_at = now()
  where id = p_id;

  perform public.board_v8_apply_materialized_ops(
    p_id, v_revision, p_action_id, p_client_id, v_applied_ops
  );

  insert into public.board_action_heads_v8 (board_id, revision, log_floor_revision, updated_at)
  values (p_id, v_revision, v_before, now())
  on conflict (board_id) do update set
    revision = excluded.revision,
    updated_at = excluded.updated_at;

  return jsonb_build_object(
    'revision', v_revision,
    'needs_sync', v_before > coalesce(p_client_revision, 0),
    'updated_at', now(),
    'already_applied', false,
    'changed', true,
    'applied_ops', v_applied_ops,
    'applied_background', p_background,
    'rejected_object_ids', '[]'::jsonb,
    'skipped_conflicts', v_skipped
  );
end
$$;

create or replace function public.save_board_snapshot_v8(
  p_id text,
  p_key_hash text,
  p_snapshot jsonb,
  p_client_revision bigint
)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_permission text;
  v_current bigint;
  v_snapshot_revision bigint;
  v_state_head bigint;
begin
  select case
    when b.owner_key_hash = p_key_hash then 'owner'
    when b.share_key_hash = p_key_hash then b.guest_mode::text
    else null
  end,
  coalesce(b.revision, 0)::bigint,
  coalesce(b.snapshot_revision, 0)::bigint
  into v_permission, v_current, v_snapshot_revision
  from public.boards b where b.id = p_id for update;

  if v_permission is null or v_permission not in ('owner', 'edit') then
    raise exception 'Board is read-only' using errcode = '42501';
  end if;
  if p_client_revision < v_snapshot_revision or p_client_revision > v_current then
    raise exception 'Snapshot revision is not authoritative' using errcode = '40001';
  end if;

  update public.boards
  set snapshot = p_snapshot,
      snapshot_revision = p_client_revision,
      updated_at = now()
  where id = p_id;

  select h.revision into v_state_head
  from public.board_object_state_heads_v8 h where h.board_id = p_id;

  -- A copied board is born at revision zero and receives its complete snapshot before
  -- the first action. Seed its materialized state once so conditional history and locks
  -- see exactly the same objects as every client.
  if v_current = 0 and (v_state_head is null or v_state_head = 0) then
    delete from public.board_object_states_v8 where board_id = p_id;
    insert into public.board_object_states_v8 (
      board_id, object_id, object, z_index, deleted, revision,
      action_id, client_id, mutation_id, updated_at
    )
    select
      p_id,
      item.value->>'boardObjectId',
      item.value,
      (item.ordinality - 1)::integer,
      false,
      0,
      'snapshot',
      coalesce(item.value->>'updatedBy', 'snapshot'),
      'snapshot',
      now()
    from jsonb_array_elements(
      case
        when jsonb_typeof(p_snapshot->'canvas'->'objects') = 'array'
          then p_snapshot->'canvas'->'objects'
        else '[]'::jsonb
      end
    ) with ordinality item(value, ordinality)
    where nullif(item.value->>'boardObjectId', '') is not null
    on conflict (board_id, object_id) do update set
      object = excluded.object,
      z_index = excluded.z_index,
      deleted = false,
      revision = 0,
      action_id = excluded.action_id,
      client_id = excluded.client_id,
      mutation_id = excluded.mutation_id,
      updated_at = now();

    insert into public.board_object_state_heads_v8 (board_id, revision, updated_at)
    values (p_id, 0, now())
    on conflict (board_id) do update set revision = 0, updated_at = now();
  end if;

  return v_current;
end
$$;

-- The existing batch/import functions call apply_board_action_v8, so replacing that
-- one function upgrades every durable write path without introducing a second journal.

revoke all on function public.apply_board_action_v8(text, text, text, text, jsonb, text, bigint)
  from public, anon, authenticated;
revoke all on function public.acquire_board_object_locks_v8(text, text, text, text, jsonb, integer)
  from public, anon, authenticated;
revoke all on function public.refresh_board_object_locks_v8(text, text, text, text, integer)
  from public, anon, authenticated;
revoke all on function public.release_board_object_locks_v8(text, text, text, text)
  from public, anon, authenticated;
revoke all on function public.get_board_object_locks_v8(text, text)
  from public, anon, authenticated;
revoke all on function public.save_board_snapshot_v8(text, text, jsonb, bigint)
  from public, anon, authenticated;

grant execute on function public.apply_board_action_v8(text, text, text, text, jsonb, text, bigint)
  to anon, authenticated;
grant execute on function public.acquire_board_object_locks_v8(text, text, text, text, jsonb, integer)
  to anon, authenticated;
grant execute on function public.refresh_board_object_locks_v8(text, text, text, text, integer)
  to anon, authenticated;
grant execute on function public.release_board_object_locks_v8(text, text, text, text)
  to anon, authenticated;
grant execute on function public.get_board_object_locks_v8(text, text)
  to anon, authenticated;
grant execute on function public.save_board_snapshot_v8(text, text, jsonb, bigint)
  to anon, authenticated;

notify pgrst, 'reload schema';

commit;
