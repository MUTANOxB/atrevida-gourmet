\set ON_ERROR_STOP on

do $$
declare
  table_name text;
  protected_tables text[] := array[
    'stores', 'store_members', 'categories', 'products',
    'product_option_groups', 'product_option_values', 'delivery_zones',
    'orders', 'order_items', 'idempotency_keys', 'store_hours',
    'store_schedule_exceptions', 'store_payment_methods', 'product_images',
    'order_status_history', 'admin_audit_log'
  ];
begin
  foreach table_name in array protected_tables loop
    if not exists (
      select 1
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname = table_name
        and c.relkind = 'r'
    ) then
      raise exception 'required table missing: public.%', table_name;
    end if;

    if not exists (
      select 1
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname = table_name
        and c.relrowsecurity
    ) then
      raise exception 'RLS disabled: public.%', table_name;
    end if;
  end loop;
end
$$;

do $$
declare
  role_name text;
  table_name text;
begin
  foreach role_name in array array['anon', 'authenticated'] loop
    foreach table_name in array array[
      'store_members', 'orders', 'order_items', 'idempotency_keys',
      'admin_audit_log', 'product_images'
    ] loop
      if has_table_privilege(role_name, format('public.%I', table_name), 'SELECT')
         or has_table_privilege(role_name, format('public.%I', table_name), 'INSERT')
         or has_table_privilege(role_name, format('public.%I', table_name), 'UPDATE')
         or has_table_privilege(role_name, format('public.%I', table_name), 'DELETE') then
        raise exception 'unexpected grant for % on public.%', role_name, table_name;
      end if;
    end loop;
  end loop;
end
$$;

do $$
begin
  if has_function_privilege('anon', 'public.create_order_with_items(jsonb,jsonb)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.create_order_with_items(jsonb,jsonb)', 'EXECUTE') then
    raise exception 'atomic checkout RPC is executable by a browser role';
  end if;

  if has_function_privilege('anon', 'public.store_is_open_at(uuid,timestamptz)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.store_is_open_at(uuid,timestamptz)', 'EXECUTE') then
    raise exception 'schedule RPC is executable by a browser role';
  end if;
end
$$;

do $$
begin
  if exists (
    select 1
    from pg_constraint constraint_row
    join pg_class table_row on table_row.oid = constraint_row.conrelid
    join pg_namespace namespace_row on namespace_row.oid = table_row.relnamespace
    where namespace_row.nspname = 'public'
      and not constraint_row.convalidated
  ) then
    raise exception 'public schema contains unvalidated constraints';
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'orders'
  ) then
    raise exception 'orders is missing from supabase_realtime publication';
  end if;
end
$$;

do $$
begin
  if to_regclass('storage.buckets') is null then
    raise exception 'Supabase Storage schema is unavailable';
  end if;
  if not exists (
    select 1
    from storage.buckets
    where id = 'product-images'
      and public
      and file_size_limit = 5242880
      and allowed_mime_types = array[
        'image/jpeg', 'image/png', 'image/webp', 'image/avif'
      ]::text[]
  ) then
    raise exception 'product-images bucket is missing or incorrectly configured';
  end if;
end
$$;

select 'remote security assertions passed' as result;
