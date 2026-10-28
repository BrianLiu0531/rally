/**
 * Load test: N clients join quick matches in pairs, send inputs at 60 Hz like the real client and
 * ping once a second. Reports round-trip time, snapshot spacing and the server's own tick timings.
 *
 * usage: npm run loadtest -- <http(s)://host> <clients> <seconds>
 */
import WebSocket from 'ws';

const base = process.argv[2] ?? 'http://localhost:8080';
const clients = Number(process.argv[3] ?? 200);
const seconds = Number(process.argv[4] ?? 30);
const wsUrl = base.replace(/^http/, 'ws') + '/ws';

const rtts: number[] = [];
const gaps: number[] = []; // ms between consecutive snapshots per client
let matched = 0;
let closed = 0;
let errors = 0;
let snapshots = 0;
const closeCodes: Record<string, number> = {};
const serverErrors: Record<string, number> = {};
const sockets: WebSocket[] = [];

function pct(xs: number[], p: number) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
}

async function scrape(): Promise<Record<string, number>> {
  const text = await (await fetch(base + '/metrics')).text();
  const out: Record<string, number> = {};
  for (const line of text.split('\n')) {
    const m = /^(rally_tick_seconds_(?:sum|count)|rally_tick_seconds_bucket\{le="([^"]+)"\}|process_resident_memory_bytes|rally_connections|rally_rooms|rally_skipped_snapshots_total|process_cpu_seconds_total) ([0-9.e+-]+)$/.exec(line);
    if (m) out[m[2] ? `bucket_${m[2]}` : m[1]!] = Number(m[3]);
  }
  return out;
}

function client(i: number) {
  return new Promise<void>((ready) => {
    const ws = new WebSocket(wsUrl);
    sockets.push(ws);
    let seq = 0;
    let lastSnap = 0;
    let playing = false;
    let inputs: NodeJS.Timeout | undefined;
    let pinger: NodeJS.Timeout | undefined;
    ws.on('open', () => {
      ws.send(JSON.stringify({ t: 'hello', v: 1, name: `load${i}` }));
      ready();
    });
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.t === 'welcome') ws.send(JSON.stringify({ t: 'queue' }));
      if (m.t === 'matched') {
        matched++;
        playing = true;
        if (inputs) return; // a rematch sends 'matched' again; keep the one 60 Hz loop
        inputs = setInterval(() => {
          if (ws.readyState === ws.OPEN && playing) ws.send(JSON.stringify({ t: 'input', seq: ++seq, dir: Math.floor(Date.now() / 500 + i) % 3 - 1 }));
        }, 1000 / 60);
        pinger = setInterval(() => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ t: 'ping', c: performance.now() })), 1000);
      }
      if (m.t === 'pong') rtts.push(performance.now() - m.c);
      if (m.t === 'error') serverErrors[m.code] = (serverErrors[m.code] ?? 0) + 1;
      if (m.t === 'state') {
        snapshots++;
        const now = performance.now();
        if (lastSnap && m.ph === 'playing') gaps.push(now - lastSnap);
        lastSnap = now;
      }
      if (m.t === 'over') ws.send(JSON.stringify({ t: 'rematch' })); // keep playing for the whole run
    });
    ws.on('error', () => errors++);
    ws.on('close', (code, reason) => {
      closed++;
      const k = `${code} ${reason.toString()}`.trim();
      closeCodes[k] = (closeCodes[k] ?? 0) + 1;
      clearInterval(inputs);
      clearInterval(pinger);
    });
  });
}

const before = await scrape();
const t0 = performance.now();
// Ramp up in batches so the test measures steady state, not a connection storm
for (let i = 0; i < clients; i += 50) await Promise.all(Array.from({ length: Math.min(50, clients - i) }, (_, k) => client(i + k)));
console.log(`connected ${clients} clients in ${Math.round(performance.now() - t0)} ms`);
await new Promise((r) => setTimeout(r, 3000));
rtts.length = 0;
gaps.length = 0;
const mid = await scrape();
const midAt = performance.now();
await new Promise((r) => setTimeout(r, seconds * 1000));
const after = await scrape();
const elapsed = (performance.now() - midAt) / 1000;
const closedDuring = closed;
for (const ws of sockets) ws.close();

const ticks = after.rally_tick_seconds_count! - mid.rally_tick_seconds_count!;
const tickAvgMs = ((after.rally_tick_seconds_sum! - mid.rally_tick_seconds_sum!) / ticks) * 1000;
// Upper bound of the bucket that holds the 99th percentile
const le = Object.keys(after).filter((k) => k.startsWith('bucket_')).map((k) => k.slice(7)).filter((k) => k !== '+Inf').map(Number).sort((a, b) => a - b);
const p99tick = le.find((b) => (after[`bucket_${b}`]! - mid[`bucket_${b}`]!) / ticks >= 0.99);

console.log(JSON.stringify({
  clients,
  matched,
  rooms: after.rally_rooms,
  seconds: Math.round(elapsed),
  rttMs: { p50: pct(rtts, 50), p95: pct(rtts, 95), p99: pct(rtts, 99), samples: rtts.length },
  snapshotGapMs: { p50: pct(gaps, 50), p95: pct(gaps, 95), p99: pct(gaps, 99) },
  snapshotsPerSecond: Math.round(snapshots / ((performance.now() - t0) / 1000)),
  serverTick: { avgMs: Number(tickAvgMs.toFixed(3)), p99BelowMs: p99tick ? p99tick * 1000 : '>20', ticksPerSecond: Math.round(ticks / elapsed) },
  serverCpuPercent: Math.round(((after.process_cpu_seconds_total! - mid.process_cpu_seconds_total!) / elapsed) * 100),
  serverMemoryMB: Math.round(after.process_resident_memory_bytes! / 1e6),
  skippedSnapshots: after.rally_skipped_snapshots_total! - (before.rally_skipped_snapshots_total ?? 0),
  errors,
  closedDuringTest: closedDuring,
  closeCodes,
  serverErrors,
}, null, 1));
// Non-zero exit when anything went wrong, so CI can use this as a smoke test
setTimeout(() => process.exit(errors || closedDuring ? 1 : 0), 500);
