import { createClient } from 'npm:@supabase/supabase-js@2.110.8';

const PAGE_SIZE = 100;
const REMOVE_BATCH = 100;

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

Deno.serve(async (request: Request) => {
  if (request.method !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });

  const cleanupToken = request.headers.get('x-board-cleanup-token')?.trim();
  if (!cleanupToken) return jsonResponse(401, { error: 'Missing cleanup token' });

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse(500, { error: 'Cleanup runtime is not configured' });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: cleanupData, error: cleanupError } = await supabase.rpc(
    'run_board_capacity_cleanup_v1',
    {
      p_cleanup_token: cleanupToken,
      p_capacity_override: null,
      p_target_bytes: 209715200,
      p_dry_run: false,
    },
  );

  if (cleanupError) {
    const status = cleanupError.code === '42501' ? 403 : 500;
    return jsonResponse(status, { error: cleanupError.message, code: cleanupError.code ?? null });
  }

  const runId = Number(cleanupData?.runId ?? 0);
  const deletedBoardIds = Array.isArray(cleanupData?.deletedBoardIds)
    ? cleanupData.deletedBoardIds.map(String)
    : [];

  let removedObjects = 0;
  let removedBytes = 0;
  let storageErrorText = '';

  const removePrefix = async (boardId: string) => {
    for (;;) {
      const { data: files, error: listError } = await supabase.storage
        .from('board-assets').list(boardId, {
          limit: PAGE_SIZE,
          offset: 0,
          sortBy: { column: 'name', order: 'asc' },
        });
      if (listError) throw listError;
      if (!files?.length) return;

      const paths = files
        .filter((entry) => entry?.name && entry.metadata)
        .slice(0, REMOVE_BATCH)
        .map((entry) => `${boardId}/${entry.name}`);
      if (!paths.length) return;

      const sizeByPath = new Map(
        files.map((entry) => [
          `${boardId}/${entry.name}`,
          Number(entry?.metadata?.size ?? 0),
        ]),
      );
      const { error: removeError } = await supabase.storage.from('board-assets').remove(paths);
      if (removeError) throw removeError;
      removedObjects += paths.length;
      removedBytes += paths.reduce((sum, path) => sum + Math.max(0, sizeByPath.get(path) ?? 0), 0);
    }
  };

  try {
    for (const boardId of deletedBoardIds) {
      // eslint-disable-next-line no-await-in-loop
      await removePrefix(boardId);
    }

    const existingBoardIds = new Set<string>();
    for (let from = 0; ; from += 1000) {
      const { data: boards, error: boardsError } = await supabase
        .from('boards')
        .select('id')
        .range(from, from + 999);
      if (boardsError) throw boardsError;
      (boards ?? []).forEach((board) => existingBoardIds.add(String(board.id)));
      if ((boards ?? []).length < 1000) break;
    }

    for (let offset = 0; ; offset += PAGE_SIZE) {
      const { data: roots, error: rootsError } = await supabase.storage
        .from('board-assets').list('', {
          limit: PAGE_SIZE,
          offset,
          sortBy: { column: 'name', order: 'asc' },
        });
      if (rootsError) throw rootsError;
      if (!roots?.length) break;

      const orphanPrefixes = roots
        .filter((entry) => entry?.name && !entry.metadata)
        .map((entry) => String(entry.name))
        .filter((boardId) => !existingBoardIds.has(boardId));

      for (const boardId of orphanPrefixes) {
        // eslint-disable-next-line no-await-in-loop
        await removePrefix(boardId);
      }
      if (roots.length < PAGE_SIZE) break;
    }
  } catch (error) {
    storageErrorText = error instanceof Error ? error.message : String(error);
  }

  if (runId > 0) {
    const { error: finishError } = await supabase.rpc('finish_board_capacity_cleanup_v1', {
      p_run_id: runId,
      p_storage_objects: removedObjects,
      p_storage_bytes: removedBytes,
      p_storage_error: storageErrorText || null,
    });
    if (finishError && !storageErrorText) storageErrorText = finishError.message;
  }

  if (storageErrorText) {
    return jsonResponse(500, {
      cleanup: cleanupData,
      storageObjectsDeleted: removedObjects,
      storageBytesDeleted: removedBytes,
      storageError: storageErrorText,
    });
  }

  return jsonResponse(200, {
    cleanup: cleanupData,
    storageObjectsDeleted: removedObjects,
    storageBytesDeleted: removedBytes,
  });
});
