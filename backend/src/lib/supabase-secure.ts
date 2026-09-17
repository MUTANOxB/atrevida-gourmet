import { createClient } from "@supabase/supabase-js";
import { secureEnv } from "../config/env.secure.js";

/**
 * ÚNICO cliente privilegiado.
 *
 * Este arquivo só pode ser importado por código server-side.
 */
export const supabaseServer = createClient(
  secureEnv.SUPABASE_URL,
  secureEnv.SUPABASE_SECRET_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
);
