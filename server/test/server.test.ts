import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { ServerMessage } from '@rally/shared';
import { loadConfig, type Config } from '../src/config';
import { startServer } from '../src/server';

type Msg = ServerMessage & Record<string, unknown>;

/** A test client that records every message and can wait for a given type. */
class Client {
  readonly ws: WebSocket;
  readonly inbox: Msg[] = [];
  private waiters: { type: string; pred: (m: Msg) => boolean; ok: (m: Msg) => void }[] = [];
  closed: { code: number } | null = null;
  seq = 0;

  constructor(url: string, headers: Record<string, string> = {}) {
    this.ws = new WebSocket(url, { headers });
    this.ws.on('message', (d) => {
      const m = JSON.parse(d.toString()) as Msg;
      this.inbox.push(m);
      const i = this.waiters.findIndex((w) => w.type === m.t && w.pred(m));
      if (i !== -1) this.waiters.splice(i, 1)[0]!.ok(m);
    });
    this.ws.on('close', (code) => (this.closed = { code }));
  }

  open() {
    return new Promise<void>((ok, fail) => {
      this.ws.once('open', () => ok());
      this.ws.once('error', fail);
    });
  }

  send(m: object) {
    this.ws.send(JSON.stringify(m));
  }

  next<T extends Msg['t']>(type: T, pred: (m: Msg) => boolean = () => true, timeout = 5000): Promise<Msg> {
    const seen = this.inbox.find((m) => m.t === type && pred(m));
    if (seen) {
      this.inbox.splice(this.inbox.indexOf(seen), 1);
      return Promise.resolve(seen);
    }
    return new Promise((ok, fail) => {
      const timer = setTimeout(() => fail(new Error(`timed out waiting for ${type}`)), timeout);
      this.waiters.push({ type, pred, ok: (m) => (clearTimeout(timer), this.inbox.splice(this.inbox.indexOf(m), 1), ok(m)) });
    });
  }

  async hello(name: string, token?: string, key?: string) {
    this.send({ t: 'hello', v: 1, name, ...(token ? { token } : {}), ...(key ? { key } : {}) });
    return this.next('welcome');
  }

  input(dir: -1 | 0 | 1) {
    this.send({ t: 'input', seq: ++this.seq, dir });
  }

  closedWith() {
    return new Promise<number>((ok) => (this.closed ? ok(this.closed.code) : this.ws.once('close', (code) => ok(code))));
  }
}

let server: ReturnType<typeof startServer>;
let url: string;
const clients: Client[] = [];

async function connect(name?: string, opts: { key?: string; ip?: string } = {}) {
  const c = new Client(url, opts.ip ? { 'x-client-ip': opts.ip } : {});
  clients.push(c);
  await c.open();
  if (name) await c.hello(name, undefined, opts.key);
  return c;
}

const newKey = () => randomBytes(32).toString('base64url');

async function start(overrides: Partial<Config> = {}) {
  server = startServer({ ...loadConfig({}), reconnectGraceMs: 600, heartbeatMs: 60_000, publicDir: '/nonexistent', ...overrides });
  const port = await server.listen(0);
  url = `ws://127.0.0.1:${port}/ws`;
}

async function matchTwo() {
  const a = await connect('Alice');
  const b = await connect('Bob');
  a.send({ t: 'queue' });
  await a.next('waiting');
  b.send({ t: 'queue' });
  const [ma, mb] = await Promise.all([a.next('matched'), b.next('matched')]);
  return { a, b, ma, mb };
}

beforeEach(() => start());
afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  await server.close();
});

describe('matchmaking', () => {
  it('pairs two queued players and streams authoritative snapshots', async () => {
    const { a, b, ma, mb } = await matchTwo();
    expect(ma.side).toBe(0);
    expect(mb.side).toBe(1);
    expect(ma.names).toEqual(['Alice', 'Bob']);

    const snap = await a.next('state');
    expect(snap.ph).toBe('countdown');
    expect(await b.next('event', (m) => m.kind === 'serve', 3000)).toBeTruthy();
    expect((await a.next('state', (m) => m.ph === 'playing')).ph).toBe('playing');
  });

  it('applies inputs in order and acknowledges them for client prediction', async () => {
    const { a } = await matchTwo();
    const start = (await a.next('state')).p as number[];
    for (let i = 0; i < 30; i++) {
      a.input(-1); // one input per tick, as the real client sends them
      await new Promise((r) => setTimeout(r, 1000 / 60));
    }
    const later = await a.next('state', (m) => (m.ack as number) >= 30, 3000);
    expect((later.p as number[])[0]).toBeLessThan(start[0]!);
  });

  it('cannot be sped up by sending inputs faster than the tick rate', async () => {
    const { a } = await matchTwo();
    const first = await a.next('state');
    for (let i = 0; i < 100; i++) a.input(1); // 100 inputs at once (within the rate limit's burst)
    const s = await a.next('state', (m) => (m.tick as number) >= (first.tick as number) + 30);
    const moved = (s.p as number[])[0]! - (first.p as number[])[0]!;
    const ticks = (s.tick as number) - (first.tick as number);
    // A backlog can only add the queue's capacity (8 inputs) on top of normal speed: no sustained speed-up
    expect(moved).toBeLessThanOrEqual(((ticks + 8) * 420) / 60);
    expect(a.closed).toBeNull();
  });

  it('pairs friends through a private room code', async () => {
    const host = await connect('Host');
    const guest = await connect('Guest');
    host.send({ t: 'create' });
    const { code } = await host.next('waiting');
    expect(code).toMatch(/^[A-Z2-9]{4}$/);
    guest.send({ t: 'join', code: (code as string).toLowerCase() });
    await Promise.all([host.next('matched'), guest.next('matched')]);
    guest.send({ t: 'join', code: 'ZZZZ' });
    expect((await guest.next('error')).code).toBe('no_such_room');
  });

  it('plays a full match against the bot', async () => {
    const solo = await connect('Solo');
    solo.send({ t: 'bot' });
    const m = await solo.next('matched');
    expect(m.bot).toBe(true);
    // Stay still: the bot scores until it wins
    const over = await solo.next('over', () => true, 60_000);
    expect(over).toMatchObject({ winner: 1, reason: 'score' });
    solo.send({ t: 'rematch' });
    expect((await solo.next('matched')).bot).toBe(true); // the bot is always up for another
  }, 70_000);
});

describe('reconnection', () => {
  it('resumes a session from its token, and ignores unknown tokens', async () => {
    const c = await connect();
    const w = await c.hello('Carol');
    c.ws.terminate();
    const back = await connect();
    expect(await back.hello('Carol', w.token as string)).toMatchObject({ resumed: true, id: w.id });
    const stranger = await connect();
    expect((await stranger.hello('Mallory', 'A'.repeat(32))).resumed).toBe(false);
  });

  it('resumes a paused match within the grace period', async () => {
    const a = await connect();
    const wa = await a.hello('Alice');
    const b = await connect('Bob');
    a.send({ t: 'queue' });
    await a.next('waiting');
    b.send({ t: 'queue' });
    await Promise.all([a.next('matched'), b.next('matched')]);

    a.ws.terminate();
    expect((await b.next('paused')).who).toBe(0);

    const a2 = await connect();
    expect((await a2.hello('Alice', wa.token as string)).resumed).toBe(true);
    expect((await a2.next('matched')).side).toBe(0); // back in the same seat
    await Promise.all([a2.next('resumed'), b.next('resumed')]);
    expect(server.metrics.reconnects.get()).toBeTruthy();
  });

  it('accepts inputs from a reconnected client whose sequence numbers start again', async () => {
    const a = await connect();
    const wa = await a.hello('Alice');
    const b = await connect('Bob');
    a.send({ t: 'queue' });
    await a.next('waiting');
    b.send({ t: 'queue' });
    await Promise.all([a.next('matched'), b.next('matched')]);
    for (let i = 0; i < 40; i++) {
      a.input(1);
      await new Promise((r) => setTimeout(r, 1000 / 60));
    }
    await a.next('state', (m) => (m.ack as number) >= 40);
    a.ws.terminate();

    // A reloaded page: new socket, same token, sequence numbers from 1
    const a2 = await connect();
    await a2.hello('Alice', wa.token as string);
    await a2.next('resumed');
    const before = await a2.next('state');
    for (let i = 0; i < 20; i++) {
      a2.input(-1);
      await new Promise((r) => setTimeout(r, 1000 / 60));
    }
    const after = await a2.next('state', (m) => (m.ack as number) >= 20);
    expect((after.p as number[])[0]).toBeLessThan((before.p as number[])[0]!);
  });

  it('awards the match to the opponent when the grace period runs out', async () => {
    const { a, b } = await matchTwo();
    a.ws.terminate();
    await b.next('paused');
    expect(await b.next('over')).toMatchObject({ winner: 1, reason: 'forfeit' });
  });

  it('cleans up rooms when everyone has gone', async () => {
    const { a, b } = await matchTwo();
    expect(server.lobby.stats.rooms).toBe(1);
    a.send({ t: 'leave' });
    expect(await b.next('over')).toMatchObject({ winner: 1, reason: 'left' });
    b.send({ t: 'leave' });
    await new Promise((r) => setTimeout(r, 100));
    expect(server.lobby.stats.rooms).toBe(0);
  });
});

describe('abuse', () => {
  it('rejects malformed messages without crashing, and requires hello first', async () => {
    const c = await connect();
    c.ws.send('not json');
    expect((await c.next('error')).code).toBe('bad_message');
    c.send({ t: 'queue' });
    expect((await c.next('error')).code).toBe('hello_first');
    await c.hello('Fine'); // the connection still works
  });

  it('closes connections that flood the server', async () => {
    await server.close();
    await start({ messageRate: 20, messageBurst: 20, maxStrikes: 10 });
    const c = await connect('Flood');
    for (let i = 0; i < 200; i++) c.send({ t: 'ping', c: i });
    expect(await c.closedWith()).toBe(1008);
  });

  it('closes connections that send oversized frames', async () => {
    const c = await connect('Big');
    c.ws.send('x'.repeat(10_000));
    expect(await c.closedWith()).toBe(1009);
  });

  it('drops connections that stop answering heartbeats', async () => {
    await server.close();
    await start({ heartbeatMs: 100 });
    const c = await connect('Ghost');
    c.ws.pong = () => {}; // the client stops answering pings, like a half-open TCP connection
    expect(await c.closedWith()).toBe(1006);
  });
});

describe('leaderboard', () => {
  // Shorter thresholds so a test match can end by leaving instead of playing to 5
  const quick = { minDurationMs: 0, minMoves: 0, pairDailyLimit: 3, initialRating: 1200, kFactor: 32, minGamesListed: 1 };

  async function rankedPair(ipA: string, ipB: string, keys = [newKey(), newKey()]) {
    const a = await connect('Alice', { key: keys[0], ip: ipA });
    const b = await connect('Bob', { key: keys[1], ip: ipB });
    a.send({ t: 'queue' });
    await a.next('waiting');
    b.send({ t: 'queue' });
    await Promise.all([a.next('matched'), b.next('matched')]);
    return { a, b, keys };
  }

  it('rates a quick match from the server’s own result and lists the players', async () => {
    await server.close();
    await start({ clientIpHeader: 'x-client-ip', rules: quick });
    const { a, b, keys } = await rankedPair('203.0.113.1', '198.51.100.7');
    expect(await a.next('profile')).toMatchObject({ rating: 1200, games: 0, rank: null });

    b.send({ t: 'leave' }); // Bob concedes: Alice wins
    expect(await a.next('over')).toMatchObject({ winner: 0, reason: 'left' });
    expect(await a.next('rated')).toMatchObject({ rated: true, delta: 16, rating: 1216 });
    expect(await b.next('rated')).toMatchObject({ rated: true, delta: -16, rating: 1184 });
    expect(await a.next('profile', (m) => m.games === 1)).toMatchObject({ rating: 1216, wins: 1, rank: 1 });

    expect(await server.metrics.clientIpSource.get()).toMatchObject({ values: [expect.objectContaining({ labels: { source: 'header' }, value: 2 })] });
    const res = await fetch(url.replace('ws://', 'http://').replace('/ws', '/api/leaderboard'));
    const body = await res.json();
    expect(body.persistent).toBe(false);
    expect(body.players).toEqual([
      { name: 'Alice', rating: 1216, games: 1, wins: 1, losses: 0, rank: 1 },
      { name: 'Bob', rating: 1184, games: 1, wins: 0, losses: 1, rank: 2 },
    ]);
    expect(body.recent).toEqual([expect.objectContaining({ names: ['Alice', 'Bob'], rated: true, deltas: [16, -16], mode: 'ranked' })]);
    expect(JSON.stringify(body)).not.toContain(keys[0]); // neither keys nor ids are exposed
  });

  it('does not rate two players on the same network, a private room, or a guest', async () => {
    await server.close();
    await start({ clientIpHeader: 'x-client-ip', rules: quick });

    const same = await rankedPair('203.0.113.1', '203.0.113.1');
    same.b.send({ t: 'leave' });
    expect(await same.a.next('rated')).toMatchObject({ rated: false, delta: 0, reason: expect.stringMatching(/same network/) });

    const host = await connect('Host', { key: newKey(), ip: '203.0.113.9' });
    const guest = await connect('Guest', { key: newKey(), ip: '198.51.100.9' });
    host.send({ t: 'create' });
    const { code } = await host.next('waiting');
    guest.send({ t: 'join', code });
    await host.next('matched');
    guest.send({ t: 'leave' });
    expect(await host.next('rated')).toMatchObject({ rated: false, reason: expect.stringMatching(/Private/) });

    const keyed = await connect('Keyed', { key: newKey(), ip: '203.0.113.20' });
    const anon = await connect('Anon', { ip: '198.51.100.20' });
    keyed.send({ t: 'queue' });
    await keyed.next('waiting');
    anon.send({ t: 'queue' });
    await keyed.next('matched');
    anon.send({ t: 'leave' });
    expect(await keyed.next('rated')).toMatchObject({ rated: false, reason: expect.stringMatching(/Guests/) });
  });

  it('uses the default rules: a match abandoned at once is unrated, so nobody can gift wins', async () => {
    await server.close();
    await start({ clientIpHeader: 'x-client-ip' });
    const { a, b } = await rankedPair('203.0.113.1', '198.51.100.7');
    b.send({ t: 'leave' });
    expect(await a.next('rated')).toMatchObject({ rated: false, reason: expect.stringMatching(/within 10 s/) });
  });

  it('ignores client IP headers unless told which one a trusted proxy sets', async () => {
    // Default config: both test clients really come from 127.0.0.1, whatever header they send
    await server.close();
    await start({ rules: quick });
    const { a, b } = await rankedPair('203.0.113.1', '198.51.100.7');
    b.send({ t: 'leave' });
    expect(await a.next('rated')).toMatchObject({ rated: false, reason: expect.stringMatching(/same network/) });
  });
});
