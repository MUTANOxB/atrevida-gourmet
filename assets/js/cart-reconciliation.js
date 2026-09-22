function normalizedQuantity(value, maxLineQuantity) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;

  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;

  const quantity = Math.min(maxLineQuantity, Math.trunc(numeric));
  return quantity >= 1 ? quantity : null;
}

function normalizedOptions(product, value) {
  if (value == null) value = [];
  if (!Array.isArray(value) || !Array.isArray(product.optionGroups)) return null;

  const groups = new Map();
  for (const group of product.optionGroups) {
    const minSelect = Number(group.minSelect);
    const maxSelect = Number(group.maxSelect);
    if (
      !group.id ||
      groups.has(String(group.id)) ||
      !Number.isInteger(minSelect) ||
      !Number.isInteger(maxSelect) ||
      minSelect < 0 ||
      maxSelect < Math.max(minSelect, 1) ||
      !Array.isArray(group.values)
    ) return null;

    groups.set(String(group.id), {
      minSelect: group.required ? Math.max(1, minSelect) : minSelect,
      maxSelect,
      valueIds: new Set(group.values.map((option) => String(option.id)))
    });
  }

  const counts = new Map();
  const selectedValueIds = new Set();
  const options = [];
  for (const option of value) {
    if (!option || typeof option !== "object" || Array.isArray(option)) return null;
    const groupId = String(option.groupId ?? "");
    const valueId = String(option.valueId ?? "");
    const group = groups.get(groupId);
    if (!group || !valueId || !group.valueIds.has(valueId) || selectedValueIds.has(valueId)) return null;

    selectedValueIds.add(valueId);
    counts.set(groupId, (counts.get(groupId) || 0) + 1);
    options.push({ groupId, valueId });
  }

  for (const [groupId, group] of groups) {
    const count = counts.get(groupId) || 0;
    if (count < group.minSelect || count > group.maxSelect) return null;
  }

  return options;
}

function inventoryLimit(product) {
  const stockMode = product.stockMode || "always";
  if (stockMode === "always") return Number.POSITIVE_INFINITY;
  if (stockMode === "manual") return product.available === true ? Number.POSITIVE_INFINITY : 0;
  if (stockMode !== "quantity" || product.available !== true) return 0;
  return Number.isInteger(product.remainingQuantity) && product.remainingQuantity > 0
    ? product.remainingQuantity
    : 0;
}

export function reconcileCartItems(
  cart,
  products,
  { maxLineQuantity, maxLines = 40, maxTotalUnits = 200, createUid }
) {
  const source = Array.isArray(cart) ? cart : [];
  const reconciled = [];
  const allocatedByProduct = new Map();
  let totalUnits = 0;
  let changed = !Array.isArray(cart);

  for (const item of source) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      changed = true;
      continue;
    }

    const productId = String(item.productId ?? "");
    const product = products.get(productId);
    const quantity = normalizedQuantity(item.quantity ?? item.qty, maxLineQuantity);
    const options = product ? normalizedOptions(product, item.options) : null;
    const stockLimit = product ? inventoryLimit(product) : 0;
    if (
      !product ||
      product.active === false ||
      !Number.isInteger(product.priceCents) ||
      product.priceCents < 0 ||
      quantity == null ||
      options == null ||
      stockLimit <= 0 ||
      reconciled.length >= maxLines ||
      totalUnits >= maxTotalUnits
    ) {
      changed = true;
      continue;
    }

    const alreadyAllocated = allocatedByProduct.get(productId) || 0;
    const stockCapacity = Number.isFinite(stockLimit)
      ? Math.max(0, stockLimit - alreadyAllocated)
      : quantity;
    const allowedQuantity = Math.min(
      quantity,
      stockCapacity,
      maxTotalUnits - totalUnits
    );
    if (allowedQuantity < 1) {
      changed = true;
      continue;
    }

    const line = {
      uid: String(item.uid || createUid()),
      productId,
      quantity: allowedQuantity,
      note: String(item.note || "").slice(0, 300),
      options
    };
    if (JSON.stringify(line) !== JSON.stringify(item)) changed = true;
    reconciled.push(line);
    allocatedByProduct.set(productId, alreadyAllocated + allowedQuantity);
    totalUnits += allowedQuantity;
  }

  return { cart: reconciled, changed };
}
