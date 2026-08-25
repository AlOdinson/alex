import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const base = new URL('../', import.meta.url);
const supabaseClient = await readFile(new URL('src/lib/supabase.js', base), 'utf8');
const account = await readFile(new URL('src/lib/teacherAccount.js', base), 'utf8');
const screenShare = await readFile(new URL('src/components/ScreenShare.jsx', base), 'utf8');
const macHost = await readFile(new URL('src/components/MacBrowserHost.jsx', base), 'utf8');
const migration = await readFile(new URL('supabase/teacher_account_mac_v9.sql', base), 'utf8');

assert.match(supabaseClient, /persistSession: true/);
assert.match(supabaseClient, /autoRefreshToken: true/);
assert.match(supabaseClient, /detectSessionInUrl: true/);
assert.match(account, /signInWithOtp/);
assert.match(account, /claim_owned_boards_for_account_v9/);
assert.match(account, /authorize_teacher_mac_request_v9/);
assert.match(screenShare, /teacher-account:\$\{teacherAccountKey\}/);
assert.match(screenShare, /screen-share-v2:\$\{boardId\}:\$\{boardRealtimeKey\}/);
assert.match(macHost, /account-browser-start/);
assert.match(macHost, /forceSupabase: true/);
assert.match(
  macHost,
  /if \(!accountMode && permission !== 'owner'\)/,
  'account mode must reach the token-based pairing flow without a board owner key',
);
assert.match(migration, /add column if not exists owner_user_id uuid references auth\.users/);
assert.match(migration, /revoke all on public\.teacher_accounts_v9 from anon, authenticated/);
assert.match(migration, /revoke execute on function public\.claim_teacher_mac_agent_v9\(text\) from anon/);

console.log('Teacher email account and persistent Mac pairing tests passed.');
