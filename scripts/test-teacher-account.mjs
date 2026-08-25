import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { sha256 } from '../src/lib/ids.js';

const base = new URL('../', import.meta.url);
const supabaseClient = await readFile(new URL('src/lib/supabase.js', base), 'utf8');
const account = await readFile(new URL('src/lib/teacherAccount.js', base), 'utf8');
const screenShare = await readFile(new URL('src/components/ScreenShare.jsx', base), 'utf8');
const macHost = await readFile(new URL('src/components/MacBrowserHost.jsx', base), 'utf8');
const migration = await readFile(new URL('supabase/teacher_account_mac_v9.sql', base), 'utf8');
const hashFix = await readFile(new URL('supabase/teacher_account_mac_hash_v10.sql', base), 'utf8');
const uninstallMigration = await readFile(new URL('supabase/teacher_account_mac_uninstall_v11.sql', base), 'utf8');

assert.match(supabaseClient, /persistSession: true/);
assert.match(supabaseClient, /autoRefreshToken: true/);
assert.match(supabaseClient, /detectSessionInUrl: true/);
assert.match(account, /signInWithOtp/);
assert.match(account, /signUp\(/);
assert.match(account, /signInWithPassword/);
assert.match(account, /resetPasswordForEmail/);
assert.match(account, /updateUser\(\{\s*password:/);
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
const pairingDigest = await sha256('26DB2DE5');
assert.equal(pairingDigest.length, 43);
assert.match(pairingDigest, /^[A-Za-z0-9_-]{43}$/);
assert.match(hashFix, /\^\[A-Za-z0-9_-\]\{43\}\$/);
assert.doesNotMatch(hashFix, /lower\(trim\(coalesce\(p_(?:token|pairing_code|board_key)_hash/);
assert.match(uninstallMigration, /revoke_teacher_mac_agent_by_token_v10/);
assert.match(uninstallMigration, /where token_hash = p_token_hash and revoked_at is null/);
assert.match(macHost, /agent-revoke-result/);

const accountPanel = await readFile(new URL('src/components/TeacherAccountPanel.jsx', base), 'utf8');
assert.match(accountPanel, /downloads\/alex-browser-macos\.zip/);
assert.match(accountPanel, /Старый вход по одноразовой ссылке/);

console.log('Teacher email account and persistent Mac pairing tests passed.');
