/**
 * Nunca devolver diretamente:
 *
 * return databaseRow
 *
 * Monte explicitamente a resposta pública.
 *
 * Isso evita que uma coluna nova adicionada no banco
 * passe a vazar automaticamente pela API.
 */

export function publicStoreDto(store: any) {
  return {
    slug: store.slug,
    name: store.name,
    description: store.description,
    logoUrl: store.logo_url,
    isOpen: store.is_open,
    acceptsDelivery: store.accepts_delivery,
    acceptsPickup: store.accepts_pickup,
    acceptsScheduledOrders: store.accepts_scheduled_orders,
    minimumOrderCents: store.minimum_order_cents,
    currency: store.currency
  };
}

export function publicProductDto(product: any) {
  return {
    id: product.id,
    categoryId: product.category_id,
    name: product.name,
    description: product.description,
    imageUrl: product.image_url,
    priceCents: product.price_cents,
    featured: product.featured
  };
}

export function publicOrderTrackingDto(order: any) {
  return {
    orderNumber: order.order_number,
    status: order.status,
    fulfillmentType: order.fulfillment_type,
    subtotalCents: order.subtotal_cents,
    deliveryFeeCents: order.delivery_fee_cents,
    totalCents: order.total_cents,
    createdAt: order.created_at,
    acceptedAt: order.accepted_at,
    readyAt: order.ready_at,
    outForDeliveryAt: order.out_for_delivery_at ?? null,
    completedAt: order.completed_at,
    cancelledAt: order.cancelled_at ?? null,

    items: (order.order_items || []).map((item: any) => ({
      name: item.product_name_snapshot,
      unitPriceCents: item.unit_price_cents,
      quantity: item.quantity,
      lineTotalCents: item.line_total_cents,
      options: Array.isArray(item.options_snapshot) ? item.options_snapshot : []
    }))
  };
}

/**
 * Observe o que NÃO vai no tracking público:
 *
 * - customer_name
 * - customer_phone
 * - endereço
 * - CEP
 * - referência
 * - dados administrativos
 * - store_id
 * - IDs internos de membros
 */
