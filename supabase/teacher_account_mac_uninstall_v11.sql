-- Alex Board 1.35.0
-- Allows the local uninstaller to revoke only its own Mac agent. Possession of
-- the 256-bit token hash is the authorization proof; no account password or
-- Supabase session is stored on the Mac server.

create or replace function public.revoke_teacher_mac_agent_by_token_v10(p_token_hash text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  p_token_hash := trim(coalesce(p_token_hash, ''));
  if p_token_hash !~ '^[A-Za-z0-9_-]{43}$' then return false; end if;

  update public.teacher_mac_agents_v9
  set revoked_at = now(), last_seen_at = now()
  where token_hash = p_token_hash and revoked_at is null;
  return found;
end;
$$;

revoke all on function public.revoke_teacher_mac_agent_by_token_v10(text) from public;
grant execute on function public.revoke_teacher_mac_agent_by_token_v10(text) to anon, authenticated;
