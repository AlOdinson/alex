import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const repository = await readFile(new URL('../src/lib/boardRepository.js', import.meta.url), 'utf8');
const duplicateSql = await readFile(new URL('../supabase/duplicate_board_v8.sql', import.meta.url), 'utf8').catch(() => '');
const cleanupSql = await readFile(new URL('../supabase/board_capacity_cleanup_v1.sql', import.meta.url), 'utf8').catch(() => '');

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

console.log('Board capacity cleanup static safety tests passed.');
