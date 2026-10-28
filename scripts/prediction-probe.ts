/**
 * Plays against the bot with the real Predictor, drops the connection once and reports how far
 * each snapshot moved the predicted paddle (0 = prediction agreed with the server).
 * usage: tsx scripts/prediction-probe.ts ws://localhost:8080/ws
 */
import WebSocket from 'ws';
import { Predictor, FIELD, type Dir, type ServerMessage } from '@rally/shared';

const url = process.argv[2] ?? 'ws://localhost:8080/ws';
const lagMs = Number(process.argv[3] ?? 0); // simulated round-trip latency, half each way
const later = (fn: () => void) => (lagMs ? setTimeout(fn, lagMs / 2) : fn());
const predictor = new Predictor(FIELD.height / 2);
let token = '';
let phase = 'waiting';
let seconds = 0;
const corrections: { t: number; c: number; pending: number }[] = [];
const started = Date.now();

function open(resume: boolean) {
  const ws = new WebSocket(url);
  ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', v: 1, name: 'Probe', ...(resume ? { token } : {}) })));
  ws.on('message', (d) => later(() => {
    const m = JSON.parse(d.toString()) as ServerMessage;
    if (process.env.TRACE && resume && m.t !== 'state') console.log('recv', JSON.stringify(m).slice(0, 120));
    if (m.t === 'welcome') {
      token = m.token;
      if (!resume) ws.send(JSON.stringify({ t: 'bot' }));
    }
    if (m.t === 'matched') {
      predictor.reset(FIELD.height / 2);
      phase = 'countdown';
    }
    if (m.t === 'state') {
      phase = m.ph;
      predictor.reconcile(m.p[0], m.ack);
      corrections.push({ t: (Date.now() - started) / 1000, c: predictor.lastCorrection, pending: predictor.unacknowledged });
      if (process.env.TRACE && resume && corrections.length % 4 === 0) console.log('ph', m.ph, 'cd', m.cd, 'tick', m.tick, 'ack', m.ack, 'p0', m.p[0], 'pred', predictor.y.toFixed(1), 'pending', predictor.unacknowledged);
    }
  }));
  const timer = setInterval(() => {
    if (ws.readyState !== ws.OPEN || (phase !== 'playing' && phase !== 'countdown')) return;
    const dir: Dir = Math.floor(Date.now() / 400) % 2 === 0 ? 1 : -1;
    const msg = JSON.stringify({ t: 'input', ...predictor.input(dir) });
    later(() => ws.readyState === ws.OPEN && ws.send(msg));
  }, 1000 / 60);
  return { ws, stop: () => clearInterval(timer) };
}

let conn = open(false);
const tick = setInterval(() => {
  seconds++;
  if (seconds === 3) {
    console.log('-- dropping connection');
    conn.stop();
    conn.ws.terminate();
    setTimeout(() => (conn = open(true)), 300);
  }
  if (seconds === 9) {
    clearInterval(tick);
    conn.stop();
    conn.ws.close();
    for (let s = 0; s < 9; s++) {
      const w = corrections.filter((c) => c.t >= s && c.t < s + 1);
      const max = Math.max(0, ...w.map((c) => c.c));
      console.log(`${s}-${s + 1}s: ${w.length} snapshots, max correction ${max.toFixed(1)}, pending ${w.at(-1)?.pending ?? '-'}`);
    }
    process.exit(0);
  }
}, 1000);
