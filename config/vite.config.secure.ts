import { defineConfig } from "vite";

export default defineConfig({
  build: {
    // Source maps facilitam reconstrução do código-fonte original.
    // Em produção pública, deixar desativado.
    sourcemap: false
  },

  // Nunca configure envPrefix como "".
  // Tudo com prefixo VITE_ será público.
  envPrefix: "VITE_PUBLIC_"
});

/**
 * Regra:
 *
 * VITE_PUBLIC_* = PUBLICAMENTE VISÍVEL NO BROWSER.
 *
 * Nunca:
 *
 * VITE_PUBLIC_SUPABASE_SECRET=...
 * VITE_PUBLIC_SERVICE_ROLE=...
 * VITE_PUBLIC_DATABASE_PASSWORD=...
 */
