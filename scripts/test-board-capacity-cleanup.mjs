import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const repository = await readFile(new URL('../src/lib/boardRepository.js', import.meta.url), 'utf8');
const duplicateSql = await readFile(new URL('../supabase/duplicate_board_v8.sql', import.meta.url), 'utf8').catch(() => '');
const cleanupSql = await readFile(new URL('../supabase/board_capacity_cleanup_v1.sql', import.meta.url), 'utf8').catch(() => '');
const cleanupHotfixSql = await readFile(new URL('../supabase/board_capacity_cleanup_v1_safe_delete_hotfix.sql', import.meta.url), 'utf8').catch(() => '');
const edgeFunction = await readFile(new URL('../supabase/functions/board-capacity-cleanup/index.ts', import.meta.url), 'utf8').catch(() => '');
const cronSql = await readFile(new URL('../supabase/board_capacity_cleanup_cron_v1.sql', import.meta.url), 'utf8').catch(() => '');

assert.match(repository, /supabase\.rpc\('duplicate_board_v8'/);
assert.doesNotMatch(repository, /supabase\.rpc\('duplicate_board_v7'/);
assert.match(duplicateSql, /create or replace function public\.duplicate_board_v8/);
assert.doesNotMatch(duplicateSql, /\bboard_objects\b/);
assert.match(duplicateSql, /revoke execute on function public\.duplicate_board_v7/);
assert.match(duplicateSql, /board_action_heads_v8/);

assert.match(cleanupSql, /492830720/);
assert.match(cleanupSql, /209715200/);
assert.match(cleanupSql, /pg_try_advisory_xact_lock/);
assert.match(cleanupSql, /coalesce\(b\.last_lesson_at, b\.updated_at, b\.created_at\)/);
assert.match(cleanupSql, /pgstattuple_approx/);
assert.match(cleanupSql, /interval '24 hours'/);
assert.match(cleanupSql, /interval '30 days'/);
assert.match(cleanupSql, /interval '90 days'/);
assert.match(cleanupSql, /board_cleanup_log/);
assert.match(cleanupSql, /run_board_capacity_cleanup_v1/);
assert.match(cleanupSql, /finish_board_capacity_cleanup_v1/);
assert.doesNotMatch(cleanupSql, /vacuum\s+full/i);
assert.doesNotMatch(cleanupSql, /truncate[\s\S]{0,80}cascade/i);
assert.doesNotMatch(cleanupSql, /delete\s+from\s+auth\./i);
assert.doesNotMatch(cleanupSql, /delete\s+from\s+storage\.objects/i);

for (const table of ['board_actions','board_objects','board_snapshots','board_tombstones','board_import_chunks']) {
  assert.match(cleanupHotfixSql, new RegExp(`delete from public\\.${table} where true`));
}
assert.match(cleanupHotfixSql, /pg_get_functiondef/);

assert.match(edgeFunction, /x-board-cleanup-token/);
assert.match(edgeFunction, /SUPABASE_SERVICE_ROLE_KEY/);
assert.match(edgeFunction, /run_board_capacity_cleanup_v1/);
assert.match(edgeFunction, /finish_board_capacity_cleanup_v1/);
assert.match(edgeFunction, /storage[\s\S]{0,40}\.from\(['"]board-assets['"]\)[\s\S]{0,20}\.list/);
assert.match(edgeFunction, /\.from\(['"]board-assets['"]\)\.remove\(/);
assert.doesNotMatch(edgeFunction, /storage\.objects/);

assert.match(cronSql, /0 20 \* \* \*/);
assert.match(cronSql, /20 20 \* \* \*/);
assert.match(cronSql, /vault\.decrypted_secrets/);
assert.match(cronSql, /net\.http_post/);
assert.match(cronSql, /x-board-cleanup-token/);
assert.match(cronSql, /VACUUM \(ANALYZE\)/i);
assert.doesNotMatch(cronSql, /VACUUM FULL/i);

console.log('Board capacity cleanup static safety tests passed.');
