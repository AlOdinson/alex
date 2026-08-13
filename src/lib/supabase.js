import { createClient } from '@supabase/supabase-js';

const environment = import.meta.env ?? {};
const url = environment.VITE_SUPABASE_URL;
const publishableKey = environment.VITE_SUPABASE_PUBLISHABLE_KEY;

export const isSupabaseConfigured = Boolean(url && publishableKey);

export const supabase = isSupabaseConfigured
  ? createClient(url, publishableKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    })
  : null;
