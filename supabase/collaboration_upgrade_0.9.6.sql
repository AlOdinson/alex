-- Alex Board 0.9.6: staged atomic bulk actions for safe large cross-board paste.
-- Run after collaboration_upgrade_0.9.5.sql.

create table if not exists public.board_import_chunks (
  board_id text not null references public.boards(id) on delete cascade,
  import_id text not null,
  chunk_index integer not null,
  action_id text not null,
  client_id text,
  ops jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  primary key (board_id, import_id, chunk_index)
);

create index if not exists board_import_chunks_created_idx
  on public.board_import_chunks(created_at);

alter table public.board_import_chunks enable row level security;
revoke all on table public.board_import_chunks from anon, authenticated;

create or replace function public.upload_board_import_chunk_v6(
  p_id text,
  p_key_hash text,
  p_import_id text,
  p_chunk_index integer,
  p_action_id text,
  p_client_id text default null,
  p_ops jsonb default '[]'::jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  b public.boards%rowtype;
begin
  if p_import_id is null or trim(p_import_id) = ''
    or p_action_id is null or trim(p_action_id) = ''
    or p_chunk_index < 0
    or jsonb_typeof(coalesce(p_ops, '[]'::jsonb)) <> 'array' then
    return false;
  end if;

  select * into b from public.boards where id = p_id;
  if not found then return false; end if;
  if not (
    b.owner_key_hash = p_key_hash
    or (b.share_key_hash = p_key_hash and b.guest_mode = 'edit')
  ) then return false; end if;

  delete from public.board_import_chunks
  where created_at < now() - interval '24 hours';

  insert into public.board_import_chunks(
    board_id, import_id, chunk_index, action_id, client_id, ops, created_at
  ) values (
    p_id, p_import_id, p_chunk_index, p_action_id, p_client_id,
    coalesce(p_ops, '[]'::jsonb), now()
  )
  on conflict (board_id, import_id, chunk_index) do update
  set action_id = excluded.action_id,
      client_id = excluded.client_id,
      ops = excluded.ops,
      created_at = excluded.created_at;

  return true;
end;
$$;

create or replace function public.commit_board_import_v6(
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
  b public.boards%rowtype;
  actual_chunk_count integer;
  assembled_ops jsonb;
  result jsonb;
begin
  if p_import_id is null or trim(p_import_id) = ''
    or p_action_id is null or trim(p_action_id) = ''
    or p_chunk_count < 1 then
    return null;
  end if;

  select * into b from public.boards where id = p_id;
  if not found then return null; end if;
  if not (
    b.owner_key_hash = p_key_hash
    or (b.share_key_hash = p_key_hash and b.guest_mode = 'edit')
  ) then return null; end if;

  select count(*) into actual_chunk_count
  from public.board_import_chunks
  where board_id = p_id
    and import_id = p_import_id
    and action_id = p_action_id
    and chunk_index >= 0
    and chunk_index < p_chunk_count;

  if actual_chunk_count <> p_chunk_count then
    raise exception 'Bulk action is incomplete: expected %, received %',
      p_chunk_count, actual_chunk_count;
  end if;

  if exists (
    select 1
    from generate_series(0, p_chunk_count - 1) expected(chunk_index)
    left join public.board_import_chunks c
      on c.board_id = p_id
      and c.import_id = p_import_id
      and c.action_id = p_action_id
      and c.chunk_index = expected.chunk_index
    where c.chunk_index is null
  ) then
    raise exception 'Bulk action has a missing chunk';
  end if;

  select coalesce(jsonb_agg(item.value order by c.chunk_index, item.ordinality), '[]'::jsonb)
  into assembled_ops
  from public.board_import_chunks c
  cross join lateral jsonb_array_elements(c.ops) with ordinality as item(value, ordinality)
  where c.board_id = p_id
    and c.import_id = p_import_id
    and c.action_id = p_action_id
    and c.chunk_index >= 0
    and c.chunk_index < p_chunk_count;

  result := public.apply_board_action_v5(
    p_id,
    p_key_hash,
    p_action_id,
    p_client_id,
    assembled_ops,
    p_background,
    p_client_revision
  );

  if result is not null then
    delete from public.board_import_chunks
    where board_id = p_id and import_id = p_import_id;
  end if;

  return result;
end;
$$;

revoke all on function public.upload_board_import_chunk_v6(text, text, text, integer, text, text, jsonb) from public;
revoke all on function public.commit_board_import_v6(text, text, text, integer, text, text, text, bigint) from public;
grant execute on function public.upload_board_import_chunk_v6(text, text, text, integer, text, text, jsonb) to anon, authenticated;
grant execute on function public.commit_board_import_v6(text, text, text, integer, text, text, text, bigint) to anon, authenticated;

select 'Alex Board 0.9.6 operation journal and bulk copy upgrade installed' as result;
