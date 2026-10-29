import {
  BALL,
  DT,
  FIELD,
  Interpolator,
  PADDLE,
  POINTS_TO_WIN,
  Predictor,
  TICK_RATE,
  paddleX,
  type Dir,
  type ServerMessage,
  type Snapshot,
} from '@rally/shared';
import { Net } from './net';
import './styles.css';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const lobby = $('lobby');
const game = $('game');
const status = $('status');
const canvas = $<HTMLCanvasElement>('field');
const ctx = canvas.getContext('2d')!;
const overlay = $('overlay');
const stats = $('netstats');

let net: Net | null = null;
let side: 0 | 1 = 0;
let names: [string, string] = ['', ''];
let vsBot = false;
const predictor = new Predictor(FIELD.height / 2);
const interp = new Interpolator();
let last: Snapshot | null = null;
let phase: Snapshot['ph'] | 'waiting' = 'waiting';
let usePrediction = true;
let snapshotTimes: number[] = [];
let banner = '';
let pausedUntil = 0;

// ---- Lobby ----

const nameInput = $<HTMLInputElement>('name');
try {
  nameInput.value = localStorage.getItem('rally:name') ?? '';
} catch {
  // storage unavailable
}

function ensureNet(): Net {
  if (net) return net;
  const name = nameInput.value.trim() || 'Player';
  try {
    localStorage.setItem('rally:name', name);
  } catch {
    // storage unavailable
  }
  net = new Net(name);
  net.onMessage = onMessage;
  net.onStatus = (s) => {
    if (s === 'reconnecting' && phase !== 'over') phase = 'paused'; // no inputs until the server resumes us
    $('conn').textContent = s === 'open' ? '' : s === 'reconnecting' ? 'Reconnecting…' : 'Connecting…';
  };
  net.connect();
  return net;
}

let welcomed = false;
let pending: (() => void) | null = null;
/** Runs `fn` once the server has greeted us, connecting first if needed. */
function whenWelcomed(fn: () => void) {
  ensureNet();
  if (welcomed) fn();
  else pending = fn;
}

$('quick').onclick = () => whenWelcomed(() => (net!.send({ t: 'queue' }), setStatus('Looking for an opponent…', true)));
$('bot').onclick = () => whenWelcomed(() => net!.send({ t: 'bot' }));
$('create').onclick = () => whenWelcomed(() => net!.send({ t: 'create' }));
$<HTMLFormElement>('joinform').onsubmit = (e) => {
  e.preventDefault();
  const code = $<HTMLInputElement>('code').value.trim().toUpperCase();
  if (code) whenWelcomed(() => net!.send({ t: 'join', code }));
};
$('cancel').onclick = () => {
  net?.send({ t: 'cancel' });
  setStatus('');
};

function setStatus(text: string, cancellable = false) {
  status.innerHTML = text;
  $('cancel').hidden = !cancellable;
}

const roomFromUrl = new URLSearchParams(location.search).get('room');
if (roomFromUrl) $<HTMLInputElement>('code').value = roomFromUrl;

async function refreshStats() {
  try {
    const s = await (await fetch('/api/stats')).json();
    $('online').textContent = `${s.sessions} online · ${s.rooms} ${s.rooms === 1 ? 'match' : 'matches'} in progress`;
  } catch {
    // the server may be waking up
  }
}
refreshStats();
setInterval(refreshStats, 10_000);

// ---- Leaderboard ----

interface Board {
  persistent: boolean;
  players: { name: string; rating: number; games: number; wins: number; losses: number; rank: number }[];
  recent: { names: [string, string]; score: [number, number]; winner: 0 | 1; ended: 'score' | 'forfeit' | 'left'; mode: string; rated: boolean; reason: string | null; deltas: [number, number] }[];
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

async function refreshBoard() {
  if (lobby.hidden) return;
  let board: Board;
  try {
    board = await (await fetch('/api/leaderboard')).json();
  } catch {
    return;
  }
  $('ranks').innerHTML = board.players.length
    ? board.players
        .slice(0, 10)
        .map((p) => `<tr><td>${p.rank}</td><td>${esc(p.name)}</td><td class="num">${p.rating}</td><td class="num muted">${p.wins}–${p.losses}</td></tr>`)
        .join('')
    : '<tr><td colspan="4" class="muted">No rated matches yet. Quick-match someone on another device or network.</td></tr>';
  $('recent').innerHTML = board.recent.length
    ? board.recent
        .map((m) => {
          const players = `${m.winner === 0 ? '<strong>' + esc(m.names[0]) + '</strong>' : esc(m.names[0])} ${m.score[0]}–${m.score[1]} ${m.winner === 1 ? '<strong>' + esc(m.names[1]) + '</strong>' : esc(m.names[1])}`;
          const verdict = m.rated
            ? `<span class="rated">rated ${m.deltas[m.winner] > 0 ? '+' : ''}${m.deltas[m.winner]}</span>`
            : `<span class="muted">unrated: ${esc((m.reason ?? '').replace(/^\w/, (c) => c.toLowerCase()))}</span>`;
          const how = m.ended === 'left' ? ' <span class="muted">(left)</span>' : m.ended === 'forfeit' ? ' <span class="muted">(forfeit)</span>' : '';
          return `<li>${players}${how}<br />${verdict}</li>`;
        })
        .join('')
    : '<li class="muted">No matches yet.</li>';
  $('persist').hidden = board.persistent;
}
refreshBoard();
setInterval(refreshBoard, 10_000);

// ---- Messages ----

function onMessage(m: ServerMessage) {
  switch (m.t) {
    case 'welcome':
      welcomed = true;
      if (!m.resumed && roomFromUrl && !pending) pending = () => net!.send({ t: 'join', code: roomFromUrl });
      pending?.();
      pending = null;
      break;
    case 'waiting':
      if (m.code) {
        const link = `${location.origin}/?room=${m.code}`;
        setStatus(`Room code <strong class="code">${m.code}</strong>, share <a href="${link}">${link}</a>`, true);
      } else setStatus('Looking for an opponent… (or play the bot while you wait)', true);
      break;
    case 'matched':
      side = m.side;
      names = m.names;
      vsBot = m.bot;
      phase = 'countdown';
      // Keep the sequence counter: inputs sent just before this message still carry the old numbers,
      // and restarting from 1 would make the server discard every new input as a duplicate.
      predictor.reset(FIELD.height / 2);
      interp.clear();
      last = null;
      banner = '';
      setStatus('');
      lobby.hidden = true;
      game.hidden = false;
      $('rematch').hidden = true;
      $('result').textContent = '';
      overlay.textContent = '';
      break;
    case 'state': {
      const now = performance.now();
      if (last && m.s.some((v, i) => v !== last!.s[i])) interp.clear(); // a goal reset the ball: don't slide it back
      last = m;
      phase = m.ph;
      snapshotTimes.push(now);
      snapshotTimes = snapshotTimes.filter((t) => now - t < 1000);
      interp.push({ at: now, ball: [m.b[0], m.b[1]], paddles: m.p });
      predictor.reconcile(m.p[side], m.ack);
      if (m.ph === 'over') predictor.reset(m.p[side]);
      break;
    }
    case 'event':
      if (m.kind === 'goal') flash(m.side === side ? 'Point!' : 'Point to ' + names[m.side ?? 0]);
      break;
    case 'paused':
      pausedUntil = performance.now() + m.graceMs;
      banner = `${names[m.who]} lost connection, waiting`;
      break;
    case 'resumed':
      banner = '';
      flash('Resumed');
      break;
    case 'profile':
      $('me').textContent = `Your rating ${m.rating}${m.rank ? ` · #${m.rank}` : ''} · ${m.wins}–${m.losses}`;
      break;
    case 'rated':
      $('result').textContent = m.rated
        ? `Rating ${m.delta > 0 ? '+' : ''}${m.delta} → ${m.rating}`
        : `Unrated: ${m.reason?.replace(/^\w/, (c) => c.toLowerCase()) ?? 'not counted'}`;
      $('result').className = m.rated ? (m.delta > 0 ? 'rated' : 'warn') : 'muted';
      break;
    case 'over': {
      const won = m.winner === side;
      banner = (won ? 'You win!' : `${names[m.winner]} wins`) + (m.reason === 'forfeit' ? ' (opponent did not return)' : m.reason === 'left' ? ' (opponent left)' : '');
      $('rematch').hidden = false;
      break;
    }
    case 'rematch':
      $('rematch').textContent = m.ready[side] ? 'Waiting for opponent…' : m.ready[side === 0 ? 1 : 0] ? 'Opponent wants a rematch!' : 'Rematch';
      break;
    case 'error':
      if (m.code === 'no_such_room') setStatus('No room with that code. Check it, or create one.');
      break;
  }
}

let flashText = '';
let flashUntil = 0;
function flash(text: string) {
  flashText = text;
  flashUntil = performance.now() + 900;
}

$('rematch').onclick = () => net?.send({ t: 'rematch' });
$('leave').onclick = () => {
  net?.send({ t: 'leave' });
  game.hidden = true;
  lobby.hidden = false;
  void refreshBoard();
  phase = 'waiting';
};
$('drop').onclick = () => net?.dropConnection();
$<HTMLInputElement>('predict').onchange = (e) => (usePrediction = (e.target as HTMLInputElement).checked);
$<HTMLSelectElement>('lag').onchange = (e) => net && (net.latencyMs = Number((e.target as HTMLSelectElement).value));

// ---- Input: keyboard and touch, sampled at the simulation rate ----

const keys = new Set<string>();
addEventListener('keydown', (e) => {
  if (['ArrowUp', 'ArrowDown', 'w', 's', 'W', 'S'].includes(e.key)) {
    keys.add(e.key.toLowerCase());
    if (!game.hidden) e.preventDefault();
  }
});
addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
let touchY: number | null = null;
canvas.addEventListener('pointerdown', (e) => (touchY = fieldY(e)));
canvas.addEventListener('pointermove', (e) => touchY !== null && (touchY = fieldY(e)));
addEventListener('pointerup', () => (touchY = null));
function fieldY(e: PointerEvent) {
  const r = canvas.getBoundingClientRect();
  return ((e.clientY - r.top) / r.height) * FIELD.height;
}

function currentDir(): Dir {
  const up = keys.has('arrowup') || keys.has('w');
  const down = keys.has('arrowdown') || keys.has('s');
  if (touchY !== null) {
    const d = touchY - predictor.y;
    return Math.abs(d) < 6 ? 0 : d > 0 ? 1 : -1;
  }
  return up === down ? 0 : up ? -1 : 1;
}

let acc = 0;
let prev = performance.now();
function frame(now: number) {
  acc += Math.min(250, now - prev);
  prev = now;
  while (acc >= 1000 / TICK_RATE) {
    acc -= 1000 / TICK_RATE;
    if (net && !game.hidden && (phase === 'playing' || phase === 'countdown')) {
      net.send({ t: 'input', ...predictor.input(currentDir()) });
    }
  }
  draw(now);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---- Rendering ----

function draw(now: number) {
  if (game.hidden) return;
  const css = getComputedStyle(document.documentElement);
  const fg = css.getPropertyValue('--fg').trim();
  const dim = css.getPropertyValue('--dim').trim();
  const accent = css.getPropertyValue('--accent').trim();
  ctx.clearRect(0, 0, FIELD.width, FIELD.height);

  ctx.strokeStyle = dim;
  ctx.setLineDash([10, 14]);
  ctx.beginPath();
  ctx.moveTo(FIELD.width / 2, 0);
  ctx.lineTo(FIELD.width / 2, FIELD.height);
  ctx.stroke();
  ctx.setLineDash([]);

  const s = interp.at(now);
  const score = last?.s ?? [0, 0];
  ctx.fillStyle = dim;
  ctx.font = '600 56px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(String(score[0]), FIELD.width / 2 - 70, 70);
  ctx.fillText(String(score[1]), FIELD.width / 2 + 70, 70);

  for (const p of [0, 1] as const) {
    const y = p === side && usePrediction ? predictor.y : (s?.paddles[p] ?? FIELD.height / 2);
    ctx.fillStyle = p === side ? accent : fg;
    ctx.fillRect(paddleX(p) - PADDLE.width / 2, y - PADDLE.height / 2, PADDLE.width, PADDLE.height);
  }
  if (s && phase === 'playing') {
    ctx.fillStyle = fg;
    ctx.beginPath();
    ctx.arc(s.ball[0], s.ball[1], BALL.radius, 0, Math.PI * 2);
    ctx.fill();
  }

  let text = banner;
  if (!text && phase === 'countdown' && last) text = last.cd > TICK_RATE / 2 ? 'Get ready' : 'Go!';
  if (phase === 'paused' && pausedUntil) text = `${banner} ${Math.max(0, Math.ceil((pausedUntil - now) / 1000))}s`;
  if (!text && now < flashUntil) text = flashText;
  overlay.textContent = text;

  $('names').textContent = `${names[0]}  vs  ${names[1]}${vsBot ? ' (AI)' : ''} · first to ${POINTS_TO_WIN}`;
  stats.textContent = [
    `RTT ${Math.round(net?.rtt ?? 0)} ms`,
    `${snapshotTimes.length} snapshots/s`,
    `${predictor.unacknowledged} inputs in flight`,
    `last correction ${predictor.lastCorrection.toFixed(1)} u`,
    `tick ${last?.tick ?? 0} @ ${Math.round(1 / DT)} Hz`,
  ].join(' · ');
}
