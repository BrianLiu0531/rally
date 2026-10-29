/**
 * Wire protocol: JSON text frames. Every client message is validated before the server touches it.
 */
import type { Dir, Phase } from './physics';

export const PROTOCOL_VERSION = 1;
export const MAX_MESSAGE_BYTES = 512;
export const SNAPSHOT_EVERY_TICKS = 3; // 60 Hz simulation, 20 Hz snapshots

// ---- client → server ----

export type ClientMessage =
  // token resumes an earlier session; key is a secret kept in the browser that identifies the player for ratings
  | { t: 'hello'; v: number; name: string; token?: string; key?: string }
  | { t: 'queue' } // quick match
  | { t: 'create' } // private room; the server replies with a code
  | { t: 'join'; code: string }
  | { t: 'bot' } // play against the server's AI
  | { t: 'cancel' } // leave the queue or a waiting room
  | { t: 'input'; seq: number; dir: Dir } // seq lets the client reconcile its prediction
  | { t: 'rematch' }
  | { t: 'leave' }
  | { t: 'ping'; c: number }; // c = client clock, echoed back for RTT

const NAME = /^[\p{L}\p{N} _.-]{1,16}$/u;
const CODE = /^[A-Z2-9]{4}$/;
const TOKEN = /^[A-Za-z0-9_-]{22,64}$/;
const KEY = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url

/** Parses and validates a raw frame. Returns null for anything malformed. */
export function parseClientMessage(raw: string): ClientMessage | null {
  if (raw.length > MAX_MESSAGE_BYTES) return null;
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof m !== 'object' || m === null || Array.isArray(m)) return null;
  const o = m as Record<string, unknown>;
  switch (o.t) {
    case 'hello':
      if (o.v !== PROTOCOL_VERSION || typeof o.name !== 'string') return null;
      if (o.token !== undefined && (typeof o.token !== 'string' || !TOKEN.test(o.token))) return null;
      if (o.key !== undefined && (typeof o.key !== 'string' || !KEY.test(o.key))) return null;
      return {
        t: 'hello',
        v: PROTOCOL_VERSION,
        name: cleanName(o.name),
        ...(o.token ? { token: o.token as string } : {}),
        ...(o.key ? { key: o.key as string } : {}),
      };
    case 'input':
      if (!Number.isSafeInteger(o.seq) || (o.seq as number) < 0) return null;
      if (o.dir !== -1 && o.dir !== 0 && o.dir !== 1) return null;
      return { t: 'input', seq: o.seq as number, dir: o.dir };
    case 'join':
      if (typeof o.code !== 'string') return null;
      return CODE.test(o.code.toUpperCase()) ? { t: 'join', code: o.code.toUpperCase() } : null;
    case 'ping':
      return typeof o.c === 'number' && Number.isFinite(o.c) ? { t: 'ping', c: o.c } : null;
    case 'queue':
    case 'create':
    case 'bot':
    case 'cancel':
    case 'rematch':
    case 'leave':
      return { t: o.t };
    default:
      return null;
  }
}

export function cleanName(raw: string): string {
  const trimmed = raw.normalize('NFC').replace(/\s+/g, ' ').trim().slice(0, 16);
  return NAME.test(trimmed) ? trimmed : 'Player';
}

// ---- server → client ----

export interface Snapshot {
  t: 'state';
  tick: number;
  ack: number; // last input seq applied for the receiving player
  ph: Phase;
  cd: number; // countdown ticks
  b: [number, number, number, number]; // ball x, y, vx, vy
  p: [number, number]; // paddle y, left and right
  s: [number, number]; // score
}

export type ServerMessage =
  | { t: 'welcome'; id: string; token: string; name: string; resumed: boolean }
  | { t: 'waiting'; code?: string } // in the queue, or in a private room waiting for a guest
  | { t: 'matched'; room: string; side: 0 | 1; names: [string, string]; bot: boolean }
  | Snapshot
  | { t: 'event'; kind: 'serve' | 'hit' | 'goal'; side?: 0 | 1 }
  | { t: 'paused'; who: 0 | 1; graceMs: number } // a player dropped; the match waits for them
  | { t: 'resumed' }
  | { t: 'over'; winner: 0 | 1; reason: 'score' | 'forfeit' | 'left' }
  /** Your rating and rank, after hello and after each rated match */
  | { t: 'profile'; rating: number; games: number; wins: number; losses: number; rank: number | null }
  /** How the finished match affected your rating: a change, or why it didn't count */
  | { t: 'rated'; rated: boolean; delta: number; rating: number | null; reason?: string }
  | { t: 'rematch'; ready: [boolean, boolean] }
  | { t: 'pong'; c: number; s: number } // s = server clock
  | { t: 'error'; code: 'bad_message' | 'rate_limited' | 'no_such_room' | 'room_full' | 'not_in_room' | 'hello_first' | 'server_full' };

const r1 = (n: number) => Math.round(n * 10) / 10;

/** Compact snapshot: one decimal place is plenty at this scale and halves the payload. */
export function encodeSnapshot(
  tick: number,
  ack: number,
  ph: Phase,
  cd: number,
  ball: { x: number; y: number; vx: number; vy: number },
  paddles: [number, number],
  score: [number, number],
): Snapshot {
  return { t: 'state', tick, ack, ph, cd, b: [r1(ball.x), r1(ball.y), r1(ball.vx), r1(ball.vy)], p: [r1(paddles[0]), r1(paddles[1])], s: [...score] };
}
