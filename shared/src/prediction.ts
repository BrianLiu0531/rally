/**
 * Client-side netcode, kept free of DOM and socket code so it can be unit tested.
 *
 * - Prediction: the local paddle moves immediately, using the same `movePaddle` as the server.
 *   Each input carries a sequence number; snapshots say which seq the server applied last (`ack`).
 *   On a snapshot the predictor snaps to the server's position and re-applies the inputs the server
 *   has not processed yet, so the paddle never rubber-bands unless the client really was wrong.
 * - Interpolation: the ball and the opponent are drawn slightly in the past (INTERP_DELAY_MS),
 *   between the two snapshots around that moment, which hides network jitter.
 */
import { movePaddle, type Dir } from './physics';

export class Predictor {
  private pending: { seq: number; dir: Dir }[] = [];
  private seq = 0;
  y: number;
  /** Distance the last reconciliation moved the paddle (0 when the prediction was right). */
  lastCorrection = 0;

  constructor(y: number) {
    this.y = y;
  }

  /** Applies a local input for one tick and returns the message to send. */
  input(dir: Dir): { seq: number; dir: Dir } {
    const msg = { seq: ++this.seq, dir };
    this.pending.push(msg);
    if (this.pending.length > 120) this.pending.shift(); // 2 s; anything older is long acknowledged
    this.y = movePaddle(this.y, dir);
    return msg;
  }

  /** Reconciles with an authoritative snapshot. */
  reconcile(serverY: number, ack: number) {
    this.pending = this.pending.filter((p) => p.seq > ack);
    let y = serverY;
    for (const p of this.pending) y = movePaddle(y, p.dir);
    this.lastCorrection = Math.abs(y - this.y);
    this.y = y;
  }

  /** Inputs sent but not yet applied by the server. */
  get unacknowledged(): number {
    return this.pending.length;
  }

  /** New position (a new match or a reconnect). The sequence counter keeps increasing on purpose. */
  reset(y: number) {
    this.pending = [];
    this.y = y;
  }
}

export const INTERP_DELAY_MS = 100;

export interface Sample {
  at: number; // receive time (ms)
  ball: [number, number];
  paddles: [number, number];
}

export class Interpolator {
  private samples: Sample[] = [];

  push(s: Sample) {
    this.samples.push(s);
    if (this.samples.length > 40) this.samples.shift();
  }

  clear() {
    this.samples = [];
  }

  /** The interpolated state INTERP_DELAY_MS before `now`, or the newest sample if there is no pair. */
  at(now: number, delay = INTERP_DELAY_MS): Sample | undefined {
    const target = now - delay;
    const s = this.samples;
    for (let i = s.length - 1; i > 0; i--) {
      const a = s[i - 1]!;
      const b = s[i]!;
      if (a.at <= target && target <= b.at) {
        const k = b.at === a.at ? 1 : (target - a.at) / (b.at - a.at);
        const lerp = (x: number, y: number) => x + (y - x) * k;
        return {
          at: target,
          ball: [lerp(a.ball[0], b.ball[0]), lerp(a.ball[1], b.ball[1])],
          paddles: [lerp(a.paddles[0], b.paddles[0]), lerp(a.paddles[1], b.paddles[1])],
        };
      }
    }
    return s[s.length - 1];
  }
}
