import { FIELD, type Dir, type GameState } from '@rally/shared';

/**
 * A beatable opponent: it only tracks the ball while the ball is coming towards it, re-aims a few
 * times a second, and aims slightly off. It plays through the same input path as a human.
 */
export class Bot {
  private target: number = FIELD.height / 2;
  private aimError = 0;
  private rng: number;

  constructor(
    private readonly side: 0 | 1,
    seed = 7,
  ) {
    this.rng = seed;
  }

  private random() {
    this.rng = (this.rng * 1103515245 + 12345) & 0x7fffffff;
    return this.rng / 0x7fffffff;
  }

  decide(state: GameState): Dir {
    const { ball } = state;
    const coming = this.side === 0 ? ball.vx < 0 : ball.vx > 0;
    if (state.tick % 8 === 0) {
      if (coming) {
        this.aimError = (this.random() - 0.5) * 70;
        this.target = ball.y + this.aimError;
      } else {
        this.target = FIELD.height / 2;
      }
    }
    const y = state.paddles[this.side];
    if (Math.abs(this.target - y) < 10) return 0;
    return this.target > y ? 1 : -1;
  }
}
