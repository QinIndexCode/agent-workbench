export function openCustomerServiceCase({ orderId, customerId, reason }) {
  return {
    caseId: `case-${orderId}`,
    orderId,
    customerId,
    status: "OPEN",
    queue: "refund-review",
    reason,
  };
}
