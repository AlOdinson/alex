import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const sourceUrl = new URL('../src/lib/browserAuthorityStore.js', import.meta.url);
const source = await readFile(sourceUrl, 'utf8');

assert.match(source, /alex-board-authority/);
assert.match(source, /createObjectStore\(BOARD_STORE/);
assert.match(source, /createObjectStore\(COMMIT_STORE/);
assert.match(source, /createObjectStore\(ASSET_STORE/);
assert.match(source, /export async function createAuthorityBoard/);
assert.match(source, /export async function persistAuthorityCommit/);
assert.match(source, /export async function getAuthorityCommitsAfter/);
assert.match(source, /export async function saveAuthoritySnapshot/);
assert.doesNotMatch(source, /supabase/i);

console.log('browser authority store structure: ok');
