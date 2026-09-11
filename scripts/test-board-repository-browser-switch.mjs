import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('../src/lib/boardRepository.js', import.meta.url), 'utf8');

test('public board repository delegates durable board state to browser authority instead of Supabase RPCs', () => {
  assert.match(source, /browserBoardRepositoryCompat\.js/);
  assert.doesNotMatch(source, /from ['"]\.\/supabase\.js['"]/);
  assert.doesNotMatch(source, /supabase\.rpc\s*\(/);
});
