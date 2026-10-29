import pg from 'pg';
import { decide, type MatchRecord, type Outcome, type Rules } from './rules';

export interface PlayerStats {
  id: string;
  name: string;
  rating: number;
  games: number;
  wins: number;
  losses: number;
}

/** A finished match as the public sees it: who played, the score, and whether it counted */
export interface RecentMatch {
  names: [string, string];
  score: [number, number];
  winner: 0 | 1;
  /** How it ended: by score, or by the loser leaving or not coming back */
  ended: 'score' | 'forfeit' | 'left';
  mode: string;
  rated: boolean;
  reason: string | null;
  deltas: [number, number];
  endedAt: string;
}

export interface Recorded extends Outcome {
  /** The match had already been recorded; the stored outcome is returned unchanged */
  duplicate: boolean;
  /** Ratings after the match, per side (null for the bot or a guest) */
  ratings: [number | null, number | null];
}

/**
 * Persistence for ratings. record() is atomic and idempotent: the match row and both rating updates
 * commit together, and recording the same match id again changes nothing.
 */
export interface Store {
  readonly persistent: boolean;
  init(): Promise<void>;
  record(m: MatchRecord, rules: Rules): Promise<Recorded>;
  top(limit: number, minGames: number): Promise<(PlayerStats & { rank: number })[]>;
  player(id: string, minGames: number): Promise<(PlayerStats & { rank: number | null }) | null>;
  recent(limit: number): Promise<RecentMatch[]>;
  close(): Promise<void>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const pairKey = (a: string, b: string) => (a < b ? `${a}:${b}` : `${b}:${a}`);

/** In-process store for development and tests, or when no database is configured. */
export class MemoryStore implements Store {
  readonly persistent = false;
  private players = new Map<string, PlayerStats>();
  private matches = new Map<string, { record: MatchRecord; outcome: Recorded }>();

  async init() {}
  async close() {}

  async record(m: MatchRecord, rules: Rules): Promise<Recorded> {
    const seen = this.matches.get(m.id);
    if (seen) return { ...seen.outcome, duplicate: true };
    const players = m.sides.map((s) => {
      if (!s.playerId) return null;
      const p = this.players.get(s.playerId) ?? { id: s.playerId, name: s.name, rating: rules.initialRating, games: 0, wins: 0, losses: 0 };
      p.name = s.name;
      this.players.set(p.id, p);
      return p;
    }) as [PlayerStats | null, PlayerStats | null];

    const [a, b] = players;
    let pairGames = 0;
    if (a && b) {
      const key = pairKey(a.id, b.id);
      for (const { record, outcome } of this.matches.values()) {
        const [x, y] = record.sides;
        if (outcome.rated && x.playerId && y.playerId && pairKey(x.playerId, y.playerId) === key && record.endedAt > m.endedAt - DAY_MS) pairGames++;
      }
    }
    const outcome = decide(m, pairGames, [a?.rating ?? rules.initialRating, b?.rating ?? rules.initialRating], rules);
    if (outcome.rated) {
      players.forEach((p, side) => {
        p!.rating += outcome.deltas[side]!;
        p!.games++;
        if (side === m.winner) p!.wins++;
        else p!.losses++;
      });
    }
    const recorded: Recorded = { ...outcome, duplicate: false, ratings: [a?.rating ?? null, b?.rating ?? null] };
    this.matches.set(m.id, { record: m, outcome: recorded });
    return recorded;
  }

  private ranked(minGames: number) {
    return [...this.players.values()].filter((p) => p.games >= minGames).sort((x, y) => y.rating - x.rating || x.name.localeCompare(y.name));
  }

  async top(limit: number, minGames: number) {
    const all = this.ranked(minGames);
    // Same as SQL rank(): tied ratings share a rank
    return all.slice(0, limit).map((p) => ({ ...p, rank: all.findIndex((q) => q.rating === p.rating) + 1 }));
  }

  async recent(limit: number): Promise<RecentMatch[]> {
    return [...this.matches.values()]
      .slice(-limit)
      .reverse()
      .map(({ record: m, outcome: o }) => ({
        names: [m.sides[0].name, m.sides[1].name],
        score: m.score,
        winner: m.winner,
        ended: m.reason,
        mode: m.mode,
        rated: o.rated,
        reason: o.reason ?? null,
        deltas: o.deltas,
        endedAt: new Date(m.endedAt).toISOString(),
      }));
  }

  async player(id: string, minGames: number) {
    const p = this.players.get(id);
    if (!p) return null;
    const listed = p.games >= minGames;
    return { ...p, rank: listed ? this.ranked(minGames).filter((q) => q.rating > p.rating).length + 1 : null };
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS players (
  id         text PRIMARY KEY,
  name       text NOT NULL,
  rating     integer NOT NULL,
  games      integer NOT NULL DEFAULT 0,
  wins       integer NOT NULL DEFAULT 0,
  losses     integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS players_rating_idx ON players (rating DESC, name);

-- Every finished match with an identified player, rated or not, as an audit trail
CREATE TABLE IF NOT EXISTS matches (
  id             text PRIMARY KEY,
  mode           text NOT NULL,
  p0             text REFERENCES players (id),
  p1             text REFERENCES players (id),
  name0          text NOT NULL,
  name1          text NOT NULL,
  winner         smallint NOT NULL,
  reason         text NOT NULL,
  score0         smallint NOT NULL,
  score1         smallint NOT NULL,
  duration_ms    integer NOT NULL,
  rated          boolean NOT NULL,
  unrated_reason text,
  delta0         integer NOT NULL DEFAULT 0,
  delta1         integer NOT NULL DEFAULT 0,
  rating0        integer,
  rating1        integer,
  ended_at       timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS matches_ended_idx ON matches (ended_at DESC);
CREATE INDEX IF NOT EXISTS matches_pair_idx ON matches (LEAST(p0, p1), GREATEST(p0, p1), ended_at) WHERE rated;
`;

export class PgStore implements Store {
  readonly persistent = true;
  private pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 4, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000 });
    // An idle client losing its connection (e.g. the database restarting) must not crash the game server
    this.pool.on('error', (err) => console.error(JSON.stringify({ msg: 'database pool error', error: err.message })));
  }

  async init() {
    await this.pool.query(SCHEMA);
  }

  async close() {
    await this.pool.end();
  }

  async record(m: MatchRecord, rules: Rules): Promise<Recorded> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Concurrency: the upserts lock both player rows until commit, in id order so that two matches
      // between the same players queue up instead of deadlocking. The second one then reads the first
      // one's committed rating and pair count (a test with the locks removed rates too many games).
      for (const s of [...m.sides].sort((x, y) => (x.playerId ?? '').localeCompare(y.playerId ?? ''))) {
        if (!s.playerId) continue;
        await client.query(
          `INSERT INTO players (id, name, rating) VALUES ($1, $2, $3)
           ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, updated_at = now()`,
          [s.playerId, s.name, rules.initialRating],
        );
      }
      const [a, b] = m.sides;
      const inserted = await client.query(
        `INSERT INTO matches (id, mode, p0, p1, name0, name1, winner, reason, score0, score1, duration_ms, rated, ended_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, false, to_timestamp($12 / 1000.0))
         ON CONFLICT (id) DO NOTHING RETURNING id`,
        [m.id, m.mode, a.playerId, b.playerId, a.name, b.name, m.winner, m.reason, m.score[0], m.score[1], m.durationMs, m.endedAt],
      );
      if (inserted.rowCount === 0) {
        await client.query('ROLLBACK');
        const { rows } = await client.query('SELECT * FROM matches WHERE id = $1', [m.id]);
        const r = rows[0];
        return {
          duplicate: true,
          rated: r.rated,
          ...(r.unrated_reason ? { reason: r.unrated_reason } : {}),
          deltas: [r.delta0, r.delta1],
          ratings: [r.rating0, r.rating1],
        };
      }

      // Already locked by the upserts; FOR UPDATE states the dependency and reads the current ratings
      const ids = [a.playerId, b.playerId].filter((id): id is string => !!id);
      const locked = ids.length
        ? (await client.query('SELECT id, rating FROM players WHERE id = ANY($1) ORDER BY id FOR UPDATE', [ids])).rows
        : [];
      const ratingOf = (id: string | null) => (id ? (locked.find((r) => r.id === id)?.rating as number) : rules.initialRating);
      let pairGames = 0;
      if (a.playerId && b.playerId && a.playerId !== b.playerId) {
        const { rows } = await client.query(
          `SELECT count(*)::int AS n FROM matches
           WHERE rated AND LEAST(p0, p1) = LEAST($1, $2) AND GREATEST(p0, p1) = GREATEST($1, $2)
             AND ended_at > to_timestamp($3 / 1000.0) - interval '24 hours'`,
          [a.playerId, b.playerId, m.endedAt],
        );
        pairGames = rows[0].n;
      }

      const outcome = decide(m, pairGames, [ratingOf(a.playerId), ratingOf(b.playerId)], rules);
      if (outcome.rated) {
        for (const side of [0, 1] as const) {
          const won = side === m.winner;
          await client.query(
            `UPDATE players SET rating = rating + $2, games = games + 1, wins = wins + $3, losses = losses + $4, updated_at = now()
             WHERE id = $1`,
            [m.sides[side].playerId, outcome.deltas[side], won ? 1 : 0, won ? 0 : 1],
          );
        }
      }
      const after = (id: string | null, side: 0 | 1) => (id ? ratingOf(id) + outcome.deltas[side] : null);
      const ratings: [number | null, number | null] = [after(a.playerId, 0), after(b.playerId, 1)];
      await client.query(
        `UPDATE matches SET rated = $2, unrated_reason = $3, delta0 = $4, delta1 = $5, rating0 = $6, rating1 = $7 WHERE id = $1`,
        [m.id, outcome.rated, outcome.reason ?? null, outcome.deltas[0], outcome.deltas[1], ratings[0], ratings[1]],
      );
      await client.query('COMMIT');
      return { ...outcome, duplicate: false, ratings };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async top(limit: number, minGames: number) {
    const { rows } = await this.pool.query(
      `SELECT id, name, rating, games, wins, losses, rank() OVER (ORDER BY rating DESC)::int AS rank
       FROM players WHERE games >= $2 ORDER BY rating DESC, name LIMIT $1`,
      [limit, minGames],
    );
    return rows;
  }

  async recent(limit: number): Promise<RecentMatch[]> {
    const { rows } = await this.pool.query(
      `SELECT name0, name1, score0, score1, winner, reason, mode, rated, unrated_reason, delta0, delta1, ended_at
       FROM matches ORDER BY ended_at DESC LIMIT $1`,
      [limit],
    );
    return rows.map((r) => ({
      names: [r.name0, r.name1],
      score: [r.score0, r.score1],
      winner: r.winner,
      ended: r.reason,
      mode: r.mode,
      rated: r.rated,
      reason: r.unrated_reason,
      deltas: [r.delta0, r.delta1],
      endedAt: (r.ended_at as Date).toISOString(),
    }));
  }

  async player(id: string, minGames: number) {
    const { rows } = await this.pool.query(
      `SELECT id, name, rating, games, wins, losses,
              CASE WHEN games >= $2 THEN (SELECT count(*)::int + 1 FROM players q WHERE q.games >= $2 AND q.rating > p.rating) END AS rank
       FROM players p WHERE id = $1`,
      [id, minGames],
    );
    return rows[0] ?? null;
  }
}
