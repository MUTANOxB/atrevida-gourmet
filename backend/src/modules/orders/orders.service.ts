import { HttpError } from "../../lib/errors.js";
import {
  completeIdempotency,
  hashIdempotentPayload,
  releaseIdempotency,
  reserveIdempotency
} from "../../lib/idempotency.js";
import { createOrderNumber } from "../../lib/order-number.js";
import { directPixConfigured, generatePixPayload } from "../../lib/pix.js";
import { publicOrderTrackingDto } from "../../lib/public-dto.js";
import { supabaseAdmin } from "../../lib/supabase.js";
import { evaluateStoreSchedule } from "../store/availability.js";
import type { CreateOrderInput } from "./orders.schemas.js";
import { initialPaymentState } from "./payment.js";
import { priceOrderItems, type PricingProduct } from "./pricing.js";

type StoreRow = {
  id: string;
  active: boolean;
  setup_complete: boolean;
  is_open: boolean;
  accepts_delivery: boolean;
  accepts_pickup: boolean;
  accepts_scheduled_orders: boolean;
  minimum_order_cents: number;
  timezone: string;
  scheduled_min_lead_minutes: number | null;
  scheduled_max_advance_days: number | null;
  pix_key: string | null;
  pix_merchant_name: string | null;
  pix_merchant_city: string | null;
};

async function loadStoreSchedule(storeId: string) {
  const [hoursResult, exceptionsResult] = await Promise.all([
    supabaseAdmin
      .from("store_hours")
      .select("day_of_week, opens_at, closes_at, active")
      .eq("store_id", storeId),
    supabaseAdmin
      .from("store_schedule_exceptions")
      .select("exception_date, is_closed, opens_at, closes_at")
      .eq("store_id", storeId)
  ]);
  if (hoursResult.error || exceptionsResult.error) {
    throw new HttpError(503, "Não foi possível validar o horário da loja.");
  }
  return {
    hours: hoursResult.data ?? [],
    exceptions: exceptionsResult.data ?? []
  };
}

function normalizeZoneName(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("pt-BR");
}

async function loadPricingProducts(storeId: string, productIds: string[]) {
  const { data, error } = await supabaseAdmin
    .from("products")
    .select(`
      id,
      name,
      price_cents,
      active,
      category:categories!products_category_same_store_fkey!inner(active),
      option_groups:product_option_groups(
        id,
        name,
        required,
        min_select,
        max_select,
        active,
        values:product_option_values(
          id,
          name,
          price_delta_cents,
          active
        )
      )
    `)
    .eq("store_id", storeId)
    .in("id", productIds);
  if (error) throw new HttpError(503, "Não foi possível validar os produtos.");

  return (data ?? []).map((row: any): PricingProduct => ({
    id: row.id,
    name: row.name,
    price_cents: row.price_cents,
    active: row.active,
    categoryActive: Array.isArray(row.category)
      ? !!row.category[0]?.active
      : !!row.category?.active,
    optionGroups: (row.option_groups ?? []).map((group: any) => ({
      id: group.id,
      name: group.name,
      required: group.required,
      min_select: group.min_select,
      max_select: group.max_select,
      active: group.active,
      values: group.values ?? []
    }))
  }));
}

async function validateStoreAvailability(
  store: StoreRow,
  input: CreateOrderInput
) {
  if (!store.setup_complete) {
    throw new HttpError(422, "A loja ainda não concluiu a configuração para receber pedidos.");
  }

  if (input.fulfillmentType === "delivery" && !store.accepts_delivery) {
    throw new HttpError(422, "Entrega indisponível.");
  }
  if (input.fulfillmentType === "pickup" && !store.accepts_pickup) {
    throw new HttpError(422, "Retirada indisponível.");
  }
  if (input.fulfillmentType === "scheduled" && !store.accepts_scheduled_orders) {
    throw new HttpError(422, "Encomenda/agendamento indisponível.");
  }

  const schedule = await loadStoreSchedule(store.id);
  const target = input.scheduledFor ? new Date(input.scheduledFor) : new Date();
  if (input.fulfillmentType === "scheduled") {
    const now = Date.now();
    const minimumLeadMs = (store.scheduled_min_lead_minutes ?? 0) * 60 * 1000;
    if (target.getTime() <= now || target.getTime() < now + minimumLeadMs) {
      throw new HttpError(422, "O agendamento deve ser feito para um horário futuro.");
    }
    if (
      store.scheduled_max_advance_days != null &&
      target.getTime() > now + store.scheduled_max_advance_days * 24 * 60 * 60 * 1000
    ) {
      throw new HttpError(422, "Data de agendamento fora do período permitido.");
    }
  }

  const availability = evaluateStoreSchedule({
    at: target,
    timezone: store.timezone,
    hours: schedule.hours,
    exceptions: schedule.exceptions
  });
  const manualOpen = input.fulfillmentType === "scheduled" ? true : store.is_open;
  if (!availability.configured || !availability.open || !manualOpen) {
    throw new HttpError(
      422,
      input.fulfillmentType === "scheduled"
        ? "A loja não aceita encomendas neste horário."
        : "A loja está fechada no momento."
    );
  }
}

function orderResponse(order: any, store?: StoreRow) {
  const initial = initialPaymentState(order.payment_method);
  const response: Record<string, unknown> = {
    orderNumber: order.order_number,
    trackingToken: order.tracking_token,
    status: order.status,
    paymentMethod: order.payment_method,
    paymentProvider: order.payment_provider ?? initial.paymentProvider,
    paymentStatus: order.payment_status ?? initial.paymentStatus,
    subtotalCents: order.subtotal_cents,
    deliveryFeeCents: order.delivery_fee_cents,
    totalCents: order.total_cents,
    createdAt: order.created_at
  };
  if (order.payment_method === "pix" && store) {
    response.pix = {
      copyPaste: generatePixPayload({
        pixKey: store.pix_key ?? "",
        merchantName: store.pix_merchant_name ?? "",
        merchantCity: store.pix_merchant_city ?? "",
        amountCents: order.total_cents,
        txid: order.order_number
      })
    };
  }
  return response;
}

export async function createOrder(input: CreateOrderInput, idempotencyKey: string) {
  const { data: store, error: storeError } = await supabaseAdmin
    .from("stores")
    .select("id, active, setup_complete, is_open, accepts_delivery, accepts_pickup, accepts_scheduled_orders, minimum_order_cents, timezone, scheduled_min_lead_minutes, scheduled_max_advance_days, pix_key, pix_merchant_name, pix_merchant_city")
    .eq("slug", input.storeSlug)
    .eq("active", true)
    .maybeSingle();
  if (storeError || !store) throw new HttpError(404, "Loja não encontrada.");

  const requestHash = hashIdempotentPayload(input);
  const reservation = await reserveIdempotency({
    key: idempotencyKey,
    requestHash,
    storeId: store.id
  });
  if (reservation.kind === "replay") {
    return {
      statusCode: reservation.statusCode,
      body: reservation.body,
      replay: true,
      orderId: reservation.orderId,
      storeId: store.id
    };
  }

  let orderCreated = false;
  try {
    await validateStoreAvailability(store as StoreRow, input);

    const { data: payment } = await supabaseAdmin
      .from("store_payment_methods")
      .select("method")
      .eq("store_id", store.id)
      .eq("method", input.paymentMethod)
      .eq("active", true)
      .maybeSingle();
    if (!payment) throw new HttpError(422, "Forma de pagamento indisponível.");
    if (input.paymentMethod === "pix" && !directPixConfigured({
      pixKey: store.pix_key,
      pixMerchantName: store.pix_merchant_name,
      pixMerchantCity: store.pix_merchant_city
    })) {
      throw new HttpError(422, "O Pix ainda não foi configurado pela loja.");
    }

    const productIds = [...new Set(input.items.map((item) => item.productId))];
    const products = await loadPricingProducts(store.id, productIds);
    const { subtotalCents, preparedItems } = priceOrderItems(input.items, products);

    let deliveryFeeCents = 0;
    let deliveryZoneId: string | null = null;
    if (input.fulfillmentType === "delivery") {
      const { data: zone, error: zoneError } = await supabaseAdmin
        .from("delivery_zones")
        .select("id, name, fee_cents, minimum_order_cents")
        .eq("id", input.delivery!.zoneId)
        .eq("store_id", store.id)
        .eq("active", true)
        .maybeSingle();
      if (zoneError || !zone) throw new HttpError(422, "Região de entrega inválida.");
      if (
        normalizeZoneName(zone.name) !==
        normalizeZoneName(input.delivery!.neighborhood)
      ) {
        throw new HttpError(422, "O bairro informado não corresponde à região selecionada.");
      }
      if (subtotalCents < zone.minimum_order_cents) {
        throw new HttpError(422, "Pedido abaixo do valor mínimo para esta região.");
      }
      deliveryZoneId = zone.id;
      deliveryFeeCents = zone.fee_cents;
    }

    if (subtotalCents < store.minimum_order_cents) {
      throw new HttpError(422, "Pedido abaixo do valor mínimo da loja.");
    }
    const totalCents = subtotalCents + deliveryFeeCents;
    if (!Number.isSafeInteger(totalCents) || totalCents > 2_147_483_647) {
      throw new HttpError(422, "O valor calculado do pedido excede o limite permitido.");
    }
    if (
      input.paymentMethod === "cash" &&
      input.changeForCents != null &&
      input.changeForCents < totalCents
    ) {
      throw new HttpError(422, "O valor para troco deve ser igual ou maior que o total.");
    }

    const orderPayload: Record<string, unknown> = {
      store_id: store.id,
      order_number: createOrderNumber(new Date(), store.timezone),
      status: "pending",
      fulfillment_type: input.fulfillmentType,
      customer_name: input.customer.name,
      customer_phone: input.customer.phone,
      delivery_postal_code: input.delivery?.postalCode ?? null,
      delivery_street: input.delivery?.street ?? null,
      delivery_number: input.delivery?.number ?? null,
      delivery_neighborhood: input.delivery?.neighborhood ?? null,
      delivery_complement: input.delivery?.complement ?? null,
      delivery_reference: input.delivery?.reference ?? null,
      delivery_zone_id: deliveryZoneId,
      scheduled_for: input.scheduledFor ?? null,
      payment_method: input.paymentMethod,
      payment_provider: initialPaymentState(input.paymentMethod).paymentProvider,
      payment_status: initialPaymentState(input.paymentMethod).paymentStatus,
      change_for_cents: input.changeForCents ?? null,
      note: input.note ?? "",
      subtotal_cents: subtotalCents,
      delivery_fee_cents: deliveryFeeCents,
      total_cents: totalCents,
      idempotency_key: idempotencyKey
    };

    let order: any = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) orderPayload.order_number = createOrderNumber(new Date(), store.timezone);
      const { data, error } = await supabaseAdmin.rpc("create_order_with_items", {
        order_payload: orderPayload,
        items_payload: preparedItems
      });
      if (!error) {
        order = Array.isArray(data) ? data[0] : data;
        break;
      }
      if (error.code !== "23505" || attempt === 2) {
        throw new HttpError(503, "Não foi possível criar o pedido.");
      }
    }
    if (!order?.id) throw new HttpError(503, "Não foi possível criar o pedido.");
    orderCreated = true;
    order.payment_method ??= input.paymentMethod;
    const body = orderResponse(order, store as StoreRow);
    await completeIdempotency(idempotencyKey, store.id, order.id, 201, body);
    return {
      statusCode: 201,
      body,
      replay: false,
      orderId: order.id as string,
      storeId: store.id as string
    };
  } catch (error) {
    if (!orderCreated) await releaseIdempotency(idempotencyKey, store.id);
    throw error;
  }
}

export async function trackOrder(trackingToken: string) {
  const { data, error } = await supabaseAdmin
    .from("orders")
    .select(`
      order_number, status, fulfillment_type, payment_method, payment_status,
      delivery_fee_cents, total_cents, created_at, accepted_at,
      ready_at, out_for_delivery_at, completed_at, cancelled_at,
      order_items(product_name_snapshot, unit_price_cents, quantity,
        line_total_cents, options_snapshot)
    `)
    .eq("tracking_token", trackingToken)
    .maybeSingle();
  if (error) throw new HttpError(503, "Não foi possível consultar o pedido.");
  if (!data) throw new HttpError(404, "Pedido não encontrado.");
  return publicOrderTrackingDto(data);
}
