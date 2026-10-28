/**
 * Deterministic game simulation, shared by the server (authoritative) and the client (prediction).
 *
 * The server is the only source of truth: clients send which way they want their paddle to move
 * (-1, 0 or 1), never positions, so a modified client cannot teleport its paddle or move the ball.
 * The same `step` runs on the client so it can predict its own paddle between server snapshots.
 */

export const FIELD = { width: 800, height: 500 } as const;
export const PADDLE = { width: 12, height: 90, inset: 24, speed: 420 } as const; // speed in units/s
export const BALL = { radius: 8, serveSpeed: 360, maxSpeed: 900, speedUp: 1.06, maxBounceAngle: Math.PI / 3 } as const;
export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;
export const POINTS_TO_WIN = 5;
export const SERVE_DELAY_TICKS = TICK_RATE; // 1 s countdown before each serve

export type Dir = -1 | 0 | 1;
export type Phase = 'countdown' | 'playing' | 'paused' | 'over';

export interface Ball {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export interface GameState {
  tick: number;
  phase: Phase;
  countdown: number; // ticks until the next serve
  ball: Ball;
  paddles: [number, number]; // centre y of the left and right paddle
  score: [number, number];
  winner: -1 | 0 | 1;
  serveTo: 0 | 1; // the side the next serve travels towards
  rng: number; // seed for serve angles, so a match replays identically
}

export function newGame(seed = 1): GameState {
  return {
    tick: 0,
    phase: 'countdown',
    countdown: SERVE_DELAY_TICKS,
    ball: { x: FIELD.width / 2, y: FIELD.height / 2, vx: 0, vy: 0 },
    paddles: [FIELD.height / 2, FIELD.height / 2],
    score: [0, 0],
    winner: -1,
    serveTo: seed % 2 === 0 ? 0 : 1,
    rng: seed >>> 0 || 1,
  };
}

/** xorshift32: tiny, fast and deterministic across platforms. */
function nextRandom(state: GameState): number {
  let x = state.rng;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  state.rng = x >>> 0;
  return state.rng / 0xffffffff;
}

export function clampPaddle(y: number): number {
  const half = PADDLE.height / 2;
  return Math.min(FIELD.height - half, Math.max(half, y));
}

/** Moves one paddle for one tick. Shared with client-side prediction. */
export function movePaddle(y: number, dir: Dir): number {
  return clampPaddle(y + dir * PADDLE.speed * DT);
}

export function paddleX(side: 0 | 1): number {
  return side === 0 ? PADDLE.inset + PADDLE.width / 2 : FIELD.width - PADDLE.inset - PADDLE.width / 2;
}

export type GameEvent = { kind: 'serve' } | { kind: 'hit'; side: 0 | 1 } | { kind: 'goal'; scorer: 0 | 1 } | { kind: 'over'; winner: 0 | 1 };

function serve(state: GameState) {
  const angle = (nextRandom(state) - 0.5) * (Math.PI / 3.6); // within ±25°
  const dir = state.serveTo === 0 ? -1 : 1;
  state.ball = {
    x: FIELD.width / 2,
    y: FIELD.height / 2,
    vx: dir * BALL.serveSpeed * Math.cos(angle),
    vy: BALL.serveSpeed * Math.sin(angle),
  };
}

/** Advances the game by one fixed tick. Mutates `state` and returns what happened. */
export function step(state: GameState, inputs: readonly [Dir, Dir]): GameEvent[] {
  const events: GameEvent[] = [];
  if (state.phase === 'paused' || state.phase === 'over') return events;
  state.tick++;
  state.paddles = [movePaddle(state.paddles[0], inputs[0]), movePaddle(state.paddles[1], inputs[1])];

  if (state.phase === 'countdown') {
    if (--state.countdown <= 0) {
      state.phase = 'playing';
      serve(state);
      events.push({ kind: 'serve' });
    }
    return events;
  }

  const b = state.ball;
  const prevX = b.x;
  b.x += b.vx * DT;
  b.y += b.vy * DT;

  // Walls
  if (b.y < BALL.radius) {
    b.y = 2 * BALL.radius - b.y;
    b.vy = Math.abs(b.vy);
  } else if (b.y > FIELD.height - BALL.radius) {
    b.y = 2 * (FIELD.height - BALL.radius) - b.y;
    b.vy = -Math.abs(b.vy);
  }

  // Paddles: swept test against the paddle face so a fast ball cannot pass through it
  for (const side of [0, 1] as const) {
    const movingTowards = side === 0 ? b.vx < 0 : b.vx > 0;
    if (!movingTowards) continue;
    const face = side === 0 ? paddleX(0) + PADDLE.width / 2 + BALL.radius : paddleX(1) - PADDLE.width / 2 - BALL.radius;
    const crossed = side === 0 ? prevX >= face && b.x <= face : prevX <= face && b.x >= face;
    if (!crossed) continue;
    const offset = (b.y - state.paddles[side]) / (PADDLE.height / 2 + BALL.radius);
    if (Math.abs(offset) > 1) continue; // missed

    // Where on the paddle it hit decides the outgoing angle; each hit is a little faster
    const speed = Math.min(BALL.maxSpeed, Math.hypot(b.vx, b.vy) * BALL.speedUp);
    const angle = offset * BALL.maxBounceAngle;
    b.vx = (side === 0 ? 1 : -1) * speed * Math.cos(angle);
    b.vy = speed * Math.sin(angle);
    b.x = face + (face - b.x); // reflect the overshoot
    events.push({ kind: 'hit', side });
  }

  // Goals
  const scorer = b.x < 0 ? 1 : b.x > FIELD.width ? 0 : -1;
  if (scorer !== -1) {
    state.score[scorer]++;
    events.push({ kind: 'goal', scorer });
    if (state.score[scorer] >= POINTS_TO_WIN) {
      state.phase = 'over';
      state.winner = scorer;
      events.push({ kind: 'over', winner: scorer });
    } else {
      state.phase = 'countdown';
      state.countdown = SERVE_DELAY_TICKS;
      state.serveTo = scorer === 0 ? 1 : 0; // serve towards the player who conceded
      state.ball = { x: FIELD.width / 2, y: FIELD.height / 2, vx: 0, vy: 0 };
    }
  }
  return events;
}

export function cloneState(s: GameState): GameState {
  return { ...s, ball: { ...s.ball }, paddles: [...s.paddles], score: [...s.score] };
}
