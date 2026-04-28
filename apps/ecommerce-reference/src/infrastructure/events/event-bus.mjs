export function createEventBus() {
  return {
    events: [],
  };
}

export function publishEvent(bus, topic, payload) {
  const event = {
    topic,
    payload,
    publishedAt: new Date().toISOString(),
  };
  bus.events.push(event);
  return event;
}
