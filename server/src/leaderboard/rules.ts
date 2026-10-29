/**
 * Ranking rules, kept pure so they can be tested without a database.
 *
 * Scores are never submitted by clients: the server's own simulation produces every MatchRecord.
 * What these rules guard against is players gaming the rating with matches that are real but
 * meaningless, such as beating a second account, beating an opponent who never touched the
 * controls, or farming the same opponent.
 */

export type MatchMode = 'ranked' | 'private' | 'bot';

export interface SideRecord {
  /** sha256 of the player's secret key, or null for the bot or a guest without a key */
  playerId: string | null;
  name: string;
  /** Hash of the client IP, to spot one person playing both sides */
  network: string;
  /** Ticks in which the player moved their paddle */
  moves: number;
}

export interface MatchRecord {
  /** Unique per match (room id and match number), so recording it twice is harmless */
  id: string;
  mode: MatchMode;
  sides: [SideRecord, SideRecord];
  winner: 0 | 1;
  reason: 'score' | 'forfeit' | 'left';
  score: [number, number];
  durationMs: number;
  endedAt: number;
}

export interface Rules {
  initialRating: number;
  kFactor: number;
  /** Matches that end (by leaving or forfeit) sooner than this are unrated */
  minDurationMs: number;
  /** The loser must have moved at least this many ticks (half a second at 60 Hz) */
  minMoves: number;
  /** Rated games between the same two players per rolling 24 hours */
  pairDailyLimit: number;
  /** Rated games before a player appears on the leaderboard */
  minGamesListed: number;
}

export const DEFAULT_RULES: Rules = {
  initialRating: 1200,
  kFactor: 32,
  minDurationMs: 10_000,
  minMoves: 30,
  pairDailyLimit: 3,
  minGamesListed: 1,
};

export type Assessment = { rated: true } | { rated: false; reason: string };

/** Whether a match should change ratings. `pairGamesToday` counts earlier rated games between the two. */
export function assess(m: MatchRecord, pairGamesToday: number, rules: Rules): Assessment {
  const [a, b] = m.sides;
  if (m.mode === 'bot') return { rated: false, reason: 'Matches against the bot are unrated' };
  if (m.mode === 'private') return { rated: false, reason: 'Private matches are unrated' };
  if (!a.playerId || !b.playerId) return { rated: false, reason: 'Guests are unrated' };
  if (a.playerId === b.playerId) return { rated: false, reason: 'The same player was on both sides' };
  if (a.network === b.network) return { rated: false, reason: 'Both players were on the same network' };
  if (m.reason !== 'score' && m.durationMs < rules.minDurationMs) {
    return { rated: false, reason: `The match ended within ${Math.round(rules.minDurationMs / 1000)} s` };
  }
  if (m.sides[m.winner === 0 ? 1 : 0].moves < rules.minMoves) return { rated: false, reason: 'The losing player was inactive' };
  if (pairGamesToday >= rules.pairDailyLimit) {
    return { rated: false, reason: `Only ${rules.pairDailyLimit} rated games per day against the same opponent` };
  }
  return { rated: true };
}

/** Elo: the winner takes points from the loser, more for an upset. Always moves by at least 1. */
export function elo(winner: number, loser: number, k: number): number {
  const expected = 1 / (1 + 10 ** ((loser - winner) / 400));
  return Math.max(1, Math.round(k * (1 - expected)));
}

export interface Outcome {
  rated: boolean;
  reason?: string;
  /** Rating change per side (0 when unrated) */
  deltas: [number, number];
}

export function decide(m: MatchRecord, pairGamesToday: number, ratings: [number, number], rules: Rules): Outcome {
  const verdict = assess(m, pairGamesToday, rules);
  if (!verdict.rated) return { rated: false, reason: verdict.reason, deltas: [0, 0] };
  const w = m.winner;
  const gain = elo(ratings[w], ratings[w === 0 ? 1 : 0], rules.kFactor);
  return { rated: true, deltas: w === 0 ? [gain, -gain] : [-gain, gain] };
}
