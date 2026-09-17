import { createClient } from "@supabase/supabase-js";
import { env } from "../config/env.js";

export const supabaseAdmin = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_SECRET_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    },
    global: {
      headers: { "X-Client-Info": "atrevida-backend" }
    }
  }
);

/** Cliente isolado por operação de Auth; nunca persiste sessão no processo. */
export function createSupabaseAuthClient() {
  return createClient(
    env.SUPABASE_URL,
    env.SUPABASE_ANON_KEY ?? env.SUPABASE_SECRET_KEY,
    {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
    }
  );
}
