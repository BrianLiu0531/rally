import { describe, expect, it } from 'vitest';
import {
  BALL,
  FIELD,
  Interpolator,
  PADDLE,
  POINTS_TO_WIN,
  Predictor,
  SERVE_DELAY_TICKS,
  cloneState,
  movePaddle,
  newGame,
  paddleX,
  parseClientMessage,
  step,
  type Dir,
  type GameState,
} from '../src';

function serveNow(s: GameState) {
  for (let i = 0; i < SERVE_DELAY_TICKS; i++) step(s, [0, 0]);
  expect(s.phase).toBe('playing');
}

describe('physics', () => {
  it('is deterministic: the same seed and inputs replay identically', () => {
    const inputs: [Dir, Dir][] = Array.from({ length: 3000 }, (_, i) => [((i >> 5) % 3) - 1, ((i >> 6) % 3) - 1] as [Dir, Dir]);
    const run = () => {
      const s = newGame(42);
      for (const i of inputs) step(s, i);
      return s;
    };
    expect(run()).toEqual(run());
  });

  it('keeps paddles inside the field', () => {
    let y = FIELD.height / 2;
    for (let i = 0; i < 1000; i++) y = movePaddle(y, 1);
    expect(y).toBe(FIELD.height - PADDLE.height / 2);
    for (let i = 0; i < 1000; i++) y = movePaddle(y, -1);
    expect(y).toBe(PADDLE.height / 2);
  });

  it('bounces off the walls', () => {
    const s = newGame(1);
    serveNow(s);
    s.ball = { x: 400, y: BALL.radius + 1, vx: 0, vy: -300 };
    step(s, [0, 0]);
    expect(s.ball.vy).toBeGreaterThan(0);
    expect(s.ball.y).toBeGreaterThanOrEqual(BALL.radius);
  });

  it('returns the ball from a paddle, faster, at an angle set by where it hit', () => {
    const s = newGame(1);
    serveNow(s);
    const face = paddleX(0) + PADDLE.width / 2 + BALL.radius;
    s.paddles[0] = 250;
    s.ball = { x: face + 3, y: 280, vx: -400, vy: 0 }; // hits below the centre
    const events = step(s, [0, 0]);
    expect(events).toContainEqual({ kind: 'hit', side: 0 });
    expect(s.ball.vx).toBeGreaterThan(0);
    expect(s.ball.vy).toBeGreaterThan(0);
    expect(Math.hypot(s.ball.vx, s.ball.vy)).toBeCloseTo(400 * BALL.speedUp, 5);
  });

  it('cannot tunnel through a paddle at maximum speed', () => {
    const s = newGame(1);
    serveNow(s);
    const face = paddleX(1) - PADDLE.width / 2 - BALL.radius;
    s.paddles[1] = 250;
    s.ball = { x: face - 1, y: 250, vx: BALL.maxSpeed, vy: 0 }; // moves 15 units this tick
    step(s, [0, 0]);
    expect(s.ball.vx).toBeLessThan(0);
  });

  it('scores, serves towards the player who conceded, and ends at the target score', () => {
    const s = newGame(1);
    serveNow(s);
    s.paddles[1] = 50;
    s.ball = { x: FIELD.width - 5, y: 450, vx: 600, vy: 0 };
    const events = step(s, [0, 0]);
    expect(events).toContainEqual({ kind: 'goal', scorer: 0 });
    expect(s.score).toEqual([1, 0]);
    expect(s.phase).toBe('countdown');
    expect(s.serveTo).toBe(1);

    s.score = [POINTS_TO_WIN - 1, 0];
    serveNow(s);
    s.ball = { x: FIELD.width - 5, y: 450, vx: 600, vy: 0 };
    expect(step(s, [0, 0])).toContainEqual({ kind: 'over', winner: 0 });
    expect(s.phase).toBe('over');
    const frozen = cloneState(s);
    step(s, [1, 1]);
    expect(s).toEqual(frozen); // nothing moves after the end
  });
});

describe('protocol', () => {
  it('accepts valid messages and normalises them', () => {
    expect(parseClientMessage('{"t":"input","seq":5,"dir":-1}')).toEqual({ t: 'input', seq: 5, dir: -1 });
    expect(parseClientMessage('{"t":"join","code":"ab2c"}')).toEqual({ t: 'join', code: 'AB2C' });
    expect(parseClientMessage('{"t":"hello","v":1,"name":"  Brian   L "}')).toEqual({ t: 'hello', v: 1, name: 'Brian L' });
    expect(parseClientMessage('{"t":"hello","v":1,"name":"<script>"}')).toEqual({ t: 'hello', v: 1, name: 'Player' });
  });

  it.each([
    ['not json', '{"t":'],
    ['array', '[1,2]'],
    ['unknown type', '{"t":"teleport","y":10}'],
    ['position instead of direction', '{"t":"input","seq":1,"dir":0.5}'],
    ['speed hack', '{"t":"input","seq":1,"dir":5}'],
    ['negative seq', '{"t":"input","seq":-1,"dir":1}'],
    ['bad code', '{"t":"join","code":"ABCDE"}'],
    ['old protocol', '{"t":"hello","v":0,"name":"x"}'],
    ['bad token', '{"t":"hello","v":1,"name":"x","token":"../.."}'],
    ['oversized', JSON.stringify({ t: 'ping', c: 1, pad: 'x'.repeat(600) })],
  ])('rejects %s', (_name, raw) => {
    expect(parseClientMessage(raw)).toBeNull();
  });
});

describe('prediction', () => {
  it('replays unacknowledged inputs on top of the server position', () => {
    const p = new Predictor(250);
    const sent = [p.input(1), p.input(1), p.input(1), p.input(-1)];
    const afterTwo = movePaddle(movePaddle(250, 1), 1); // the server has applied the first two
    p.reconcile(afterTwo, sent[1]!.seq);
    expect(p.unacknowledged).toBe(2);
    expect(p.y).toBeCloseTo(movePaddle(movePaddle(afterTwo, 1), -1), 6);
    expect(p.lastCorrection).toBeCloseTo(0, 6); // the prediction was right
  });

  it('keeps sequence numbers increasing across a reset', () => {
    const p = new Predictor(250);
    p.input(1);
    p.input(1);
    p.reset(250); // e.g. reconnected
    expect(p.input(0).seq).toBe(3);
    expect(p.unacknowledged).toBe(1);
  });

  it('corrects towards the server when the prediction was wrong', () => {
    const p = new Predictor(250);
    p.input(1);
    p.reconcile(100, 1); // the server says otherwise
    expect(p.y).toBe(100);
    expect(p.lastCorrection).toBeGreaterThan(100);
  });

  it('interpolates between the snapshots around the render time', () => {
    const i = new Interpolator();
    i.push({ at: 1000, ball: [0, 0], paddles: [100, 100] });
    i.push({ at: 1050, ball: [50, 10], paddles: [200, 100] });
    const s = i.at(1125, 100)!; // renders t=1025, halfway
    expect(s.ball).toEqual([25, 5]);
    expect(s.paddles[0]).toBe(150);
  });
});
