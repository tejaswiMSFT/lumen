/* How many frames does a small file actually take, and where do they go?
 *
 * A 8 KB file is only ~24 blocks, so fixed overheads that vanish on a large
 * transfer dominate it. This counts frames spent on manifests, on duplicate
 * droplets, and on the fountain's tail, for each preset. */
const QR = require('./qr.js');
const F = require('./fountain.js');
const { readPresets } = require('./presets.js');

const PRESETS = readPresets(QR);
PRESETS.forEach(p => {
  p.chars = QR.capacityAlnum(p.ver, p.ecl);
  p.block = F.bytesForChars(p.chars) - 9;
});

/* Mirror the sender's manifest schedule. */
function makeSchedule(lead, leadEvery, every) {
  return n => (n < 2) || (n < lead ? n % leadEvery === 0 : n % every === 0);
}

function simulate(sizeBytes, p, due, readRate, seed) {
  const src = new Uint8Array(sizeBytes);
  let s = seed >>> 0;
  for (let i = 0; i < sizeBytes; i++) { s = (s * 1664525 + 1013904223) >>> 0; src[i] = s >>> 24; }

  const enc = new F.Encoder(src, p.block);
  const meta = { v:1, i:1, n:'x', t:'', s:src.length, z:0, c:F.crc32(src),
                 k:enc.K, b:p.block, l:src.length, qv:p.ver };
  let dec = null;
  const pending = [];
  let frames = 0, manifests = 0, droplets = 0, dups = 0, read = 0;
  let lockedAt = -1;

  while (frames < 40000) {
    const n = frames++;
    let isManifest = due(n), f;
    if (isManifest) { manifests++; }
    else { const d = enc.droplet(); f = { seed:d.seed, data:d.data }; droplets++; }

    // The receiver only reads some frames.
    s = (s * 1664525 + 1013904223) >>> 0;
    if ((s >>> 8) % 1000 >= readRate * 1000) continue;
    read++;

    if (isManifest) {
      if (!dec) {
        dec = new F.Decoder(meta.k, meta.b, meta.l);
        lockedAt = read;
        for (const q of pending) if (!dec.add(q.seed, q.data)) dups++;
        pending.length = 0;
      }
      continue;
    }
    if (!dec) { if (pending.length < 400) pending.push(f); continue; }
    if (!dec.add(f.seed, f.data)) dups++;
    if (dec.isComplete()) break;
  }
  return { K: enc.K, frames, manifests, droplets, dups, read, lockedAt,
           done: !!(dec && dec.isComplete()) };
}

const SIZES = [{ label:'8 KB', bytes: 8 * 1024 }, { label:'2 MB', bytes: 2 * 1024 * 1024 }];
const SCHEDULES = [
  { label: 'current 3/60 then 8',  due: makeSchedule(60, 3, 8) },
  { label: 'lighter 3/12 then 16', due: makeSchedule(12, 3, 16) },
  { label: 'lighter 3/12 then 24', due: makeSchedule(12, 3, 24) },
  { label: 'lighter 2/8 then 32',  due: makeSchedule(8, 2, 32) }
];
const READ = 1.0;   // a receiver reading every frame — best case, isolates overhead

for (const size of SIZES) {
  for (const p of PRESETS) {
    console.log(`\n${size.label}  ·  ${p.name} v${p.ver} (${p.block} B/block, ${p.fps} fps)`);
    console.log('  schedule              frames  manifests  dups   seconds');
    console.log('  ' + '-'.repeat(56));
    for (const sc of SCHEDULES) {
      let fr = 0, mf = 0, du = 0, k = 0, runs = 5;
      for (let r = 0; r < runs; r++) {
        const res = simulate(size.bytes, p, sc.due, READ, 1000 + r * 7);
        fr += res.frames; mf += res.manifests; du += res.dups; k = res.K;
      }
      fr /= runs; mf /= runs; du /= runs;
      console.log(`  ${sc.label.padEnd(22)}${String(Math.round(fr)).padStart(6)}` +
                  `${String(Math.round(mf)).padStart(11)}${String(Math.round(du)).padStart(6)}` +
                  `${(fr / p.fps).toFixed(1).padStart(10)}s   (K=${k})`);
    }
  }
}
