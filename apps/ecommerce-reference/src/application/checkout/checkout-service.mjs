import { createOrder, applyOrderTransition } from "../../domain/order/order-state-machine.mjs";
import { evaluatePromotion } from "../../domain/promotion/rule-engine.mjs";
import { reserveInventory } from "../../domain/inventory/reservation-ledger.mjs";

export function createCheckoutSession({
  orderId,
  cart,
  customer,
  promotionRules,
  inventoryLedger,
}) {
  const order = createOrder(orderId);
  const promotionResult = evaluatePromotion(cart, promotionRules);
  const reservation = reserveInventory(inventoryLedger, {
    reservationId: `res-${orderId}`,
    sku: cart.items[0].sku,
    quantity: cart.items[0].quantity,
  });

  applyOrderTransition(order, "reserve_inventory", {
    reservationId: reservation.reservationId,
    customerId: customer.customerId,
  });

  return {
    order,
    reservation,
    promotionResult,
    customer,
    cart,
  };
}
