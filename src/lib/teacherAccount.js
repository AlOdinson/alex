import { sha256 } from './ids.js';
import { isSupabaseConfigured, supabase } from './supabase.js';

function requireSupabase() {
  if (!isSupabaseConfigured || !supabase) {
    throw new Error('Supabase не настроен в этой сборке доски.');
  }
}

function authRedirectUrl() {
  return new URL(import.meta.env.BASE_URL, window.location.origin).toString();
}

function normalizedEmail(email) {
  const normalized = String(email ?? '').trim().toLowerCase();
  if (!normalized || !normalized.includes('@')) throw new Error('Введите корректную почту.');
  return normalized;
}

function validatedPassword(password) {
  const value = String(password ?? '');
  if (value.length < 8) throw new Error('Пароль должен содержать не менее 8 символов.');
  if (value.length > 128) throw new Error('Пароль слишком длинный.');
  return value;
}

export async function getTeacherSession() {
  requireSupabase();
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data.session ?? null;
}

export function onTeacherAuthChange(callback) {
  if (!isSupabaseConfigured || !supabase) return () => undefined;
  const { data } = supabase.auth.onAuthStateChange((event, session) => callback(session, event));
  return () => data.subscription.unsubscribe();
}

export async function signUpTeacherWithPassword(email, password) {
  requireSupabase();
  const { data, error } = await supabase.auth.signUp({
    email: normalizedEmail(email),
    password: validatedPassword(password),
    options: { emailRedirectTo: authRedirectUrl() },
  });
  if (error) throw error;
  return data;
}

export async function signInTeacherWithPassword(email, password) {
  requireSupabase();
  const { data, error } = await supabase.auth.signInWithPassword({
    email: normalizedEmail(email),
    password: String(password ?? ''),
  });
  if (error) throw error;
  return data;
}

export async function requestTeacherPasswordReset(email) {
  requireSupabase();
  const { error } = await supabase.auth.resetPasswordForEmail(normalizedEmail(email), {
    redirectTo: authRedirectUrl(),
  });
  if (error) throw error;
}

export async function updateTeacherPassword(password) {
  requireSupabase();
  const { data, error } = await supabase.auth.updateUser({
    password: validatedPassword(password),
  });
  if (error) throw error;
  return data;
}

export async function sendTeacherMagicLink(email) {
  requireSupabase();
  const { error } = await supabase.auth.signInWithOtp({
    email: normalizedEmail(email),
    options: {
      emailRedirectTo: authRedirectUrl(),
      shouldCreateUser: true,
    },
  });
  if (error) throw error;
}

export async function signOutTeacher() {
  requireSupabase();
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export async function ensureTeacherAccount() {
  requireSupabase();
  const { data, error } = await supabase.rpc('ensure_teacher_account_v9');
  if (error) throw error;
  return data;
}

export async function claimOwnedBoardsForAccount(entries) {
  requireSupabase();
  const source = Array.isArray(entries) ? entries : [];
  let claimed = 0;
  for (let offset = 0; offset < source.length; offset += 50) {
    const chunk = source.slice(offset, offset + 50);
    // Hashing owner keys in the browser keeps the raw secrets out of this account RPC.
    // eslint-disable-next-line no-await-in-loop
    const payload = await Promise.all(chunk.map(async (entry) => ({
      boardId: String(entry.boardId ?? ''),
      ownerKeyHash: await sha256(String(entry.ownerKey ?? '')),
    })));
    // eslint-disable-next-line no-await-in-loop
    const { data, error } = await supabase.rpc('claim_owned_boards_for_account_v9', {
      p_entries: payload,
    });
    if (error) throw error;
    claimed += Number(data ?? 0);
  }
  if (!source.length) await ensureTeacherAccount();
  return claimed;
}

export async function claimTeacherMacAgent(pairingCode) {
  requireSupabase();
  const normalized = String(pairingCode ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (normalized.length !== 8) throw new Error('Код Mac должен состоять из 8 символов.');
  const { data, error } = await supabase.rpc('claim_teacher_mac_agent_v9', {
    p_pairing_code_hash: await sha256(normalized),
  });
  if (error) {
    if (String(error.message ?? '').includes('pairing_code_not_found')) {
      throw new Error('Код не найден или устарел. Перезапустите Alex Browser Server и повторите.');
    }
    throw error;
  }
  return data;
}

export async function getTeacherMacStatus() {
  requireSupabase();
  const { data, error } = await supabase.rpc('get_teacher_account_mac_status_v9');
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

export async function revokeTeacherMacAgent(agentId) {
  requireSupabase();
  const { data, error } = await supabase.rpc('revoke_teacher_mac_agent_v9', {
    p_agent_id: agentId,
  });
  if (error) throw error;
  return Boolean(data);
}

export async function revokeTeacherMacAgentByToken(agentTokenHash) {
  requireSupabase();
  const tokenHash = String(agentTokenHash ?? '').trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(tokenHash)) throw new Error('Повреждён локальный токен Mac.');
  const { data, error } = await supabase.rpc('revoke_teacher_mac_agent_by_token_v10', {
    p_token_hash: tokenHash,
  });
  if (error) throw error;
  return Boolean(data);
}

export async function getBoardTeacherAccount(boardId, boardKey) {
  if (!isSupabaseConfigured || !supabase || !boardId || !boardKey) return null;
  const { data, error } = await supabase.rpc('get_board_teacher_account_v9', {
    p_id: boardId,
    p_key_hash: await sha256(boardKey),
  });
  if (error) {
    if (error.code === 'PGRST202') return null;
    throw error;
  }
  return data?.realtimeKey ? data : null;
}

export async function registerTeacherMacAgent(agentToken, pairingCode, name = 'Mac') {
  requireSupabase();
  const [tokenHash, pairingCodeHash] = await Promise.all([
    sha256(String(agentToken ?? '')),
    sha256(String(pairingCode ?? '').toUpperCase()),
  ]);
  const { data, error } = await supabase.rpc('register_teacher_mac_agent_v9', {
    p_token_hash: tokenHash,
    p_pairing_code_hash: pairingCodeHash,
    p_name: name,
  });
  if (error) throw error;
  return { ...data, tokenHash };
}

export async function authorizeTeacherMacRequest(agentTokenHash, boardId, boardKeyHash) {
  requireSupabase();
  const { data, error } = await supabase.rpc('authorize_teacher_mac_request_v9', {
    p_token_hash: agentTokenHash,
    p_board_id: boardId,
    p_board_key_hash: boardKeyHash,
  });
  if (error) throw error;
  return data ?? null;
}
