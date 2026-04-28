export function buildRefundCompensation({ orderId, reservationId, amount }) {
  return {
    orderId,
    amount,
    actions: [
      {
        type: "release_inventory",
        reservationId,
      },
      {
        type: "emit_refund_event",
        topic: "order.refunded",
      },
      {
        type: "write_audit_log",
        category: "refund",
      },
    ],
  };
}
