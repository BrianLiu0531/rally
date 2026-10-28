/** Micro-benchmark: cost of one tick for N rooms, with and without serialising snapshots. */
import type { ServerMessage } from '@rally/shared';
import { Room, type Participant } from '../server/src/room';

const rooms = Number(process.argv[2] ?? 100);
let bytes = 0;
const make = (id: string, serialise: boolean): Participant => ({
  id,
  name: id,
  send: (m: ServerMessage) => {
    if (serialise) bytes += JSON.stringify(m).length;
  },
});

for (const serialise of [false, true]) {
  const list = Array.from({ length: rooms }, (_, i) => new Room(`r${i}`, make(`a${i}`, serialise), make(`b${i}`, serialise), { graceMs: 15000, inputQueueMax: 8, seed: i + 1 }));
  let seq = 0;
  const t0 = performance.now();
  const N = 600;
  for (let t = 0; t < N; t++) {
    seq++;
    for (const r of list) {
      r.input(0, seq, (seq >> 5) % 2 ? 1 : -1);
      r.input(1, seq, (seq >> 6) % 2 ? 1 : -1);
      r.tick(Date.now());
    }
  }
  const per = (performance.now() - t0) / N;
  console.log(`${rooms} rooms, serialise=${serialise}: ${per.toFixed(3)} ms per tick (${((per / rooms) * 1000).toFixed(1)} µs per room)`);
}
