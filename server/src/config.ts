import { fileURLToPath } from 'node:url';
import { rulesFromEnv, type Rules } from './leaderboard';

export interface Config {
  port: number;
  /** Interval between WebSocket pings; a client that misses one is disconnected. */
  heartbeatMs: number;
  /** How long a match waits for a dropped player before they forfeit. */
  reconnectGraceMs: number;
  /** How long a disconnected session (and its token) is kept outside a match. */
  sessionTtlMs: number;
  maxConnections: number;
  /** Token bucket per connection: sustained messages per second and burst size. */
  messageRate: number;
  messageBurst: number;
  /** Strikes (rate-limited or malformed messages) before the connection is closed. */
  maxStrikes: number;
  /** Inputs buffered per player; extra inputs are dropped, so sending faster never moves faster. */
  inputQueueMax: number;
  /** Snapshots are skipped for a client whose socket has more than this many bytes queued. */
  maxBufferedBytes: number;
  publicDir: string;
  /** Postgres for the leaderboard; without it ratings live in memory until restart */
  databaseUrl: string | undefined;
  /**
   * Header holding the client IP, set by a trusted proxy (on Render, Cloudflare's cf-connecting-ip).
   * Unset: the socket address. X-Forwarded-For isn't used by default because a proxy that appends to
   * it passes through whatever the client sent first.
   */
  clientIpHeader: string | undefined;
  rules: Rules;
}

const int = (v: string | undefined, def: number) => (v ? Number.parseInt(v, 10) : def);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: int(env.PORT, 8080),
    heartbeatMs: int(env.HEARTBEAT_MS, 10_000),
    reconnectGraceMs: int(env.RECONNECT_GRACE_MS, 15_000),
    sessionTtlMs: int(env.SESSION_TTL_MS, 120_000),
    maxConnections: int(env.MAX_CONNECTIONS, 2000),
    messageRate: int(env.MESSAGE_RATE, 90),
    messageBurst: int(env.MESSAGE_BURST, 120),
    maxStrikes: int(env.MAX_STRIKES, 50),
    inputQueueMax: int(env.INPUT_QUEUE_MAX, 8),
    maxBufferedBytes: int(env.MAX_BUFFERED_BYTES, 64 * 1024),
    publicDir: env.PUBLIC_DIR ?? fileURLToPath(new URL('../../client/dist', import.meta.url)),
    databaseUrl: env.DATABASE_URL || undefined,
    clientIpHeader: env.CLIENT_IP_HEADER?.toLowerCase() || undefined,
    rules: rulesFromEnv(env),
  };
}
