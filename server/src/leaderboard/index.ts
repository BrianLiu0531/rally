import { createHash } from 'node:crypto';
import type { Metrics } from '../metrics';
import { DEFAULT_RULES, type MatchRecord, type Rules } from './rules';
import { MemoryStore, PgStore, type PlayerStats, type RecentMatch, type Recorded, type Store } from './store';

export { DEFAULT_RULES, type MatchRecord, type Rules } from './rules';
export { MemoryStore, PgStore, type Store } from './store';

/** The player id is a hash of the client's secret key, so the database never holds the key itself. */
export const playerIdFromKey = (key: string) => createHash('sha256').update(key).digest('hex').slice(0, 32);
export const networkId = (ip: string) => createHash('sha256').update(`rally:${ip}`).digest('hex').slice(0, 16);

const RETRY_DELAYS_MS = [500, 2000, 8000];
const TOP_CACHE_MS = 5000;

/**
 * Records finished matches off the game loop. Recording is idempotent per match id, so retrying
 * after a timeout or a dropped connection can never count a match twice.
 */
export class Leaderboard {
  private cache: { at: number; players: Awaited<ReturnType<Store['top']>>; recent: RecentMatch[] } | null = null;

  constructor(
    readonly store: Store,
    readonly rules: Rules,
    private readonly metrics: Metrics,
    private readonly retryDelays = RETRY_DELAYS_MS,
  ) {}

  static create(databaseUrl: string | undefined, rules: Rules, metrics: Metrics) {
    return new Leaderboard(databaseUrl ? new PgStore(databaseUrl) : new MemoryStore(), rules, metrics);
  }

  /** Resolves with the outcome, or null if the database stayed unavailable. Never rejects. */
  async record(m: MatchRecord): Promise<Recorded | null> {
    if (!m.sides[0].playerId && !m.sides[1].playerId) return null; // nobody to rate
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await this.store.record(m, this.rules);
        this.metrics.recordedMatches.inc({ result: r.duplicate ? 'duplicate' : r.rated ? 'rated' : 'unrated' });
        if (!r.duplicate) this.cache = null;
        return r;
      } catch (err) {
        const delay = this.retryDelays[attempt];
        console.error(JSON.stringify({ msg: 'recording match failed', match: m.id, attempt, error: (err as Error).message }));
        if (delay === undefined) {
          this.metrics.recordedMatches.inc({ result: 'failed' });
          return null;
        }
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  /** Top players and the latest matches, cached briefly so page views don't hit the database */
  async board(limit = 20) {
    const now = Date.now();
    if (!this.cache || now - this.cache.at > TOP_CACHE_MS) {
      const [players, recent] = await Promise.all([this.store.top(limit, this.rules.minGamesListed), this.store.recent(10)]);
      this.cache = { at: now, players, recent };
    }
    return { players: this.cache.players.map(({ id: _id, ...row }) => row), recent: this.cache.recent };
  }

  async profile(playerId: string): Promise<(PlayerStats & { rank: number | null }) | null> {
    return this.store.player(playerId, this.rules.minGamesListed);
  }
}

export function rulesFromEnv(env: NodeJS.ProcessEnv): Rules {
  const int = (v: string | undefined, d: number) => (v ? Number.parseInt(v, 10) : d);
  return {
    initialRating: DEFAULT_RULES.initialRating,
    kFactor: DEFAULT_RULES.kFactor,
    minDurationMs: int(env.RATED_MIN_DURATION_MS, DEFAULT_RULES.minDurationMs),
    minMoves: int(env.RATED_MIN_MOVES, DEFAULT_RULES.minMoves),
    pairDailyLimit: int(env.RATED_PAIR_DAILY_LIMIT, DEFAULT_RULES.pairDailyLimit),
    minGamesListed: DEFAULT_RULES.minGamesListed,
  };
}
