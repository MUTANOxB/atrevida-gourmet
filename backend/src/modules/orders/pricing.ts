import { HttpError } from "../../lib/errors.js";
import type { CreateOrderInput } from "./orders.schemas.js";

const MAX_DATABASE_INTEGER = 2_147_483_647;

export type PricingProduct = {
  id: string;
  name: string;
  price_cents: number | null;
  active: boolean;
  categoryActive: boolean;
  optionGroups: Array<{
    id: string;
    name: string;
    required: boolean;
    min_select: number;
    max_select: number;
    active: boolean;
    values: Array<{
      id: string;
      name: string;
      price_delta_cents: number;
      active: boolean;
    }>;
  }>;
};

export type PreparedOrderItem = {
  product_id: string;
  product_name_snapshot: string;
  unit_price_cents: number;
  quantity: number;
  line_total_cents: number;
  note: string;
  options_snapshot: Array<{
    groupId: string;
    groupName: string;
    valueId: string;
    valueName: string;
    priceDeltaCents: number;
  }>;
};

function checkedMoney(value: number) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_DATABASE_INTEGER) {
    throw new HttpError(422, "O valor calculado do pedido excede o limite permitido.");
  }
  return value;
}

/** Função pura: usa somente preços carregados do banco, nunca preços do browser. */
export function priceOrderItems(
  items: CreateOrderInput["items"],
  products: PricingProduct[]
) {
  const productMap = new Map(products.map((product) => [product.id, product]));
  const requestedIds = new Set(items.map((item) => item.productId));

  if (requestedIds.size !== productMap.size) {
    throw new HttpError(422, "Um ou mais produtos não existem nesta loja.");
  }

  let subtotalCents = 0;
  const preparedItems: PreparedOrderItem[] = [];

  for (const item of items) {
    const product = productMap.get(item.productId);
    if (
      !product ||
      !product.active ||
      !product.categoryActive ||
      product.price_cents == null
    ) {
      throw new HttpError(422, "Um ou mais produtos estão indisponíveis.");
    }

    const activeGroups = product.optionGroups.filter((group) => group.active);
    const groups = new Map(activeGroups.map((group) => [group.id, group]));
    const selectedByGroup = new Map<string, typeof item.options>();

    for (const selected of item.options) {
      const group = groups.get(selected.groupId);
      const value = group?.values.find((candidate) => candidate.id === selected.valueId);
      if (!group || !value || !value.active) {
        throw new HttpError(422, "Uma opção selecionada não pertence ao produto.");
      }

      const current = selectedByGroup.get(group.id) ?? [];
      current.push(selected);
      selectedByGroup.set(group.id, current);
    }

    for (const group of activeGroups) {
      const selectedCount = selectedByGroup.get(group.id)?.length ?? 0;
      const minimum = Math.max(group.min_select, group.required ? 1 : 0);
      if (selectedCount < minimum || selectedCount > group.max_select) {
        throw new HttpError(422, `Seleção inválida no grupo "${group.name}".`);
      }
    }

    let unitPriceCents = product.price_cents;
    const snapshots: PreparedOrderItem["options_snapshot"] = [];
    for (const selected of item.options) {
      const group = groups.get(selected.groupId)!;
      const value = group.values.find((candidate) => candidate.id === selected.valueId)!;
      unitPriceCents = checkedMoney(unitPriceCents + value.price_delta_cents);
      snapshots.push({
        groupId: group.id,
        groupName: group.name,
        valueId: value.id,
        valueName: value.name,
        priceDeltaCents: value.price_delta_cents
      });
    }

    const lineTotalCents = checkedMoney(unitPriceCents * item.quantity);
    subtotalCents = checkedMoney(subtotalCents + lineTotalCents);
    preparedItems.push({
      product_id: product.id,
      product_name_snapshot: product.name,
      unit_price_cents: unitPriceCents,
      quantity: item.quantity,
      line_total_cents: lineTotalCents,
      note: item.note ?? "",
      options_snapshot: snapshots
    });
  }

  return { subtotalCents, preparedItems };
}
