export function buildOperatorWorkflowSummary({ order, payment, reservation, caseRecord }) {
  return {
    orderId: order.orderId,
    orderState: order.state,
    paymentStatus: payment.status,
    reservationStatus: reservation.status,
    operatorQueue: caseRecord.queue,
    recommendedAction: order.state === "REFUND_PENDING"
      ? "Review refund compensation and confirm ledger release."
      : "Monitor order lifecycle.",
  };
}
