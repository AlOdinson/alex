-- Alex Board board-capacity cleanup v1 hotfix.
-- Supabase rejects DELETE statements without a WHERE clause. Patch only the five
-- intentional full legacy-table cleanup statements; all current v8 deletion logic is unchanged.

begin;

do $hotfix$
declare
  v_definition text;
  v_expected integer := 0;
begin
  select pg_get_functiondef(
    'public.run_board_capacity_cleanup_v1(text,bigint,bigint,boolean)'::regprocedure
  ) into v_definition;

  if v_definition is null then
    raise exception 'run_board_capacity_cleanup_v1 is not installed' using errcode = 'P0001';
  end if;

  if position('delete from public.board_actions;' in v_definition) > 0 then
    v_definition := replace(
      v_definition,
      'delete from public.board_actions;',
      'delete from public.board_actions where true;'
    );
    v_expected := v_expected + 1;
  end if;
  if position('delete from public.board_objects;' in v_definition) > 0 then
    v_definition := replace(
      v_definition,
      'delete from public.board_objects;',
      'delete from public.board_objects where true;'
    );
    v_expected := v_expected + 1;
  end if;
  if position('delete from public.board_snapshots;' in v_definition) > 0 then
    v_definition := replace(
      v_definition,
      'delete from public.board_snapshots;',
      'delete from public.board_snapshots where true;'
    );
    v_expected := v_expected + 1;
  end if;
  if position('delete from public.board_tombstones;' in v_definition) > 0 then
    v_definition := replace(
      v_definition,
      'delete from public.board_tombstones;',
      'delete from public.board_tombstones where true;'
    );
    v_expected := v_expected + 1;
  end if;
  if position('delete from public.board_import_chunks;' in v_definition) > 0 then
    v_definition := replace(
      v_definition,
      'delete from public.board_import_chunks;',
      'delete from public.board_import_chunks where true;'
    );
    v_expected := v_expected + 1;
  end if;

  -- Idempotency: on a repeated migration all five statements are already patched.
  if v_expected not in (0, 5) then
    raise exception 'Unexpected partial safe-delete state: % of 5 legacy deletes need patching', v_expected
      using errcode = 'P0001';
  end if;

  if v_definition like '%delete from public.board_actions;%'
     or v_definition like '%delete from public.board_objects;%'
     or v_definition like '%delete from public.board_snapshots;%'
     or v_definition like '%delete from public.board_tombstones;%'
     or v_definition like '%delete from public.board_import_chunks;%'
  then
    raise exception 'Unsafe unconditional legacy DELETE remains after hotfix'
      using errcode = 'P0001';
  end if;

  execute v_definition;
end
$hotfix$;

commit;
