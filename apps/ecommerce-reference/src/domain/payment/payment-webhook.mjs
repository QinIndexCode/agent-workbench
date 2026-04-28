export function createPaymentLedger() {
  return {
    processedWebhookIds: new Set(),
    payments: [],
  };
}

export function applyPaymentWebhook(ledger, payload) {
  const { webhookId, orderId, amount, signatureVerified } = payload;
  if (!signatureVerified) {
    throw new Error("Payment webhook signature verification failed.");
  }
  if (ledger.processedWebhookIds.has(webhookId)) {
    return {
      duplicateIgnored: true,
      orderId,
      amount,
    };
  }
  ledger.processedWebhookIds.add(webhookId);
  const record = {
    webhookId,
    orderId,
    amount,
    status: "AUTHORIZED",
  };
  ledger.payments.push(record);
  return {
    duplicateIgnored: false,
    ...record,
  };
}
