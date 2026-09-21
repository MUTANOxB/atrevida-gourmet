import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const migrationsRoot = fileURLToPath(new URL("../supabase/migrations/", import.meta.url));
const seedPath = new URL("../supabase/seed.sql", import.meta.url);

test("migrations 001 a 007 permanecem presentes", () => {
  const migrations = readdirSync(migrationsRoot)
    .filter((file) => /^00[1-7]_.*\.sql$/.test(file))
    .sort();
  assert.equal(migrations.length, 7);
  assert.deepEqual(migrations.map((file) => file.slice(0, 3)), ["001", "002", "003", "004", "005", "006", "007"]);
});

test("migration 006 não tenta alterar diretamente storage.objects", () => {
  const migration = readFileSync(
    new URL("../supabase/migrations/006_database_security_completion.sql", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(migration, /alter\s+table\s+(?:storage\.)?objects\s+enable\s+row\s+level\s+security/i);
});

test("migration 007 fixa o search_path de set_updated_at", () => {
  const migration = readFileSync(
    new URL("../supabase/migrations/007_fix_set_updated_at_search_path.sql", import.meta.url),
    "utf8"
  );
  assert.match(migration, /alter\s+function\s+public\.set_updated_at\(\)/i);
  assert.match(migration, /set\s+search_path\s*=\s*public\s*,\s*pg_temp/i);
});

test("seed comercial mantém somente as categorias confirmadas da Atrevida", () => {
  const seed = readFileSync(seedPath, "utf8");
  const categoryBlock = seed.match(
    /seed_categories\(name, slug, sort_order\) as \(\s*values([\s\S]*?)\)\s*insert into public\.categories/i
  )?.[1] ?? "";

  assert.match(categoryBlock, /\('Salgados', 'salgados', 0\)/);
  assert.match(categoryBlock, /\('Crepes', 'crepes', 10\)/);
  assert.match(categoryBlock, /\('Doces e Sobremesas', 'doces-e-sobremesas', 20\)/);
  assert.match(categoryBlock, /\('Bolos', 'bolos', 30\)/);
  assert.match(categoryBlock, /\('Bebidas', 'bebidas', 40\)/);
  assert.equal([...categoryBlock.matchAll(/\('[^']+', '[^']+', \d+\)/g)].length, 5);
  assert.doesNotMatch(seed, /Páscoa|Sazonais|Combos|Encomendas|Kits/i);
  assert.doesNotMatch(seed, /delete\s+from\s+public\.categories/i);
  assert.match(seed, /on conflict \(store_id, slug\) do update[\s\S]*?active = true;/i);
});
