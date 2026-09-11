import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('../src/lib/realtime.js', import.meta.url), 'utf8');

test('public realtime delegates to browser authority and contains no Supabase Realtime durable fallback', () => {
  assert.match(source, /browserAuthorityRealtime\.js/);
  assert.doesNotMatch(source, /supabase\.channel\s*\(/);
  assert.doesNotMatch(source, /postgres_changes/);
  assert.doesNotMatch(source, /applyBoardActionBatch/);
});
