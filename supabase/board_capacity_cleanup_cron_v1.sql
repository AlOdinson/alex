-- Alex Board automatic capacity cleanup cron v1
-- 20:00 UTC = 04:00 UTC+8. Vacuum follows at 20:20 UTC.

begin;

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

do $unschedule$
declare
  v_job_id bigint;
begin
  for v_job_id in
    select jobid from cron.job
    where jobname in ('alex-board-capacity-cleanup-v1','alex-board-capacity-vacuum-v1')
  loop
    perform cron.unschedule(v_job_id);
  end loop;
end
$unschedule$;

select cron.schedule(
  'alex-board-capacity-cleanup-v1',
  '0 20 * * *',
  $cron$
    select net.http_post(
      url := (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'board_cleanup_project_url'
        limit 1
      ) || '/functions/v1/board-capacity-cleanup',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-board-cleanup-token', (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'board_cleanup_token'
          limit 1
        )
      ),
      body := '{}'::jsonb
    );
  $cron$
);

select cron.schedule(
  'alex-board-capacity-vacuum-v1',
  '20 20 * * *',
  $cron$
    VACUUM (ANALYZE)
      public.boards,
      public.board_actions,
      public.board_objects,
      public.board_snapshots,
      public.board_tombstones,
      public.board_import_chunks,
      public.board_actions_v8,
      public.board_action_heads_v8,
      public.board_import_chunks_v8,
      public.board_object_states_v8,
      public.board_object_state_heads_v8,
      public.board_object_locks_v8,
      public.board_action_noop_outcomes_v8,
      public.board_cleanup_log;
  $cron$
);

create or replace function public.prune_board_capacity_cron_history_v1()
returns void
language sql
security definer
set search_path = public, cron, pg_temp
as $$
  delete from cron.job_run_details d
  where d.start_time < now() - interval '90 days'
    and d.jobid in (
      select j.jobid
      from cron.job j
      where j.jobname in ('alex-board-capacity-cleanup-v1','alex-board-capacity-vacuum-v1')
    );
$$;

revoke all on function public.prune_board_capacity_cron_history_v1()
  from public, anon, authenticated;

commit;
