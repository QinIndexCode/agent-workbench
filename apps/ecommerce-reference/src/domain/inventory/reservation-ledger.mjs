export function createReservationLedger() {
  return {
    availableBySku: new Map(),
    reservations: new Map(),
  };
}

export function seedInventory(ledger, sku, quantity) {
  ledger.availableBySku.set(sku, quantity);
}

export function reserveInventory(ledger, { reservationId, sku, quantity }) {
  const available = ledger.availableBySku.get(sku) ?? 0;
  if (available < quantity) {
    throw new Error(`Insufficient inventory for ${sku}. requested=${quantity} available=${available}`);
  }
  ledger.availableBySku.set(sku, available - quantity);
  const record = {
    reservationId,
    sku,
    quantity,
    status: "RESERVED",
  };
  ledger.reservations.set(reservationId, record);
  return record;
}

export function releaseReservation(ledger, reservationId) {
  const reservation = ledger.reservations.get(reservationId);
  if (!reservation || reservation.status === "RELEASED") {
    return reservation ?? null;
  }
  reservation.status = "RELEASED";
  ledger.availableBySku.set(
    reservation.sku,
    (ledger.availableBySku.get(reservation.sku) ?? 0) + reservation.quantity,
  );
  return reservation;
}
