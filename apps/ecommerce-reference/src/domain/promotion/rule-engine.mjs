export function evaluatePromotion(cart, rules) {
  const applied = [];
  let discountTotal = 0;

  for (const rule of rules) {
    if (rule.type === "threshold_percent" && cart.subtotal >= rule.threshold) {
      const discount = Number((cart.subtotal * rule.percentOff).toFixed(2));
      discountTotal += discount;
      applied.push({
        code: rule.code,
        discount,
        reason: `subtotal >= ${rule.threshold}`,
      });
    }
    if (rule.type === "sku_fixed" && cart.items.some((item) => item.sku === rule.sku)) {
      discountTotal += rule.amountOff;
      applied.push({
        code: rule.code,
        discount: rule.amountOff,
        reason: `sku ${rule.sku} present`,
      });
    }
  }

  return {
    applied,
    discountTotal: Number(discountTotal.toFixed(2)),
    totalAfterDiscount: Number(Math.max(0, cart.subtotal - discountTotal).toFixed(2)),
  };
}
