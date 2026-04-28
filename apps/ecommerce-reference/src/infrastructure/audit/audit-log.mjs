export function createAuditLog() {
  return {
    records: [],
  };
}

export function writeAuditRecord(log, category, action, payload) {
  const record = {
    category,
    action,
    payload,
    createdAt: new Date().toISOString(),
  };
  log.records.push(record);
  return record;
}
