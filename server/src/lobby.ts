import { randomBytes, randomInt } from 'node:crypto';
import type { ClientMessage, ServerMessage } from '@rally/shared';
import type { Config } from './config';
import { networkId, playerIdFromKey, type Leaderboard, type MatchRecord } from './leaderboard';
import type { MatchMode } from './leaderboard/rules';
import type { Metrics } from './metrics';
import { Room, type EndReason, type Participant } from './room';

/** A player identity that outlives a single WebSocket, so a dropped player can come back. */
export class Session implements Participant {
  readonly id = randomBytes(8).toString('hex');
  readonly token = randomBytes(24).toString('base64url');
  room: Room | null = null;
  waiting: 'queue' | 'private' | null = null;
  code: string | null = null;
  lastSeen = Date.now();

  constructor(
    public name: string,
    public conn: Connection | null,
    /** Rating identity (hash of the browser's secret key); null for a guest */
    readonly playerId: string | null,
    /** Hashed client IP, to keep one person from rating themselves with two accounts */
    public network: string,
  ) {}

  send(msg: ServerMessage, droppable = false) {
    this.conn?.send(msg, droppable);
  }

  get side(): 0 | 1 | -1 {
    return this.room ? this.room.sideOf(this.id) : -1;
  }
}

/** What the lobby needs from a socket. */
export interface Connection {
  send(msg: ServerMessage, droppable?: boolean): void;
  session: Session | null;
  readonly ip: string;
}

// No 0/O/1/I, so codes are easy to read out
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export class Lobby {
  private sessions = new Map<string, Session>(); // by token
  private queue: Session[] = [];
  private privateRooms = new Map<string, Session>(); // code → host waiting for a guest
  readonly rooms = new Map<string, Room>();
  private seed = 1;

  constructor(
    private readonly config: Config,
    private readonly metrics: Metrics,
    private readonly leaderboard: Leaderboard,
    private readonly now: () => number = Date.now,
  ) {}

  handle(conn: Connection, msg: ClientMessage) {
    if (msg.t === 'ping') return conn.send({ t: 'pong', c: msg.c, s: this.now() });
    if (msg.t === 'hello') return this.hello(conn, msg.name, msg.token, msg.key);
    const s = conn.session;
    if (!s) return conn.send({ t: 'error', code: 'hello_first' });
    s.lastSeen = this.now();

    switch (msg.t) {
      case 'input': {
        const side = s.side;
        if (side !== -1) s.room!.input(side, msg.seq, msg.dir);
        return;
      }
      case 'queue':
        return this.enqueue(s);
      case 'bot':
        this.leaveCurrent(s);
        return this.startRoom(s, 'bot', 'bot');
      case 'create':
        return this.createPrivate(s);
      case 'join':
        return this.joinPrivate(s, msg.code);
      case 'cancel':
        return this.cancelWaiting(s);
      case 'rematch':
        if (s.side === -1) return s.send({ t: 'error', code: 'not_in_room' });
        return s.room!.rematch(s.side as 0 | 1);
      case 'leave':
        return this.leaveCurrent(s);
    }
  }

  private hello(conn: Connection, name: string, token?: string, key?: string) {
    const existing = token ? this.sessions.get(token) : undefined;
    if (existing) {
      // Resume: move the session to the new socket and rejoin its match. The rating identity stays
      // the one the session started with, so a token can't be used to switch accounts mid-match.
      if (existing.conn && existing.conn !== conn) existing.conn.session = null;
      existing.conn = conn;
      existing.name = name;
      existing.network = networkId(conn.ip);
      existing.lastSeen = this.now();
      conn.session = existing;
      this.metrics.reconnects.inc();
      existing.send({ t: 'welcome', id: existing.id, token: existing.token, name, resumed: true });
      const side = existing.side;
      if (side !== -1) existing.room!.reconnect(side, existing, this.now());
      else if (existing.waiting) existing.send({ t: 'waiting', ...(existing.code ? { code: existing.code } : {}) });
      return;
    }
    const s = new Session(name, conn, key ? playerIdFromKey(key) : null, networkId(conn.ip));
    this.sessions.set(s.token, s);
    conn.session = s;
    s.send({ t: 'welcome', id: s.id, token: s.token, name, resumed: false });
    this.sendProfile(s);
  }

  private sendProfile(s: Session) {
    if (!s.playerId) return;
    this.leaderboard
      .profile(s.playerId)
      .then((p) => {
        const r = this.leaderboard.rules;
        s.send({ t: 'profile', rating: p?.rating ?? r.initialRating, games: p?.games ?? 0, wins: p?.wins ?? 0, losses: p?.losses ?? 0, rank: p?.rank ?? null });
      })
      .catch((err) => console.error(JSON.stringify({ msg: 'loading profile failed', error: (err as Error).message })));
  }

  private enqueue(s: Session) {
    this.leaveCurrent(s);
    const opponent = this.queue.find((q) => q !== s && q.conn);
    if (opponent) {
      this.queue = this.queue.filter((q) => q !== opponent);
      opponent.waiting = null;
      this.startRoom(opponent, s, 'ranked');
    } else {
      this.queue.push(s);
      s.waiting = 'queue';
      s.send({ t: 'waiting' });
    }
    this.metrics.queued.set(this.queue.length);
  }

  private createPrivate(s: Session) {
    this.leaveCurrent(s);
    let code: string;
    do {
      code = Array.from({ length: 4 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
    } while (this.privateRooms.has(code));
    this.privateRooms.set(code, s);
    s.waiting = 'private';
    s.code = code;
    s.send({ t: 'waiting', code });
  }

  private joinPrivate(s: Session, code: string) {
    const host = this.privateRooms.get(code);
    if (!host || !host.conn) return s.send({ t: 'error', code: 'no_such_room' });
    if (host === s) return;
    this.leaveCurrent(s);
    this.privateRooms.delete(code);
    host.waiting = null;
    host.code = null;
    this.startRoom(host, s, 'private');
  }

  private cancelWaiting(s: Session) {
    if (s.waiting === 'queue') this.queue = this.queue.filter((q) => q !== s);
    if (s.code) this.privateRooms.delete(s.code);
    s.waiting = null;
    s.code = null;
    this.metrics.queued.set(this.queue.length);
  }

  private startRoom(a: Session, b: Session | 'bot', mode: MatchMode) {
    const id = randomBytes(6).toString('hex');
    const room = new Room(id, a, b, {
      graceMs: this.config.reconnectGraceMs,
      inputQueueMax: this.config.inputQueueMax,
      seed: this.seed++,
      now: this.now,
      onEnd: (r, reason) => {
        this.metrics.matchesEnded.inc({ reason });
        this.recordResult(r, reason, mode);
      },
    });
    a.room = room;
    if (b !== 'bot') b.room = room;
    this.rooms.set(id, room);
    this.metrics.rooms.set(this.rooms.size);
  }

  /**
   * Hands the result to the leaderboard. This runs inside the game tick, so it only builds the record;
   * the database write happens asynchronously and its outcome is sent to the players when it lands.
   */
  private recordResult(room: Room, reason: EndReason, mode: MatchMode) {
    const st = room.state;
    const players = room.seats.map((seat) => (seat.player instanceof Session ? seat.player : null)) as [Session | null, Session | null];
    const record: MatchRecord = {
      id: `${room.id}-${room.matchNo}`,
      mode,
      sides: room.seats.map((seat, i) => ({
        playerId: players[i]?.playerId ?? null,
        name: seat.name,
        network: players[i]?.network ?? 'bot',
        moves: seat.moves,
      })) as MatchRecord['sides'],
      winner: st.winner as 0 | 1,
      reason,
      score: [st.score[0], st.score[1]],
      durationMs: this.now() - room.startedAt,
      endedAt: this.now(),
    };
    void this.leaderboard.record(record).then((result) => {
      if (!result) return;
      players.forEach((p, side) => {
        if (!p?.playerId) return;
        p.send({ t: 'rated', rated: result.rated, delta: result.deltas[side]!, rating: result.ratings[side]!, ...(result.reason ? { reason: result.reason } : {}) });
        if (result.rated) this.sendProfile(p);
      });
    });
  }

  /** Leaves whatever the session is doing: queue, private room or match. */
  private leaveCurrent(s: Session) {
    this.cancelWaiting(s);
    const side = s.side;
    if (side !== -1) {
      s.room!.leave(side);
      s.room = null;
    }
  }

  /** The socket closed. The session survives until its token expires; a match is paused, not lost. */
  disconnected(conn: Connection) {
    const s = conn.session;
    if (!s || s.conn !== conn) return;
    s.conn = null;
    s.lastSeen = this.now();
    if (s.waiting === 'queue') this.cancelWaiting(s);
    const side = s.side;
    if (side !== -1) s.room!.disconnect(side, this.now());
  }

  tick() {
    const now = this.now();
    for (const [id, room] of this.rooms) {
      room.tick(now);
      if (room.finished) {
        for (const seat of room.seats) if (seat.player instanceof Session && seat.player.room === room) seat.player.room = null;
        this.rooms.delete(id);
      }
    }
    this.metrics.rooms.set(this.rooms.size);
  }

  /** Forgets sessions that have been gone for longer than their TTL. */
  sweep() {
    const now = this.now();
    for (const [token, s] of this.sessions) {
      if (s.conn || now - s.lastSeen < this.config.sessionTtlMs) continue;
      this.leaveCurrent(s);
      this.sessions.delete(token);
    }
  }

  get stats() {
    return { sessions: this.sessions.size, rooms: this.rooms.size, queued: this.queue.length, waitingPrivate: this.privateRooms.size };
  }
}
