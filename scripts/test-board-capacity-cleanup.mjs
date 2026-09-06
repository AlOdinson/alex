import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const repository = await readFile(new URL('../src/lib/boardRepository.js', import.meta.url), 'utf8');
const duplicateSql = await readFile(new URL('../supabase/duplicate_board_v8.sql', import.meta.url), 'utf8').catch(() => '');

assert.match(repository, /supabase\.rpc\('duplicate_board_v8'/);
assert.doesNotMatch(repository, /supabase\.rpc\('duplicate_board_v7'/);
assert.match(duplicateSql, /create or replace function public\.duplicate_board_v8/);
assert.doesNotMatch(duplicateSql, /\bboard_objects\b/);
assert.match(duplicateSql, /revoke execute on function public\.duplicate_board_v7/);
assert.match(duplicateSql, /board_action_heads_v8/);

console.log('Board capacity cleanup prerequisite tests passed.');
