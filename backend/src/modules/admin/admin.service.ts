import { HttpError } from "../../lib/errors.js";
import { supabaseAdmin } from "../../lib/supabase.js";
import type { OrderStatus } from "./admin.schemas.js";
import {
  assertManagedProductImage,
  claimManagedProductImage,
  removeManagedProductImage
} from "./product-images.service.js";

type Actor = { storeId: string; userId: string };

function databaseFailure(message: string): never {
  throw new HttpError(503, message);
}

async function audit(
  actor: Actor,
  action: string,
  entityType: string,
  entityId?: string | null,
  metadata: Record<string, unknown> = {}
) {
  const { error } = await supabaseAdmin.from("admin_audit_log").insert({
    store_id: actor.storeId,
    user_id: actor.userId,
    action,
    entity_type: entityType,
    entity_id: entityId ?? null,
    metadata
  });
  if (error) databaseFailure("A alteração ocorreu, mas não foi possível registrar a auditoria.");
}

function categoryDto(row: any) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    active: row.active,
    sortOrder: row.sort_order
  };
}

function productDto(row: any) {
  return {
    id: row.id,
    categoryId: row.category_id,
    name: row.name,
    description: row.description,
    priceCents: row.price_cents,
    imageUrl: row.image_url,
    active: row.active,
    featured: row.featured,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function optionGroupDto(row: any) {
  return {
    id: row.id,
    productId: row.product_id,
    name: row.name,
    required: row.required,
    minSelect: row.min_select,
    maxSelect: row.max_select,
    active: row.active,
    sortOrder: row.sort_order
  };
}

function optionValueDto(row: any) {
  return {
    id: row.id,
    groupId: row.group_id,
    name: row.name,
    priceDeltaCents: row.price_delta_cents,
    active: row.active,
    sortOrder: row.sort_order
  };
}

function zoneDto(row: any) {
  return {
    id: row.id,
    name: row.name,
    feeCents: row.fee_cents,
    minimumOrderCents: row.minimum_order_cents,
    active: row.active
  };
}

function adminOrderDto(row: any) {
  return {
    id: row.id,
    orderNumber: row.order_number,
    status: row.status,
    fulfillmentType: row.fulfillment_type,
    customer: { name: row.customer_name, phone: row.customer_phone },
    delivery: row.delivery_zone_id ? {
      postalCode: row.delivery_postal_code,
      street: row.delivery_street,
      number: row.delivery_number,
      neighborhood: row.delivery_neighborhood,
      complement: row.delivery_complement,
      reference: row.delivery_reference,
      zoneId: row.delivery_zone_id
    } : null,
    paymentMethod: row.payment_method,
    changeForCents: row.change_for_cents,
    subtotalCents: row.subtotal_cents,
    deliveryFeeCents: row.delivery_fee_cents,
    totalCents: row.total_cents,
    note: row.note,
    scheduledFor: row.scheduled_for,
    createdAt: row.created_at,
    acceptedAt: row.accepted_at,
    preparingAt: row.preparing_at,
    readyAt: row.ready_at,
    outForDeliveryAt: row.out_for_delivery_at,
    completedAt: row.completed_at,
    cancelledAt: row.cancelled_at,
    items: (row.order_items ?? []).map((item: any) => ({
      id: item.id,
      name: item.product_name_snapshot,
      unitPriceCents: item.unit_price_cents,
      quantity: item.quantity,
      lineTotalCents: item.line_total_cents,
      note: item.note,
      options: item.options_snapshot
    }))
  };
}

const orderSelect = `
  id, order_number, status, fulfillment_type, customer_name, customer_phone,
  delivery_postal_code, delivery_street, delivery_number, delivery_neighborhood,
  delivery_complement, delivery_reference, delivery_zone_id, scheduled_for,
  payment_method, change_for_cents, subtotal_cents, delivery_fee_cents,
  total_cents, note, created_at, accepted_at, preparing_at, ready_at,
  out_for_delivery_at, completed_at, cancelled_at,
  order_items(id, product_name_snapshot, unit_price_cents, quantity,
    line_total_cents, note, options_snapshot)
`;

export async function listAdminOrders(
  storeId: string,
  query: { status?: OrderStatus; limit: number }
) {
  let request = supabaseAdmin
    .from("orders")
    .select(orderSelect)
    .eq("store_id", storeId)
    .order("created_at", { ascending: false })
    .limit(query.limit);
  if (query.status) request = request.eq("status", query.status);
  const { data, error } = await request;
  if (error) databaseFailure("Falha ao carregar pedidos.");
  return (data ?? []).map(adminOrderDto);
}

export async function getAdminOrder(storeId: string, orderId: string) {
  const { data, error } = await supabaseAdmin
    .from("orders")
    .select(orderSelect)
    .eq("store_id", storeId)
    .eq("id", orderId)
    .maybeSingle();
  if (error) databaseFailure("Falha ao carregar o pedido.");
  return data ? adminOrderDto(data) : null;
}

export function canTransitionOrder(
  from: OrderStatus,
  to: OrderStatus,
  fulfillmentType: "delivery" | "pickup" | "scheduled"
) {
  if (from === to) return true;
  const common: Partial<Record<OrderStatus, OrderStatus[]>> = {
    pending: ["confirmed", "cancelled"],
    confirmed: ["preparing", "cancelled"],
    preparing: ["ready", "cancelled"],
    out_for_delivery: ["completed", "cancelled"]
  };
  if (from === "ready") {
    return fulfillmentType === "delivery"
      ? ["out_for_delivery", "cancelled"].includes(to)
      : ["completed", "cancelled"].includes(to);
  }
  return common[from]?.includes(to) ?? false;
}

export async function updateOrderStatus(
  actor: Actor,
  orderId: string,
  status: OrderStatus,
  reason?: string
) {
  const { data: current, error: currentError } = await supabaseAdmin
    .from("orders")
    .select("id, status, fulfillment_type")
    .eq("id", orderId)
    .eq("store_id", actor.storeId)
    .maybeSingle();
  if (currentError) databaseFailure("Falha ao validar o pedido.");
  if (!current) throw new HttpError(404, "Pedido não encontrado.");
  if (!canTransitionOrder(current.status, status, current.fulfillment_type)) {
    throw new HttpError(409, "Transição de status não permitida.");
  }

  const now = new Date().toISOString();
  const patch: Record<string, unknown> = { status };
  if (status === "confirmed") patch.accepted_at = now;
  if (status === "preparing") patch.preparing_at = now;
  if (status === "ready") patch.ready_at = now;
  if (status === "out_for_delivery") patch.out_for_delivery_at = now;
  if (status === "completed") patch.completed_at = now;
  if (status === "cancelled") {
    patch.cancelled_at = now;
    patch.cancellation_reason = reason?.trim() || null;
  }

  const { data, error } = await supabaseAdmin
    .from("orders")
    .update(patch)
    .eq("id", orderId)
    .eq("store_id", actor.storeId)
    .eq("status", current.status)
    .select(orderSelect)
    .maybeSingle();
  if (error) databaseFailure("Falha ao atualizar pedido.");
  if (!data) throw new HttpError(409, "O pedido foi atualizado por outro usuário.");
  await audit(actor, "order.status_changed", "order", orderId, {
    fromStatus: current.status,
    toStatus: status,
    reason: reason || undefined
  });
  return adminOrderDto(data);
}

async function ensureCategory(storeId: string, categoryId: string) {
  const { data, error } = await supabaseAdmin.from("categories")
    .select("id").eq("store_id", storeId).eq("id", categoryId).maybeSingle();
  if (error) databaseFailure("Falha ao validar categoria.");
  if (!data) throw new HttpError(422, "Categoria inválida.");
}

async function ensureProduct(storeId: string, productId: string) {
  const { data, error } = await supabaseAdmin.from("products")
    .select("id").eq("store_id", storeId).eq("id", productId).maybeSingle();
  if (error) databaseFailure("Falha ao validar produto.");
  if (!data) throw new HttpError(422, "Produto inválido.");
}

async function ensureGroup(storeId: string, groupId: string) {
  const { data, error } = await supabaseAdmin.from("product_option_groups")
    .select("id, product:products!inner(store_id)")
    .eq("id", groupId).eq("product.store_id", storeId).maybeSingle();
  if (error) databaseFailure("Falha ao validar grupo de opções.");
  if (!data) throw new HttpError(422, "Grupo de opções inválido.");
}

export async function listCategories(storeId: string) {
  const { data, error } = await supabaseAdmin.from("categories")
    .select("id, name, slug, active, sort_order")
    .eq("store_id", storeId).order("sort_order");
  if (error) databaseFailure("Falha ao carregar categorias.");
  return (data ?? []).map(categoryDto);
}

export async function createCategory(actor: Actor, input: any) {
  const { data, error } = await supabaseAdmin.from("categories").insert({
    store_id: actor.storeId, name: input.name, slug: input.slug,
    active: input.active, sort_order: input.sortOrder
  }).select("id, name, slug, active, sort_order").single();
  if (error) throw new HttpError(error.code === "23505" ? 409 : 503,
    error.code === "23505" ? "Já existe uma categoria com este slug." : "Falha ao cadastrar categoria.");
  await audit(actor, "category.created", "category", data.id);
  return categoryDto(data);
}

export async function updateCategory(actor: Actor, id: string, input: any) {
  const patch: any = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.slug !== undefined) patch.slug = input.slug;
  if (input.active !== undefined) patch.active = input.active;
  if (input.sortOrder !== undefined) patch.sort_order = input.sortOrder;
  const { data, error } = await supabaseAdmin.from("categories").update(patch)
    .eq("store_id", actor.storeId).eq("id", id)
    .select("id, name, slug, active, sort_order").maybeSingle();
  if (error) throw new HttpError(error.code === "23505" ? 409 : 503,
    error.code === "23505" ? "Já existe uma categoria com este slug." : "Falha ao atualizar categoria.");
  if (!data) throw new HttpError(404, "Categoria não encontrada.");
  await audit(actor, "category.updated", "category", id, { fields: Object.keys(input) });
  return categoryDto(data);
}

export async function deactivateCategory(actor: Actor, id: string) {
  return updateCategory(actor, id, { active: false });
}

export async function listProducts(storeId: string) {
  const { data, error } = await supabaseAdmin.from("products")
    .select("id, category_id, name, description, price_cents, image_url, active, featured, sort_order, created_at, updated_at")
    .eq("store_id", storeId).order("sort_order");
  if (error) databaseFailure("Falha ao carregar produtos.");
  return (data ?? []).map(productDto);
}

export async function createProduct(actor: Actor, input: any) {
  await ensureCategory(actor.storeId, input.categoryId);
  if (input.imageUrl) await assertManagedProductImage(actor.storeId, input.imageUrl);
  const { data, error } = await supabaseAdmin.from("products").insert({
    store_id: actor.storeId, category_id: input.categoryId, name: input.name,
    description: input.description, price_cents: input.priceCents,
    image_url: input.imageUrl, active: input.active, featured: input.featured,
    sort_order: input.sortOrder
  }).select("id, category_id, name, description, price_cents, image_url, active, featured, sort_order, created_at, updated_at").single();
  if (error) databaseFailure("Falha ao cadastrar produto.");
  if (input.imageUrl) {
    try {
      await claimManagedProductImage(actor.storeId, input.imageUrl, data.id);
    } catch (claimError) {
      await supabaseAdmin.from("products").delete()
        .eq("store_id", actor.storeId)
        .eq("id", data.id);
      throw claimError;
    }
  }
  await audit(actor, "product.created", "product", data.id, { priceCents: data.price_cents });
  return productDto(data);
}

export async function updateProduct(actor: Actor, id: string, input: any) {
  const { data: current, error: currentError } = await supabaseAdmin.from("products")
    .select("id, image_url")
    .eq("store_id", actor.storeId)
    .eq("id", id)
    .maybeSingle();
  if (currentError) databaseFailure("Falha ao validar produto.");
  if (!current) throw new HttpError(404, "Produto não encontrado.");
  if (input.categoryId) await ensureCategory(actor.storeId, input.categoryId);
  if (input.imageUrl && input.imageUrl !== current.image_url) {
    await claimManagedProductImage(actor.storeId, input.imageUrl, id);
  }
  const mapping: Record<string, string> = {
    categoryId: "category_id", name: "name", description: "description",
    priceCents: "price_cents", imageUrl: "image_url", active: "active",
    featured: "featured", sortOrder: "sort_order"
  };
  const patch: any = {};
  for (const [key, column] of Object.entries(mapping)) {
    if (input[key] !== undefined) patch[column] = input[key];
  }
  const { data, error } = await supabaseAdmin.from("products").update(patch)
    .eq("store_id", actor.storeId).eq("id", id)
    .select("id, category_id, name, description, price_cents, image_url, active, featured, sort_order, created_at, updated_at").maybeSingle();
  if (error) databaseFailure("Falha ao atualizar produto.");
  if (!data) throw new HttpError(404, "Produto não encontrado.");
  if (
    input.imageUrl !== undefined &&
    current.image_url &&
    input.imageUrl !== current.image_url
  ) {
    await removeManagedProductImage(actor.storeId, id, current.image_url);
  }
  await audit(actor, "product.updated", "product", id, { fields: Object.keys(input), priceCents: input.priceCents });
  return productDto(data);
}

export async function deactivateProduct(actor: Actor, id: string) {
  return updateProduct(actor, id, { active: false });
}

export async function listOptionGroups(storeId: string) {
  const { data, error } = await supabaseAdmin.from("product_option_groups")
    .select("id, product_id, name, required, min_select, max_select, active, sort_order, products!inner(store_id)")
    .eq("products.store_id", storeId).order("sort_order");
  if (error) databaseFailure("Falha ao carregar grupos de opções.");
  return (data ?? []).map(optionGroupDto);
}

export async function createOptionGroup(actor: Actor, input: any) {
  await ensureProduct(actor.storeId, input.productId);
  const { data, error } = await supabaseAdmin.from("product_option_groups").insert({
    product_id: input.productId, name: input.name, required: input.required,
    min_select: input.minSelect, max_select: input.maxSelect,
    active: input.active, sort_order: input.sortOrder
  }).select("id, product_id, name, required, min_select, max_select, active, sort_order").single();
  if (error) databaseFailure("Falha ao cadastrar grupo de opções.");
  await audit(actor, "option_group.created", "option_group", data.id);
  return optionGroupDto(data);
}

export async function updateOptionGroup(actor: Actor, id: string, input: any) {
  const { data: current, error: currentError } = await supabaseAdmin.from("product_option_groups")
    .select("id, product_id, required, min_select, max_select, products!inner(store_id)")
    .eq("id", id).eq("products.store_id", actor.storeId).maybeSingle();
  if (currentError) databaseFailure("Falha ao validar grupo de opções.");
  if (!current) throw new HttpError(404, "Grupo de opções não encontrado.");
  if (input.productId) await ensureProduct(actor.storeId, input.productId);
  const min = input.minSelect ?? current.min_select;
  const max = input.maxSelect ?? current.max_select;
  const required = input.required ?? current.required;
  if (max < min) throw new HttpError(422, "maxSelect deve ser maior ou igual a minSelect.");
  if (required && min < 1) {
    throw new HttpError(422, "Grupos obrigatórios devem exigir ao menos uma opção.");
  }
  const mapping: Record<string, string> = { productId: "product_id", name: "name", required: "required", minSelect: "min_select", maxSelect: "max_select", active: "active", sortOrder: "sort_order" };
  const patch: any = {};
  for (const [key, column] of Object.entries(mapping)) if (input[key] !== undefined) patch[column] = input[key];
  const { data, error } = await supabaseAdmin.from("product_option_groups").update(patch).eq("id", id)
    .select("id, product_id, name, required, min_select, max_select, active, sort_order").single();
  if (error) databaseFailure("Falha ao atualizar grupo de opções.");
  await audit(actor, "option_group.updated", "option_group", id, { fields: Object.keys(input) });
  return optionGroupDto(data);
}

export async function deactivateOptionGroup(actor: Actor, id: string) {
  return updateOptionGroup(actor, id, { active: false });
}

export async function listOptionValues(storeId: string) {
  const { data, error } = await supabaseAdmin.from("product_option_values")
    .select("id, group_id, name, price_delta_cents, active, sort_order, product_option_groups!inner(products!inner(store_id))")
    .eq("product_option_groups.products.store_id", storeId).order("sort_order");
  if (error) databaseFailure("Falha ao carregar valores de opções.");
  return (data ?? []).map(optionValueDto);
}

export async function createOptionValue(actor: Actor, input: any) {
  await ensureGroup(actor.storeId, input.groupId);
  const { data, error } = await supabaseAdmin.from("product_option_values").insert({
    group_id: input.groupId, name: input.name, price_delta_cents: input.priceDeltaCents,
    active: input.active, sort_order: input.sortOrder
  }).select("id, group_id, name, price_delta_cents, active, sort_order").single();
  if (error) databaseFailure("Falha ao cadastrar valor de opção.");
  await audit(actor, "option_value.created", "option_value", data.id, { priceDeltaCents: data.price_delta_cents });
  return optionValueDto(data);
}

export async function updateOptionValue(actor: Actor, id: string, input: any) {
  const { data: existing, error: existingError } = await supabaseAdmin.from("product_option_values")
    .select("id, product_option_groups!inner(products!inner(store_id))")
    .eq("id", id).eq("product_option_groups.products.store_id", actor.storeId).maybeSingle();
  if (existingError) databaseFailure("Falha ao validar valor de opção.");
  if (!existing) throw new HttpError(404, "Valor de opção não encontrado.");
  if (input.groupId) await ensureGroup(actor.storeId, input.groupId);
  const mapping: Record<string, string> = { groupId: "group_id", name: "name", priceDeltaCents: "price_delta_cents", active: "active", sortOrder: "sort_order" };
  const patch: any = {};
  for (const [key, column] of Object.entries(mapping)) if (input[key] !== undefined) patch[column] = input[key];
  const { data, error } = await supabaseAdmin.from("product_option_values").update(patch).eq("id", id)
    .select("id, group_id, name, price_delta_cents, active, sort_order").single();
  if (error) databaseFailure("Falha ao atualizar valor de opção.");
  await audit(actor, "option_value.updated", "option_value", id, { fields: Object.keys(input), priceDeltaCents: input.priceDeltaCents });
  return optionValueDto(data);
}

export async function deactivateOptionValue(actor: Actor, id: string) {
  return updateOptionValue(actor, id, { active: false });
}

export async function listZones(storeId: string) {
  const { data, error } = await supabaseAdmin.from("delivery_zones")
    .select("id, name, fee_cents, minimum_order_cents, active")
    .eq("store_id", storeId).order("name");
  if (error) databaseFailure("Falha ao carregar zonas de entrega.");
  return (data ?? []).map(zoneDto);
}

export async function createZone(actor: Actor, input: any) {
  const { data, error } = await supabaseAdmin.from("delivery_zones").insert({
    store_id: actor.storeId, name: input.name, fee_cents: input.feeCents,
    minimum_order_cents: input.minimumOrderCents, active: input.active
  }).select("id, name, fee_cents, minimum_order_cents, active").single();
  if (error) throw new HttpError(error.code === "23505" ? 409 : 503,
    error.code === "23505" ? "Já existe uma zona com este nome." : "Falha ao cadastrar zona.");
  await audit(actor, "delivery_zone.created", "delivery_zone", data.id, { feeCents: data.fee_cents, minimumOrderCents: data.minimum_order_cents });
  return zoneDto(data);
}

export async function updateZone(actor: Actor, id: string, input: any) {
  const mapping: Record<string, string> = { name: "name", feeCents: "fee_cents", minimumOrderCents: "minimum_order_cents", active: "active" };
  const patch: any = {};
  for (const [key, column] of Object.entries(mapping)) if (input[key] !== undefined) patch[column] = input[key];
  const { data, error } = await supabaseAdmin.from("delivery_zones").update(patch)
    .eq("store_id", actor.storeId).eq("id", id)
    .select("id, name, fee_cents, minimum_order_cents, active").maybeSingle();
  if (error) throw new HttpError(error.code === "23505" ? 409 : 503,
    error.code === "23505" ? "Já existe uma zona com este nome." : "Falha ao atualizar zona.");
  if (!data) throw new HttpError(404, "Zona de entrega não encontrada.");
  await audit(actor, "delivery_zone.updated", "delivery_zone", id, { fields: Object.keys(input), feeCents: input.feeCents, minimumOrderCents: input.minimumOrderCents });
  return zoneDto(data);
}

export async function deactivateZone(actor: Actor, id: string) {
  return updateZone(actor, id, { active: false });
}

export async function getStoreSettings(storeId: string) {
  const [storeResult, paymentsResult] = await Promise.all([
    supabaseAdmin.from("stores").select("id, slug, name, description, logo_url, setup_complete, is_open, accepts_delivery, accepts_pickup, accepts_scheduled_orders, minimum_order_cents, timezone, instagram_handle, whatsapp_e164, whatsapp_display, scheduled_min_lead_minutes, scheduled_max_advance_days").eq("id", storeId).single(),
    supabaseAdmin.from("store_payment_methods").select("method, label, instructions, active, sort_order").eq("store_id", storeId).order("sort_order")
  ]);
  if (storeResult.error || paymentsResult.error) databaseFailure("Falha ao carregar configurações.");
  const row = storeResult.data;
  return {
    id: row.id, slug: row.slug, name: row.name, description: row.description,
    logoUrl: row.logo_url, setupComplete: row.setup_complete, isOpen: row.is_open,
    acceptsDelivery: row.accepts_delivery, acceptsPickup: row.accepts_pickup,
    acceptsScheduledOrders: row.accepts_scheduled_orders,
    minimumOrderCents: row.minimum_order_cents, timezone: row.timezone,
    instagram: row.instagram_handle, whatsappE164: row.whatsapp_e164,
    whatsappDisplay: row.whatsapp_display,
    scheduledMinLeadMinutes: row.scheduled_min_lead_minutes,
    scheduledMaxAdvanceDays: row.scheduled_max_advance_days,
    paymentMethods: (paymentsResult.data ?? []).map((method) => ({
      code: method.method, method: method.method, label: method.label,
      instructions: method.instructions,
      active: method.active, sortOrder: method.sort_order
    }))
  };
}

async function replacePaymentMethods(actor: Actor, methods: any[]) {
  if (methods.length) {
    const rows = methods.map((method) => ({
      store_id: actor.storeId, method: method.method, label: method.label,
      instructions: method.instructions, active: method.active, sort_order: method.sortOrder
    }));
    const { error } = await supabaseAdmin.from("store_payment_methods")
      .upsert(rows, { onConflict: "store_id,method" });
    if (error) databaseFailure("Falha ao salvar formas de pagamento.");
  }
  const included = new Set(methods.map((method) => method.method));
  for (const method of ["pix", "cash", "card_on_delivery"]) {
    if (!included.has(method)) {
      const { error } = await supabaseAdmin.from("store_payment_methods")
        .update({ active: false }).eq("store_id", actor.storeId).eq("method", method);
      if (error) databaseFailure("Falha ao salvar formas de pagamento.");
    }
  }
}

async function validateSetup(storeId: string, prospective: any) {
  if (!prospective.accepts_delivery && !prospective.accepts_pickup && !prospective.accepts_scheduled_orders) {
    throw new HttpError(422, "Ative ao menos uma modalidade de atendimento.");
  }
  const [hours, payments, zones] = await Promise.all([
    supabaseAdmin.from("store_hours").select("id", { count: "exact", head: true }).eq("store_id", storeId).eq("active", true),
    supabaseAdmin.from("store_payment_methods").select("id", { count: "exact", head: true }).eq("store_id", storeId).eq("active", true),
    supabaseAdmin.from("delivery_zones").select("id", { count: "exact", head: true }).eq("store_id", storeId).eq("active", true)
  ]);
  if (hours.error || payments.error || zones.error) databaseFailure("Falha ao validar a configuração da loja.");
  if (!hours.count) throw new HttpError(422, "Cadastre ao menos um horário antes de concluir a configuração.");
  if (!payments.count) throw new HttpError(422, "Ative ao menos uma forma de pagamento.");
  if (prospective.accepts_delivery && !zones.count) throw new HttpError(422, "Cadastre uma zona ativa antes de habilitar entrega.");
}

export async function updateStoreSettings(actor: Actor, input: any) {
  if (input.timezone) {
    try { new Intl.DateTimeFormat("pt-BR", { timeZone: input.timezone }).format(); }
    catch { throw new HttpError(422, "Fuso horário inválido."); }
  }
  if (input.paymentMethods) await replacePaymentMethods(actor, input.paymentMethods);
  const { data: current, error: currentError } = await supabaseAdmin.from("stores")
    .select("setup_complete, is_open, accepts_delivery, accepts_pickup, accepts_scheduled_orders")
    .eq("id", actor.storeId).single();
  if (currentError) databaseFailure("Falha ao validar configurações.");
  const prospective = {
    accepts_delivery: input.acceptsDelivery ?? current.accepts_delivery,
    accepts_pickup: input.acceptsPickup ?? current.accepts_pickup,
    accepts_scheduled_orders: input.acceptsScheduledOrders ?? current.accepts_scheduled_orders
  };
  if (input.setupComplete === true) await validateSetup(actor.storeId, prospective);

  const mapping: Record<string, string> = {
    name: "name", description: "description", logoUrl: "logo_url", isOpen: "is_open",
    acceptsDelivery: "accepts_delivery", acceptsPickup: "accepts_pickup",
    acceptsScheduledOrders: "accepts_scheduled_orders", minimumOrderCents: "minimum_order_cents",
    timezone: "timezone", instagram: "instagram_handle", whatsappE164: "whatsapp_e164",
    whatsappDisplay: "whatsapp_display", setupComplete: "setup_complete",
    scheduledMinLeadMinutes: "scheduled_min_lead_minutes",
    scheduledMaxAdvanceDays: "scheduled_max_advance_days"
  };
  const patch: any = {};
  for (const [key, column] of Object.entries(mapping)) if (input[key] !== undefined) patch[column] = input[key];
  if (Object.keys(patch).length) {
    const { error } = await supabaseAdmin.from("stores").update(patch).eq("id", actor.storeId);
    if (error) databaseFailure("Falha ao atualizar configurações.");
  }
  await audit(actor, "store.updated", "store", actor.storeId, { fields: Object.keys(input) });
  return getStoreSettings(actor.storeId);
}

export async function listHours(storeId: string) {
  const { data, error } = await supabaseAdmin.from("store_hours")
    .select("id, day_of_week, opens_at, closes_at, active")
    .eq("store_id", storeId).order("day_of_week").order("opens_at");
  if (error) databaseFailure("Falha ao carregar horários.");
  return (data ?? []).map((hour) => ({
    id: hour.id, dayOfWeek: hour.day_of_week, openTime: hour.opens_at,
    closeTime: hour.closes_at, closed: !hour.active
  }));
}

export async function replaceHours(actor: Actor, input: any[]) {
  const openHours = input.filter((hour) => !hour.closed);
  const closedDays = new Set(input.filter((hour) => hour.closed).map((hour) => hour.dayOfWeek));
  if (openHours.some((hour) => closedDays.has(hour.dayOfWeek))) {
    throw new HttpError(422, "Um dia não pode estar aberto e fechado ao mesmo tempo.");
  }
  let keptIds: string[] = [];
  if (openHours.length) {
    const rows = openHours.map((hour) => ({
      store_id: actor.storeId, day_of_week: hour.dayOfWeek,
      opens_at: hour.openTime, closes_at: hour.closeTime, active: true
    }));
    const { data, error } = await supabaseAdmin.from("store_hours")
      .upsert(rows, { onConflict: "store_id,day_of_week,opens_at" }).select("id");
    if (error) databaseFailure("Falha ao salvar horários.");
    keptIds = (data ?? []).map((row) => row.id);
  }
  let deletion = supabaseAdmin.from("store_hours").delete().eq("store_id", actor.storeId);
  if (keptIds.length) deletion = deletion.not("id", "in", `(${keptIds.join(",")})`);
  const { error: deleteError } = await deletion;
  if (deleteError) databaseFailure("Falha ao substituir horários.");
  const scheduledFlag = input.find((hour) => hour.acceptsScheduledOrders !== undefined)?.acceptsScheduledOrders;
  if (scheduledFlag !== undefined) {
    const { error } = await supabaseAdmin.from("stores")
      .update({ accepts_scheduled_orders: scheduledFlag }).eq("id", actor.storeId);
    if (error) databaseFailure("Falha ao atualizar agendamentos.");
  }
  await audit(actor, "store_hours.replaced", "store", actor.storeId, { intervals: openHours.length });
  return listHours(actor.storeId);
}

function exceptionDto(row: any) {
  return { id: row.id, exceptionDate: row.exception_date, isClosed: row.is_closed,
    openTime: row.opens_at, closeTime: row.closes_at, note: row.note };
}

export async function listExceptions(storeId: string) {
  const { data, error } = await supabaseAdmin.from("store_schedule_exceptions")
    .select("id, exception_date, is_closed, opens_at, closes_at, note")
    .eq("store_id", storeId).order("exception_date");
  if (error) databaseFailure("Falha ao carregar exceções de horário.");
  return (data ?? []).map(exceptionDto);
}

export async function createException(actor: Actor, input: any) {
  const { data, error } = await supabaseAdmin.from("store_schedule_exceptions").insert({
    store_id: actor.storeId, exception_date: input.exceptionDate,
    is_closed: input.isClosed, opens_at: input.isClosed ? null : input.openTime,
    closes_at: input.isClosed ? null : input.closeTime, note: input.note
  }).select("id, exception_date, is_closed, opens_at, closes_at, note").single();
  if (error) throw new HttpError(error.code === "23505" ? 409 : 503,
    error.code === "23505" ? "Já existe uma exceção nesta data." : "Falha ao cadastrar exceção.");
  await audit(actor, "schedule_exception.created", "schedule_exception", data.id);
  return exceptionDto(data);
}

export async function updateException(actor: Actor, id: string, input: any) {
  const { data: current, error: currentError } = await supabaseAdmin
    .from("store_schedule_exceptions")
    .select("id, is_closed, opens_at, closes_at")
    .eq("store_id", actor.storeId)
    .eq("id", id)
    .maybeSingle();
  if (currentError) databaseFailure("Falha ao validar exceção.");
  if (!current) throw new HttpError(404, "Exceção não encontrada.");

  const isClosed = input.isClosed ?? current.is_closed;
  const openTime = input.openTime !== undefined ? input.openTime : current.opens_at;
  const closeTime = input.closeTime !== undefined ? input.closeTime : current.closes_at;
  if (!isClosed && (!openTime || !closeTime || openTime === closeTime)) {
    throw new HttpError(422, "Informe horários válidos para a exceção.");
  }

  const patch: any = {};
  if (input.exceptionDate !== undefined) patch.exception_date = input.exceptionDate;
  if (input.isClosed !== undefined) patch.is_closed = input.isClosed;
  if (input.openTime !== undefined) patch.opens_at = input.openTime;
  if (input.closeTime !== undefined) patch.closes_at = input.closeTime;
  if (input.note !== undefined) patch.note = input.note;
  if (isClosed) { patch.opens_at = null; patch.closes_at = null; }
  const { data, error } = await supabaseAdmin.from("store_schedule_exceptions").update(patch)
    .eq("store_id", actor.storeId).eq("id", id)
    .select("id, exception_date, is_closed, opens_at, closes_at, note").maybeSingle();
  if (error) throw new HttpError(error.code === "23505" ? 409 : 503,
    error.code === "23505" ? "Já existe uma exceção nesta data." : "Falha ao atualizar exceção.");
  if (!data) throw new HttpError(404, "Exceção não encontrada.");
  await audit(actor, "schedule_exception.updated", "schedule_exception", id, { fields: Object.keys(input) });
  return exceptionDto(data);
}

export async function deleteException(actor: Actor, id: string) {
  const { data, error } = await supabaseAdmin.from("store_schedule_exceptions").delete()
    .eq("store_id", actor.storeId).eq("id", id).select("id").maybeSingle();
  if (error) databaseFailure("Falha ao remover exceção.");
  if (!data) throw new HttpError(404, "Exceção não encontrada.");
  await audit(actor, "schedule_exception.deleted", "schedule_exception", id);
}
