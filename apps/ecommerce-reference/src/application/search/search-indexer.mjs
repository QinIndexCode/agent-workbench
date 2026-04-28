export function buildSearchDocument(order, customer) {
  return {
    documentId: `order:${order.orderId}`,
    orderId: order.orderId,
    state: order.state,
    customerId: customer.customerId,
    searchableText: `${customer.email} ${customer.name} ${order.orderId}`.toLowerCase(),
  };
}
