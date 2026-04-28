const ORDER_TRANSITIONS = {
  DRAFT: ["reserve_inventory"],
  INVENTORY_RESERVED: ["authorize_payment", "release_inventory"],
  PAYMENT_AUTHORIZED: ["place_order", "refund_order"],
  PLACED: ["ship_order", "refund_order"],
  SHIPPED: ["deliver_order", "refund_order"],
  DELIVERED: ["refund_order"],
  REFUND_PENDING: ["complete_refund"],
  REFUNDED: [],
  CANCELLED: [],
};

export function createOrder(orderId) {
  return {
    orderId,
    state: "DRAFT",
    history: [{ event: "create_order", state: "DRAFT" }],
    auditTrail: [],
  };
}

export function applyOrderTransition(order, event, metadata = {}) {
  const allowed = ORDER_TRANSITIONS[order.state] ?? [];
  if (!allowed.includes(event)) {
    throw new Error(`Order transition "${event}" is not allowed from state "${order.state}".`);
  }

  const nextState = resolveNextState(event);
  const record = {
    event,
    from: order.state,
    to: nextState,
    metadata,
  };

  order.state = nextState;
  order.history.push({ event, state: nextState });
  order.auditTrail.push(record);
  return record;
}

function resolveNextState(event) {
  switch (event) {
    case "reserve_inventory":
      return "INVENTORY_RESERVED";
    case "authorize_payment":
      return "PAYMENT_AUTHORIZED";
    case "place_order":
      return "PLACED";
    case "ship_order":
      return "SHIPPED";
    case "deliver_order":
      return "DELIVERED";
    case "refund_order":
      return "REFUND_PENDING";
    case "complete_refund":
      return "REFUNDED";
    case "release_inventory":
      return "CANCELLED";
    default:
      throw new Error(`Unknown order event "${event}".`);
  }
}
