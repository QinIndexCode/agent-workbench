import { createCheckoutSession } from "../src/application/checkout/checkout-service.mjs";
import { buildSearchDocument } from "../src/application/search/search-indexer.mjs";
import { emitOrderAnalytics } from "../src/application/analytics/order-analytics-pipeline.mjs";
import { openCustomerServiceCase } from "../src/application/customer-service/case-service.mjs";
import { buildOperatorWorkflowSummary } from "../src/application/admin/operator-workflow.mjs";
import { applyOrderTransition } from "../src/domain/order/order-state-machine.mjs";
import { createReservationLedger, releaseReservation, seedInventory } from "../src/domain/inventory/reservation-ledger.mjs";
import { createPaymentLedger, applyPaymentWebhook } from "../src/domain/payment/payment-webhook.mjs";
import { buildRefundCompensation } from "../src/domain/refund/refund-compensation.mjs";
import { createEventBus, publishEvent } from "../src/infrastructure/events/event-bus.mjs";
import { createAuditLog, writeAuditRecord } from "../src/infrastructure/audit/audit-log.mjs";
import { createReadModelCache, writeReadModel } from "../src/infrastructure/cache/read-model-cache.mjs";

function main() {
  const inventoryLedger = createReservationLedger();
  const paymentLedger = createPaymentLedger();
  const eventBus = createEventBus();
  const auditLog = createAuditLog();
  const cache = createReadModelCache();

  seedInventory(inventoryLedger, "sku-sneaker-001", 12);

  const cart = {
    subtotal: 329.0,
    items: [{ sku: "sku-sneaker-001", quantity: 1 }],
  };
  const customer = {
    customerId: "cust-100",
    email: "buyer@example.com",
    name: "SCC Buyer",
  };
  const promotionRules = [
    { code: "VIP15", type: "threshold_percent", threshold: 300, percentOff: 0.15 },
    { code: "SNEAKER20", type: "sku_fixed", sku: "sku-sneaker-001", amountOff: 20 },
  ];

  const session = createCheckoutSession({
    orderId: "ord-1000",
    cart,
    customer,
    promotionRules,
    inventoryLedger,
  });
  writeAuditRecord(auditLog, "checkout", "session_created", {
    orderId: session.order.orderId,
    reservationId: session.reservation.reservationId,
  });

  const firstWebhook = applyPaymentWebhook(paymentLedger, {
    webhookId: "wh_001",
    orderId: session.order.orderId,
    amount: session.promotionResult.totalAfterDiscount,
    signatureVerified: true,
  });
  const replayWebhook = applyPaymentWebhook(paymentLedger, {
    webhookId: "wh_001",
    orderId: session.order.orderId,
    amount: session.promotionResult.totalAfterDiscount,
    signatureVerified: true,
  });

  applyOrderTransition(session.order, "authorize_payment", {
    webhookId: "wh_001",
  });
  applyOrderTransition(session.order, "place_order", {
    authorizationId: firstWebhook.webhookId,
  });

  const searchDocument = buildSearchDocument(session.order, customer);
  const analyticsEvent = emitOrderAnalytics(session.order, session.promotionResult);
  publishEvent(eventBus, "order.placed", {
    orderId: session.order.orderId,
    state: session.order.state,
  });
  publishEvent(eventBus, "analytics.order_completed", analyticsEvent);
  writeReadModel(cache, `order:${session.order.orderId}`, {
    orderId: session.order.orderId,
    state: session.order.state,
    customerId: customer.customerId,
  });

  applyOrderTransition(session.order, "refund_order", {
    reason: "customer_request",
  });
  const compensation = buildRefundCompensation({
    orderId: session.order.orderId,
    reservationId: session.reservation.reservationId,
    amount: session.promotionResult.totalAfterDiscount,
  });
  const released = releaseReservation(inventoryLedger, session.reservation.reservationId);
  publishEvent(eventBus, "order.refunded", {
    orderId: session.order.orderId,
    amount: compensation.amount,
  });
  writeAuditRecord(auditLog, "refund", "compensation_built", compensation);
  applyOrderTransition(session.order, "complete_refund", {
    compensationActions: compensation.actions.length,
  });

  const caseRecord = openCustomerServiceCase({
    orderId: session.order.orderId,
    customerId: customer.customerId,
    reason: "refund_follow_up",
  });
  const operatorWorkflow = buildOperatorWorkflowSummary({
    order: session.order,
    payment: paymentLedger.payments[0],
    reservation: released,
    caseRecord,
  });

  const report = {
    order: {
      orderId: session.order.orderId,
      finalState: session.order.state,
      history: session.order.history,
    },
    payment: {
      processedCount: paymentLedger.payments.length,
      duplicateIgnored: replayWebhook.duplicateIgnored,
      amount: firstWebhook.amount,
    },
    inventory: {
      reservationStatus: released?.status ?? "UNKNOWN",
      availableAfterRefund: inventoryLedger.availableBySku.get("sku-sneaker-001") ?? 0,
    },
    promotion: session.promotionResult,
    search: {
      documentId: searchDocument.documentId,
      searchableText: searchDocument.searchableText,
    },
    analytics: analyticsEvent,
    customerService: caseRecord,
    operatorWorkflow,
    audit: {
      recordCount: auditLog.records.length,
      categories: [...new Set(auditLog.records.map((record) => record.category))],
    },
    events: {
      total: eventBus.events.length,
      topics: eventBus.events.map((event) => event.topic),
    },
    cache: {
      keys: [...cache.keys()],
    },
  };

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(report);
}

main();
