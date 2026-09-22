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

test("migration de pagamentos é aditiva e protege o aceite de Pix não aprovado", () => {
  const file = readdirSync(migrationsRoot).find((name) => name.endsWith("_add_direct_pix_and_payment_status.sql"));
  assert.ok(file);
  const migration = readFileSync(new URL(`../supabase/migrations/${file}`, import.meta.url), "utf8");
  assert.match(migration, /add column if not exists payment_status/i);
  assert.match(migration, /add column if not exists payment_provider/i);
  assert.match(migration, /payment_confirmed_by uuid references auth\.users/i);
  assert.match(migration, /Confirme o recebimento do Pix antes de aceitar o pedido/i);
  assert.match(migration, /new\.payment_status\s*<>\s*'approved'/i);
  assert.match(migration, /payment_method\s*=\s*'pix'\s+and\s+status\s*=\s*'pending'[\s\S]*?'pending'::public\.payment_status/i);
  assert.match(migration, /payment_method\s*=\s*'pix'\s+and\s+status\s*=\s*'cancelled'[\s\S]*?'cancelled'::public\.payment_status/i);
  assert.match(migration, /when\s+payment_method\s*=\s*'pix'\s+then\s+'approved'::public\.payment_status/i);
  assert.doesNotMatch(migration, /drop\s+table|truncate\s+table/i);
});

test("migration de sessões públicas mantém tokens protegidos e isolamento multi-loja", () => {
  const files = readdirSync(migrationsRoot)
    .filter((name) => name.endsWith("_add_public_order_sessions.sql"));
  assert.equal(files.length, 1);
  const migration = readFileSync(
    new URL(`../supabase/migrations/${files[0]}`, import.meta.url),
    "utf8"
  );

  assert.match(migration, /^\s*(?:--[^\n]*\n)*\s*begin\s*;/i);
  assert.match(migration, /commit\s*;\s*$/i);
  assert.match(migration, /create table public\.public_order_sessions/i);
  assert.match(migration, /token_hash text not null unique/i);
  assert.match(migration, /token_hash\s*~\s*'\^\[0-9a-f\]\{64\}\$'/i);
  assert.match(migration, /create index public_order_sessions_expires_at_idx[\s\S]*?\(expires_at\)/i);
  assert.match(migration, /primary key \(session_id, order_id\)/i);
  assert.match(migration, /foreign key \(session_id\)[\s\S]*?on delete cascade/i);
  assert.match(migration, /foreign key \(order_id, store_id\)[\s\S]*?references public\.orders\(id, store_id\)[\s\S]*?on delete cascade/i);
  assert.match(migration, /public_order_session_orders_session_store_created_idx[\s\S]*?\(session_id, store_id, created_at desc\)/i);
  assert.match(migration, /public_order_session_orders_order_store_idx[\s\S]*?\(order_id, store_id\)/i);

  for (const table of ["public_order_sessions", "public_order_session_orders"]) {
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`, "i"));
    assert.match(migration, new RegExp(`revoke all on table public\\.${table} from public, anon, authenticated`, "i"));
  }
  assert.match(migration, /grant select, insert, update on table public\.public_order_sessions to service_role/i);
  assert.match(migration, /grant select, insert on table public\.public_order_session_orders to service_role/i);
  for (const table of ["public_order_sessions", "public_order_session_orders"]) {
    const revoke = new RegExp(`revoke all on table public\\.${table} from service_role`, "i");
    const grant = new RegExp(`grant [^;]+ on table public\\.${table} to service_role`, "i");
    assert.match(migration, revoke);
    assert.ok(migration.search(revoke) < migration.search(grant));
  }
  assert.doesNotMatch(migration, /grant\s+[^;]*(?:delete|truncate)[^;]*\s+to\s+service_role/i);
  assert.doesNotMatch(migration, /grant\s+[^;]+\s+to\s+(?:anon|authenticated)/i);
  assert.doesNotMatch(migration, /create\s+policy/i);
});

function dailyInventoryMigration() {
  const files = readdirSync(migrationsRoot)
    .filter((name) => name.endsWith("_add_daily_product_inventory.sql"));
  assert.equal(files.length, 1);
  return readFileSync(new URL(`../supabase/migrations/${files[0]}`, import.meta.url), "utf8");
}

test("migration de estoque diário é transacional, multi-loja e usa limites seguros", () => {
  const migration = dailyInventoryMigration();
  assert.match(migration, /^\s*(?:--[^\n]*\n)*\s*begin\s*;/i);
  assert.match(migration, /commit\s*;\s*$/i);
  for (const table of [
    "product_inventory_settings",
    "product_inventory_daily",
    "product_inventory_events"
  ]) {
    assert.match(migration, new RegExp(`create table public\\.${table}`, "i"));
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`, "i"));
    assert.match(migration, new RegExp(`revoke all on table public\\.${table} from public, anon, authenticated`, "i"));
    assert.match(migration, new RegExp(`revoke all on table public\\.${table} from service_role`, "i"));
  }
  assert.match(migration, /primary key \(store_id, product_id\)/i);
  assert.match(migration, /primary key \(store_id, product_id, inventory_date\)/i);
  assert.match(migration, /foreign key \(product_id, store_id\)[\s\S]*?references public\.products\(id, store_id\)/i);
  assert.match(migration, /foreign key \(order_id, store_id\)[\s\S]*?references public\.orders\(id, store_id\)/i);
  assert.match(migration, /prepared_quantity between 0 and 100000/i);
  assert.match(migration, /quantity_remaining between 0 and 100000/i);
  assert.match(migration, /product_inventory_events_product_date_idx[\s\S]*?\(store_id, product_id, inventory_date, created_at desc\)/i);
  assert.match(migration, /product_inventory_events_type_created_idx[\s\S]*?\(store_id, event_type, created_at desc\)/i);
  assert.match(migration, /product_inventory_events_order_idx[\s\S]*?\(order_id, created_at\)/i);
  assert.doesNotMatch(migration, /create\s+policy/i);
});

test("estoque diário concede somente privilégios mínimos e protege funções", () => {
  const migration = dailyInventoryMigration();
  assert.match(migration, /grant select, insert, update on table public\.product_inventory_settings to service_role/i);
  assert.match(migration, /grant select, insert, update on table public\.product_inventory_daily to service_role/i);
  assert.match(migration, /grant select, insert on table public\.product_inventory_events to service_role/i);
  assert.doesNotMatch(migration, /grant\s+[^;]*(?:delete|truncate)[^;]*\s+to\s+service_role/i);
  assert.doesNotMatch(migration, /grant\s+[^;]+\s+to\s+(?:anon|authenticated)/i);
  for (const name of [
    "consume_daily_product_inventory",
    "restore_daily_product_inventory_on_cancel",
    "set_daily_product_inventory",
    "adjust_daily_product_inventory"
  ]) {
    assert.match(migration, new RegExp(`function public\\.${name}\\([\\s\\S]*?security invoker[\\s\\S]*?set search_path = pg_catalog, public`, "i"));
    assert.match(migration, new RegExp(`revoke all on function public\\.${name}\\([\\s\\S]*?from public, anon, authenticated, service_role`, "i"));
  }
  assert.match(migration, /grant execute on function public\.set_daily_product_inventory[\s\S]*?to service_role/i);
  assert.match(migration, /grant execute on function public\.adjust_daily_product_inventory[\s\S]*?to service_role/i);
  assert.doesNotMatch(migration, /grant execute on function public\.(?:consume|restore)_daily_product_inventory/i);
});

test("checkout consome estoque agregado com lock determinístico na transação dos itens", () => {
  const migration = dailyInventoryMigration();
  assert.match(migration, /after insert on public\.order_items[\s\S]*?referencing new table as inserted_order_items[\s\S]*?for each statement/i);
  assert.match(migration, /sum\(inserted\.quantity\)::integer as requested_quantity/i);
  assert.match(migration, /order_row\.fulfillment_type <> 'scheduled'/i);
  assert.match(migration, /order by order_row\.store_id, inserted\.product_id, order_row\.id/i);
  assert.match(migration, /stock_mode_value := coalesce\(stock_mode_value, 'always'\)/i);
  assert.match(migration, /stock_mode_value = 'manual'[\s\S]*?not daily_row\.available[\s\S]*?ATREVIDA_STOCK_CONFLICT/i);
  assert.match(migration, /for update;[\s\S]*?daily_row\.quantity_remaining < requested\.requested_quantity[\s\S]*?ATREVIDA_STOCK_CONFLICT/i);
  assert.match(migration, /quantity_remaining = remaining_after[\s\S]*?'sale'[\s\S]*?-requested\.requested_quantity/i);
  assert.match(migration, /daily_row\.quantity_remaining > 0 and remaining_after = 0[\s\S]*?'sold_out'/i);
  assert.match(migration, /statement_timestamp\(\) at time zone requested\.timezone/i);
});

test("cancelamento devolve uma vez ao dia original e ajustes administrativos são atômicos", () => {
  const migration = dailyInventoryMigration();
  assert.match(migration, /new\.status <> 'cancelled'[\s\S]*?old\.status not in \('pending', 'confirmed'\)/i);
  assert.match(migration, /event\.inventory_date[\s\S]*?event\.event_type = 'sale'/i);
  assert.match(migration, /daily\.inventory_date = sale_row\.inventory_date[\s\S]*?for update/i);
  assert.match(migration, /product_inventory_events_cancel_return_once_idx[\s\S]*?event_type = 'cancel_return'/i);
  assert.match(migration, /on conflict \(order_id, product_id, inventory_date, event_type\)[\s\S]*?do nothing/i);
  assert.match(migration, /old\.status not in \('pending', 'confirmed'\)/i);
  assert.match(migration, /adjust_daily_product_inventory[\s\S]*?for update[\s\S]*?remaining_after := daily_row\.quantity_remaining \+ p_quantity_delta/i);
  assert.match(migration, /remaining_after not between 0 and 100000/i);
  assert.match(migration, /daily_row\.quantity_remaining > 0 and remaining_after = 0[\s\S]*?'sold_out'/i);
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
