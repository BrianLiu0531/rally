import {
  SNAPSHOT_EVERY_TICKS,
  encodeSnapshot,
  movePaddle,
  newGame,
  step,
  type Dir,
  type GameState,
  type Phase,
  type ServerMessage,
} from '@rally/shared';
import { Bot } from './bot';

/** A connected human as the room sees them. */
export interface Participant {
  readonly id: string;
  readonly name: string;
  /** `droppable` messages (snapshots) may be skipped for a slow connection. */
  send(msg: ServerMessage, droppable?: boolean): void;
}

interface Seat {
  player: Participant | null; // null for the bot, or after a human left
  bot: Bot | null;
  name: string;
  inputs: { seq: number; dir: Dir }[];
  lastSeq: number; // highest seq received, to drop duplicates and stale inputs
  ack: number; // seq of the last input applied
  droppedAt: number | null;
  left: boolean;
  rematch: boolean;
  /** Ticks this match in which the player moved, to tell a real opponent from an idle one */
  moves: number;
}

export type EndReason = 'score' | 'forfeit' | 'left';

export interface RoomOptions {
  graceMs: number;
  inputQueueMax: number;
  seed: number;
  onEnd?: (room: Room, reason: EndReason) => void;
  now?: () => number;
}

const RESUME_DELAY_MS = 1000;
const MAX_CATCH_UP = 2;

export class Room {
  state: GameState;
  readonly seats: [Seat, Seat];
  private ticks = 0;
  private resumeAt: number | null = null;
  private pausedFrom: Phase = 'countdown';
  private seed: number;
  /** Increments on every rematch; with the room id it identifies one match */
  matchNo = 1;
  startedAt: number;

  constructor(
    readonly id: string,
    a: Participant,
    b: Participant | 'bot',
    private readonly opts: RoomOptions,
  ) {
    this.seed = opts.seed;
    this.state = newGame(this.seed);
    this.startedAt = this.clock();
    const seat = (p: Participant | null, bot: Bot | null, name: string): Seat => ({
      player: p, bot, name, inputs: [], lastSeq: 0, ack: 0, droppedAt: null, left: false, rematch: bot !== null, moves: 0,
    });
    this.seats = [seat(a, null, a.name), b === 'bot' ? seat(null, new Bot(1, opts.seed), 'Rally Bot') : seat(b, null, b.name)];
    this.announce();
  }

  private clock(): number {
    return this.opts.now?.() ?? Date.now();
  }

  get hasBot(): boolean {
    return this.seats[1].bot !== null;
  }

  sideOf(id: string): 0 | 1 | -1 {
    return this.seats[0].player?.id === id ? 0 : this.seats[1].player?.id === id ? 1 : -1;
  }

  private names(): [string, string] {
    return [this.seats[0].name, this.seats[1].name];
  }

  private announce(only?: 0 | 1) {
    for (const side of [0, 1] as const) {
      if (only !== undefined && side !== only) continue;
      this.seats[side].player?.send({ t: 'matched', room: this.id, side, names: this.names(), bot: this.hasBot });
    }
  }

  private broadcast(msg: ServerMessage) {
    for (const s of this.seats) s.player?.send(msg);
  }

  private snapshot(side: 0 | 1, droppable = true) {
    const st = this.state;
    this.seats[side].player?.send(encodeSnapshot(st.tick, this.seats[side].ack, st.phase, st.countdown, st.ball, st.paddles, st.score), droppable);
  }

  /** Queues one tick of input. The queue is capped, so sending faster than 60 Hz gains nothing. */
  input(side: 0 | 1, seq: number, dir: Dir) {
    const seat = this.seats[side];
    if (seq <= seat.lastSeq) return; // duplicate or out of order
    seat.lastSeq = seq;
    if (seat.inputs.length >= this.opts.inputQueueMax) return;
    seat.inputs.push({ seq, dir });
  }

  tick(now: number) {
    this.ticks++;
    const st = this.state;

    if (st.phase === 'paused') {
      for (const side of [0, 1] as const) {
        const d = this.seats[side].droppedAt;
        if (d !== null && now - d >= this.opts.graceMs) return this.finish(side === 0 ? 1 : 0, 'forfeit');
      }
      if (this.resumeAt !== null && now >= this.resumeAt) {
        this.resumeAt = null;
        st.phase = this.pausedFrom;
        this.broadcast({ t: 'resumed' });
      }
      return;
    }

    // Apply exactly the inputs the client sent, each one tick of movement, so the client's prediction
    // (which applies the same inputs) agrees with the server. No input yet: the paddle waits. A backlog
    // after jitter drains at most MAX_CATCH_UP per tick, and the queue is capped, so there is no way to
    // move faster than PADDLE.speed for more than a few ticks.
    const dirs = this.seats.map((seat, i) => {
      const side = i as 0 | 1;
      if (seat.bot) return seat.bot.decide(st);
      const batch = seat.inputs.splice(0, seat.inputs.length > 2 ? MAX_CATCH_UP : 1);
      if (batch.length === 0) return 0;
      for (const extra of batch.slice(0, -1)) st.paddles[side] = movePaddle(st.paddles[side], extra.dir);
      const last = batch[batch.length - 1]!;
      seat.ack = last.seq;
      if (batch.some((b) => b.dir !== 0)) seat.moves++;
      return last.dir;
    }) as [Dir, Dir];

    for (const e of step(st, dirs)) {
      if (e.kind === 'over') {
        this.finish(e.winner, 'score');
        return;
      }
      if (e.kind === 'goal') this.broadcast({ t: 'event', kind: 'goal', side: e.scorer });
      else if (e.kind === 'hit') this.broadcast({ t: 'event', kind: 'hit', side: e.side });
      else this.broadcast({ t: 'event', kind: 'serve' });
    }
    if (this.ticks % SNAPSHOT_EVERY_TICKS === 0) {
      this.snapshot(0);
      this.snapshot(1);
    }
  }

  private finish(winner: 0 | 1, reason: EndReason) {
    const st = this.state;
    st.phase = 'over';
    st.winner = winner;
    this.resumeAt = null;
    this.snapshot(0, false);
    this.snapshot(1, false);
    this.broadcast({ t: 'over', winner, reason });
    this.opts.onEnd?.(this, reason);
  }

  disconnect(side: 0 | 1, now: number) {
    const seat = this.seats[side];
    seat.droppedAt = now;
    seat.inputs = [];
    const st = this.state;
    if (st.phase === 'countdown' || st.phase === 'playing') {
      this.pausedFrom = st.phase;
      st.phase = 'paused';
    }
    if (st.phase === 'paused') {
      this.resumeAt = null;
      this.seats[side === 0 ? 1 : 0].player?.send({ t: 'paused', who: side, graceMs: this.opts.graceMs });
    }
  }

  reconnect(side: 0 | 1, player: Participant, now: number) {
    const seat = this.seats[side];
    seat.player = player;
    seat.droppedAt = null;
    // A new socket starts a new sequence space (after a page reload the client counts from 1 again).
    // Keeping the old counter would discard every new input as a duplicate until it caught up.
    seat.lastSeq = 0;
    seat.ack = 0;
    this.announce(side);
    this.snapshot(side, false);
    const other = this.seats[side === 0 ? 1 : 0];
    if (this.state.phase === 'paused' && other.droppedAt === null) this.resumeAt = now + RESUME_DELAY_MS;
  }

  leave(side: 0 | 1) {
    const seat = this.seats[side];
    if (this.state.phase !== 'over') this.finish(side === 0 ? 1 : 0, 'left');
    seat.player = null;
    seat.left = true;
    seat.rematch = false;
    this.broadcast({ t: 'rematch', ready: [this.seats[0].rematch, this.seats[1].rematch] });
  }

  rematch(side: 0 | 1) {
    if (this.state.phase !== 'over') return;
    const other = this.seats[side === 0 ? 1 : 0];
    if (other.left) return;
    this.seats[side].rematch = true;
    this.broadcast({ t: 'rematch', ready: [this.seats[0].rematch, this.seats[1].rematch] });
    if (this.seats[0].rematch && this.seats[1].rematch) {
      this.state = newGame(++this.seed);
      this.matchNo++;
      this.startedAt = this.clock();
      for (const s of this.seats) {
        s.rematch = s.bot !== null;
        s.inputs = [];
        s.moves = 0;
      }
      this.announce();
    }
  }

  /** Nobody human is left, or the match is over and every human is gone. */
  get finished(): boolean {
    const humans = this.seats.filter((s) => !s.bot);
    return humans.every((s) => s.left || (this.state.phase === 'over' && s.droppedAt !== null));
  }
}
