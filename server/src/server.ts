import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { MAX_MESSAGE_BYTES, TICK_RATE, parseClientMessage, type ServerMessage } from '@rally/shared';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Config } from './config';
import { Leaderboard } from './leaderboard';
import { Lobby, type Connection, type Session } from './lobby';
import { createMetrics } from './metrics';
import { TokenBucket } from './ratelimit';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

class SocketConnection implements Connection {
  session: Session | null = null;
  alive = true;
  strikes = 0;
  readonly bucket: TokenBucket;

  constructor(
    readonly ws: WebSocket,
    readonly ip: string,
    private readonly config: Config,
    private readonly metrics: ReturnType<typeof createMetrics>,
    rate: number,
    burst: number,
  ) {
    this.bucket = new TokenBucket(rate, burst);
  }

  send(msg: ServerMessage, droppable = false) {
    if (this.ws.readyState !== this.ws.OPEN) return;
    // Backpressure: a client that cannot keep up gets fewer snapshots instead of an ever-growing buffer
    if (droppable && this.ws.bufferedAmount > this.config.maxBufferedBytes) {
      this.metrics.skippedSnapshots.inc();
      return;
    }
    this.ws.send(JSON.stringify(msg));
    this.metrics.messagesOut.inc();
  }
}

export function startServer(config: Config) {
  const metrics = createMetrics();
  const leaderboard = Leaderboard.create(config.databaseUrl, config.rules, metrics);
  const lobby = new Lobby(config, metrics, leaderboard);
  const publicDir = resolve(config.publicDir);

  const http = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/healthz') return res.writeHead(200, { 'content-type': 'text/plain' }).end('ok\n');
    if (url.pathname === '/metrics') {
      res.writeHead(200, { 'content-type': metrics.registry.contentType });
      return res.end(await metrics.registry.metrics());
    }
    if (url.pathname === '/api/leaderboard') {
      try {
        const board = await leaderboard.board();
        return res
          .writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          .end(JSON.stringify({ persistent: leaderboard.store.persistent, ...board }));
      } catch (err) {
        console.error(JSON.stringify({ msg: 'leaderboard query failed', error: (err as Error).message }));
        return res.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'leaderboard unavailable' }));
      }
    }
    if (url.pathname === '/api/stats') {
      return res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(lobby.stats));
    }
    serveStatic(publicDir, url.pathname, res);
  });

  const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });
  const connections = new WeakMap<WebSocket, SocketConnection>();

  wss.on('connection', (ws, req) => {
    if (wss.clients.size > config.maxConnections) return ws.close(1013, 'server full');
    const header = config.clientIpHeader ? req.headers[config.clientIpHeader] : undefined;
    const fromHeader = (Array.isArray(header) ? header[0] : header)?.trim();
    // A configured header that is missing means the proxy setup changed: every player would share the proxy's address
    metrics.clientIpSource.inc({ source: fromHeader ? 'header' : config.clientIpHeader ? 'header_missing' : 'socket' });
    const ip = fromHeader || req.socket.remoteAddress || 'unknown';
    const conn = new SocketConnection(ws, ip, config, metrics, config.messageRate, config.messageBurst);
    connections.set(ws, conn);
    metrics.connections.set(wss.clients.size);

    ws.on('pong', () => (conn.alive = true));
    ws.on('message', (data, isBinary) => {
      const strike = (reason: string, code: 'bad_message' | 'rate_limited') => {
        metrics.rejected.inc({ reason });
        if (++conn.strikes > config.maxStrikes) return ws.close(1008, 'too many bad messages');
        if (conn.strikes % 10 === 1) conn.send({ t: 'error', code }); // tell the client, without echoing every drop
      };
      if (!conn.bucket.take()) return strike('rate_limited', 'rate_limited');
      const msg = isBinary ? null : parseClientMessage(data.toString());
      if (!msg) return strike('malformed', 'bad_message');
      metrics.messagesIn.inc({ type: msg.t });
      lobby.handle(conn, msg);
    });
    ws.on('close', () => {
      lobby.disconnected(conn);
      metrics.connections.set(wss.clients.size);
    });
    ws.on('error', () => ws.terminate()); // e.g. a frame over maxPayload
  });

  // Heartbeat: a socket that did not answer the previous ping is dead (no TCP close was seen)
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      const conn = connections.get(ws);
      if (!conn) continue;
      if (!conn.alive) {
        ws.terminate();
        continue;
      }
      conn.alive = false;
      ws.ping();
    }
  }, config.heartbeatMs);

  // Fixed-timestep loop for every room. setInterval drifts, so simulate as many ticks as real time allows.
  const tickMs = 1000 / TICK_RATE;
  let last = performance.now();
  let lag = 0;
  const loop = setInterval(() => {
    const now = performance.now();
    lag += now - last;
    last = now;
    let steps = 0;
    while (lag >= tickMs && steps < 5) {
      const end = metrics.tickSeconds.startTimer();
      lobby.tick();
      end();
      lag -= tickMs;
      steps++;
    }
    if (steps === 5) lag = 0; // overloaded: drop the backlog rather than spiral
  }, tickMs / 2);
  const sweep = setInterval(() => lobby.sweep(), 10_000);

  return {
    http,
    wss,
    lobby,
    leaderboard,
    metrics,
    async listen(port = config.port): Promise<number> {
      await leaderboard.store.init();
      return new Promise((ok) => http.listen(port, () => ok((http.address() as { port: number }).port)));
    },
    async close() {
      clearInterval(heartbeat);
      clearInterval(loop);
      clearInterval(sweep);
      for (const ws of wss.clients) ws.close(1001, 'server shutting down');
      await new Promise<void>((ok) => wss.close(() => ok()));
      await new Promise<void>((ok) => http.close(() => ok()));
      await leaderboard.store.close();
    },
  };
}

function serveStatic(root: string, pathname: string, res: ServerResponse) {
  let file = normalize(join(root, decodeURIComponent(pathname)));
  if (!file.startsWith(root)) return res.writeHead(403).end();
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html'); // single-page app
  if (!existsSync(file)) return res.writeHead(404, { 'content-type': 'text/plain' }).end('client not built\n');
  const hashed = /-[A-Za-z0-9_-]{8}\.(js|css)$/.test(file);
  res.writeHead(200, {
    'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
    'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-content-type-options': 'nosniff',
  });
  createReadStream(file).pipe(res);
}
