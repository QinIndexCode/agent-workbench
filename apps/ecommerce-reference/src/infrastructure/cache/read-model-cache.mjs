export function createReadModelCache() {
  return new Map();
}

export function writeReadModel(cache, key, value) {
  cache.set(key, {
    key,
    value,
    updatedAt: new Date().toISOString(),
  });
  return cache.get(key);
}
