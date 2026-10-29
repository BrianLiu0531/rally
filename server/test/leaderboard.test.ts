import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Leaderboard, MemoryStore, PgStore, type MatchRecord, type Store } from '../src/leaderboard';
import { DEFAULT_RULES, assess, decide, elo, type Rules } from '../src/leaderboard/rules';
import { createMetrics } from '../src/metrics';

const rules: Rules = { ...DEFAULT_RULES };
let n = 0;

function match(over: Partial<MatchRecord> = {}, sides: Partial<MatchRecord['sides'][0]>[] = []): MatchRecord {
  const base: MatchRecord = {
    id: `m${++n}`,
    mode: 'ranked',
    sides: [
      { playerId: 'alice', name: 'Alice', network: 'net-a', moves: 200 },
      { playerId: 'bob', name: 'Bob', network: 'net-b', moves: 200 },
    ],
    winner: 0,
    reason: 'score',
    score: [5, 3],
    durationMs: 60_000,
    endedAt: Date.now(),
    ...over,
  };
  sides.forEach((s, i) => Object.assign(base.sides[i]!, s));
  return base;
}

describe('rating rules', () => {
  it('rates a real match between two identified players', () => {
    expect(assess(match(), 0, rules)).toEqual({ rated: true });
  });

  it.each([
    ['bot matches', match({ mode: 'bot' }), /bot/],
    ['private matches', match({ mode: 'private' }), /Private/],
    ['guests', match({}, [{}, { playerId: null }]), /Guests/],
    ['the same player twice', match({}, [{}, { playerId: 'alice' }]), /same player/],
    ['two accounts on one network', match({}, [{}, { network: 'net-a' }]), /same network/],
    ['a quick leave', match({ reason: 'left', durationMs: 3000 }), /within 10 s/],
    ['a quick forfeit', match({ reason: 'forfeit', durationMs: 9000 }), /within 10 s/],
    ['beating an idle opponent', match({}, [{}, { moves: 5 }]), /inactive/],
  ])('does not rate %s', (_name, m, reason) => {
    const v = assess(m, 0, rules);
    expect(v.rated).toBe(false);
    expect(!v.rated && v.reason).toMatch(reason);
  });

  it('rates a leave after the minimum duration, so quitting a losing match still costs points', () => {
    expect(assess(match({ reason: 'left', durationMs: 30_000 }), 0, rules)).toEqual({ rated: true });
  });

  it('caps rated games against the same opponent per day', () => {
    expect(assess(match(), 2, rules).rated).toBe(true);
    expect(assess(match(), 3, rules).rated).toBe(false);
  });

  it('uses Elo: even players swap 16 points, an upset moves more, a mismatch at least 1', () => {
    expect(elo(1200, 1200, 32)).toBe(16);
    expect(elo(1000, 1400, 32)).toBe(29);
    expect(elo(3000, 100, 32)).toBe(1);
    const d = decide(match({ winner: 1 }), 0, [1300, 1200], rules);
    expect(d.deltas[0] + d.deltas[1]).toBe(0);
    expect(d.deltas[1]).toBe(elo(1200, 1300, 32));
  });
});

const pgUrl = process.env.RALLY_TEST_DATABASE_URL;
const stores: [string, () => Store][] = [['memory', () => new MemoryStore()]];
if (pgUrl) stores.push(['postgres', () => new PgStore(pgUrl)]);
else console.warn('RALLY_TEST_DATABASE_URL not set: Postgres store tests skipped');

describe.each(stores)('%s store', (kind, make) => {
  let store: Store;

  beforeAll(async () => {
    if (kind === 'postgres') {
      const c = new pg.Client({ connectionString: pgUrl });
      await c.connect();
      await c.query('DROP TABLE IF EXISTS matches; DROP TABLE IF EXISTS players;');
      await c.end();
    }
  });
  beforeEach(async () => {
    store = make();
    await store.init();
    if (kind === 'postgres') {
      const c = new pg.Client({ connectionString: pgUrl });
      await c.connect();
      await c.query('TRUNCATE matches, players');
      await c.end();
    }
  });
  afterAll(async () => store?.close());

  it('updates both ratings and records, and lists the leaderboard', async () => {
    const r = await store.record(match(), rules);
    expect(r).toMatchObject({ rated: true, duplicate: false, deltas: [16, -16], ratings: [1216, 1184] });
    expect(await store.top(10, 1)).toEqual([
      { id: 'alice', name: 'Alice', rating: 1216, games: 1, wins: 1, losses: 0, rank: 1 },
      { id: 'bob', name: 'Bob', rating: 1184, games: 1, wins: 0, losses: 1, rank: 2 },
    ]);
    expect(await store.player('bob', 1)).toMatchObject({ rating: 1184, rank: 2 });
  });

  it('counts a match once, however many times it is recorded', async () => {
    const m = match();
    const first = await store.record(m, rules);
    const again = await store.record(m, rules);
    const concurrent = await Promise.all([store.record(m, rules), store.record(m, rules)]);
    expect(again).toMatchObject({ duplicate: true, rated: true, deltas: first.deltas, ratings: first.ratings });
    expect(concurrent.every((r) => r.duplicate)).toBe(true);
    expect(await store.player('alice', 1)).toMatchObject({ rating: 1216, games: 1 });
  });

  it('stops rating the same pair after the daily limit, even when matches finish concurrently', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => store.record(match(), rules)));
    expect(results.filter((r) => r.rated)).toHaveLength(3);
    expect(results.find((r) => !r.rated)?.reason).toMatch(/3 rated games per day/);
    expect(await store.player('alice', 1)).toMatchObject({ games: 3, wins: 3 });
    // A different opponent is unaffected
    expect((await store.record(match({}, [{}, { playerId: 'carol', name: 'Carol', network: 'net-c' }]), rules)).rated).toBe(true);
  });

  it('keeps an unrated match out of the ratings, and players without rated games off the list', async () => {
    const r = await store.record(match({ mode: 'bot' }, [{}, { playerId: null, name: 'Rally Bot', network: 'bot' }]), rules);
    expect(r).toMatchObject({ rated: false, deltas: [0, 0], ratings: [1200, null] });
    expect(await store.top(10, 1)).toEqual([]);
    expect(await store.player('alice', 1)).toMatchObject({ games: 0, rank: null });
    expect(await store.player('nobody', 1)).toBeNull();
  });

  it('lists recent matches, newest first, with the reason an unrated one did not count', async () => {
    await store.record(match({ endedAt: Date.now() - 1000 }), rules);
    await store.record(match({ endedAt: Date.now(), winner: 1, score: [2, 5] }, [{}, { network: 'net-a' }]), rules);
    const recent = await store.recent(10);
    expect(recent).toHaveLength(2);
    expect(recent[0]).toMatchObject({ names: ['Alice', 'Bob'], score: [2, 5], winner: 1, rated: false, reason: expect.stringMatching(/same network/), deltas: [0, 0] });
    expect(recent[1]).toMatchObject({ rated: true, reason: null, deltas: [16, -16], ended: 'score' });
  });

  it('gives tied players the same rank', async () => {
    await store.record(match(), rules);
    await store.record(match({}, [{ playerId: 'carol', name: 'Carol', network: 'net-c' }, { playerId: 'dave', name: 'Dave', network: 'net-d' }]), rules);
    const top = await store.top(10, 1);
    expect(top.map((p) => [p.name, p.rank])).toEqual([['Alice', 1], ['Carol', 1], ['Bob', 3], ['Dave', 3]]);
  });
});

describe('Leaderboard service', () => {
  it('retries a failed write, and recording stays exactly-once', async () => {
    const inner = new MemoryStore();
    let failures = 2;
    const flaky: Store = Object.assign(Object.create(inner), {
      record: (m: MatchRecord, r: Rules) => (failures-- > 0 ? Promise.reject(new Error('connection reset')) : inner.record(m, r)),
    });
    const lb = new Leaderboard(flaky, rules, createMetrics(), [0, 0, 0]);
    const r = await lb.record(match());
    expect(r).toMatchObject({ rated: true, duplicate: false });
    expect((await inner.player('alice', 1))?.games).toBe(1);
  });

  it('gives up after the last retry without throwing', async () => {
    const down: Store = Object.assign(Object.create(new MemoryStore()), { record: () => Promise.reject(new Error('down')) });
    const metrics = createMetrics();
    const lb = new Leaderboard(down, rules, metrics, [0]);
    expect(await lb.record(match())).toBeNull();
    expect((await metrics.recordedMatches.get()).values.find((v) => v.labels.result === 'failed')?.value).toBe(1);
  });

  it('skips matches with nobody to rate', async () => {
    const lb = new Leaderboard(new MemoryStore(), rules, createMetrics());
    expect(await lb.record(match({ mode: 'bot' }, [{ playerId: null }, { playerId: null }]))).toBeNull();
  });
});
