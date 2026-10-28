import { randomBytes, randomInt } from 'node:crypto';
import type { ClientMessage, ServerMessage } from '@rally/shared';
import type { Config } from './config';
import type { Metrics } from './metrics';
import { Room, type Participant } from './room';

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
    private readonly now: () => number = Date.now,
  ) {}

  handle(conn: Connection, msg: ClientMessage) {
    if (msg.t === 'ping') return conn.send({ t: 'pong', c: msg.c, s: this.now() });
    if (msg.t === 'hello') return this.hello(conn, msg.name, msg.token);
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
        return this.startRoom(s, 'bot');
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

  private hello(conn: Connection, name: string, token?: string) {
    const existing = token ? this.sessions.get(token) : undefined;
    if (existing) {
      // Resume: move the session to the new socket and rejoin its match
      if (existing.conn && existing.conn !== conn) existing.conn.session = null;
      existing.conn = conn;
      existing.name = name;
      existing.lastSeen = this.now();
      conn.session = existing;
      this.metrics.reconnects.inc();
      existing.send({ t: 'welcome', id: existing.id, token: existing.token, name, resumed: true });
      const side = existing.side;
      if (side !== -1) existing.room!.reconnect(side, existing, this.now());
      else if (existing.waiting) existing.send({ t: 'waiting', ...(existing.code ? { code: existing.code } : {}) });
      return;
    }
    const s = new Session(name, conn);
    this.sessions.set(s.token, s);
    conn.session = s;
    s.send({ t: 'welcome', id: s.id, token: s.token, name, resumed: false });
  }

  private enqueue(s: Session) {
    this.leaveCurrent(s);
    const opponent = this.queue.find((q) => q !== s && q.conn);
    if (opponent) {
      this.queue = this.queue.filter((q) => q !== opponent);
      opponent.waiting = null;
      this.startRoom(opponent, s);
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
    this.startRoom(host, s);
  }

  private cancelWaiting(s: Session) {
    if (s.waiting === 'queue') this.queue = this.queue.filter((q) => q !== s);
    if (s.code) this.privateRooms.delete(s.code);
    s.waiting = null;
    s.code = null;
    this.metrics.queued.set(this.queue.length);
  }

  private startRoom(a: Session, b: Session | 'bot') {
    const id = randomBytes(6).toString('hex');
    const room = new Room(id, a, b, {
      graceMs: this.config.reconnectGraceMs,
      inputQueueMax: this.config.inputQueueMax,
      seed: this.seed++,
      onEnd: (_room, reason) => this.metrics.matchesEnded.inc({ reason }),
    });
    a.room = room;
    if (b !== 'bot') b.room = room;
    this.rooms.set(id, room);
    this.metrics.rooms.set(this.rooms.size);
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
