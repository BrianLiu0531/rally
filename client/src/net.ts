import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from '@rally/shared';

const TOKEN_KEY = 'rally:token';
const PLAYER_KEY = 'rally:key';

/**
 * A random secret kept in this browser that identifies the player for ratings. The server only
 * stores its hash. Without localStorage the player is a guest and their matches are unrated.
 */
function playerKey(): string | undefined {
  try {
    let key = localStorage.getItem(PLAYER_KEY);
    if (!key || !/^[A-Za-z0-9_-]{43}$/.test(key)) {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      key = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      localStorage.setItem(PLAYER_KEY, key);
    }
    return key;
  } catch {
    return undefined;
  }
}

/**
 * WebSocket with automatic reconnection (resuming the session by token), RTT measurement and an
 * optional artificial latency applied in both directions, to show what prediction hides.
 */
export class Net {
  private ws: WebSocket | null = null;
  private attempts = 0;
  private stopped = false;
  private pingTimer = 0;
  latencyMs = 0; // simulated one-way delay = latencyMs / 2 each way
  rtt = 0;
  onMessage: (m: ServerMessage) => void = () => {};
  onStatus: (s: 'connecting' | 'open' | 'reconnecting') => void = () => {};

  constructor(private name: string) {}

  get token(): string | null {
    try {
      return sessionStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  }

  private set token(t: string | null) {
    try {
      if (t) sessionStorage.setItem(TOKEN_KEY, t);
    } catch {
      // Without storage, a reload starts a new session; reconnecting within the page still works
    }
  }

  connect() {
    this.stopped = false;
    this.onStatus(this.attempts ? 'reconnecting' : 'connecting');
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.attempts = 0;
      this.onStatus('open');
      const key = playerKey();
      this.sendNow({ t: 'hello', v: PROTOCOL_VERSION, name: this.name, ...(this.token ? { token: this.token } : {}), ...(key ? { key } : {}) });
      clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => this.send({ t: 'ping', c: performance.now() }), 1000);
    };
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data) as ServerMessage;
      this.later(() => {
        if (m.t === 'welcome') this.token = m.token;
        if (m.t === 'pong') this.rtt = this.rtt ? this.rtt * 0.8 + (performance.now() - m.c) * 0.2 : performance.now() - m.c;
        this.onMessage(m);
      });
    };
    ws.onclose = () => {
      clearInterval(this.pingTimer);
      if (this.stopped) return;
      // Exponential backoff up to 5 s; the server keeps the match paused for 15 s
      const delay = Math.min(5000, 250 * 2 ** this.attempts++);
      this.onStatus('reconnecting');
      setTimeout(() => this.connect(), delay);
    };
  }

  private later(fn: () => void) {
    if (this.latencyMs > 0) setTimeout(fn, this.latencyMs / 2);
    else fn();
  }

  private sendNow(m: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  send(m: ClientMessage) {
    this.later(() => this.sendNow(m));
  }

  /** Drops the connection as a network failure would, to demonstrate resuming. */
  dropConnection() {
    this.ws?.close();
  }
}
