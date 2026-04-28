export function emitOrderAnalytics(order, promotionResult) {
  return {
    metric: "order_completed",
    orderId: order.orderId,
    state: order.state,
    discountTotal: promotionResult.discountTotal,
    dimensions: {
      channel: "storefront",
      settlementModel: "authorize_then_capture",
    },
  };
}
