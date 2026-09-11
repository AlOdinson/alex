import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../supabase/functions/ably-browser-token/index.ts', import.meta.url), 'utf8');

assert.match(source, /roomKey/);
assert.match(source, /board:\$\{boardId\}:\$\{roomKey\}/);
assert.match(source, /ABLY_API_KEY/);
assert.doesNotMatch(source, /\.rpc\s*\(/);
assert.doesNotMatch(source, /from\s*\(/);
assert.doesNotMatch(source, /get_board_access/i);
assert.doesNotMatch(source, /SUPABASE_DB_URL/);

console.log('stateless browser Ably token endpoint: ok');
