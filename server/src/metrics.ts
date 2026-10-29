import client from 'prom-client';

export function createMetrics() {
  const registry = new client.Registry();
  client.collectDefaultMetrics({ register: registry });
  const m = {
    registry,
    connections: new client.Gauge({ name: 'rally_connections', help: 'Open WebSocket connections', registers: [registry] }),
    rooms: new client.Gauge({ name: 'rally_rooms', help: 'Active match rooms', registers: [registry] }),
    queued: new client.Gauge({ name: 'rally_queued_players', help: 'Players waiting for a quick match', registers: [registry] }),
    messagesIn: new client.Counter({ name: 'rally_messages_in_total', help: 'Messages received', labelNames: ['type'], registers: [registry] }),
    messagesOut: new client.Counter({ name: 'rally_messages_out_total', help: 'Messages sent', registers: [registry] }),
    rejected: new client.Counter({ name: 'rally_rejected_messages_total', help: 'Messages dropped', labelNames: ['reason'], registers: [registry] }),
    skippedSnapshots: new client.Counter({ name: 'rally_skipped_snapshots_total', help: 'Snapshots not sent to slow clients', registers: [registry] }),
    tickSeconds: new client.Histogram({
      name: 'rally_tick_seconds',
      help: 'Time to simulate one tick of every room',
      buckets: [0.0001, 0.0005, 0.001, 0.002, 0.005, 0.01, 0.02],
      registers: [registry],
    }),
    matchesEnded: new client.Counter({ name: 'rally_matches_ended_total', help: 'Finished matches', labelNames: ['reason'], registers: [registry] }),
    recordedMatches: new client.Counter({
      name: 'rally_recorded_matches_total',
      help: 'Leaderboard recording outcomes (rated, unrated, duplicate, failed)',
      labelNames: ['result'],
      registers: [registry],
    }),
    reconnects: new client.Counter({ name: 'rally_reconnects_total', help: 'Sessions resumed with a token', registers: [registry] }),
  };
  return m;
}

export type Metrics = ReturnType<typeof createMetrics>;
