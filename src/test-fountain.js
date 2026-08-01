const F = require('./fountain.js');

function rb(n, seed) {
  let s = seed >>> 0;
  const o = new Uint8Array(n);
  for (let i = 0; i < n; i++) { s = (s * 1664525 + 1013904223) >>> 0; o[i] = (s >>> 24) & 255; }
  return o;
}

function trial(size, blockSize, lossRate, rngSeed) {
  const data = rb(size, rngSeed);
  const enc = new F.Encoder(data, blockSize);
  const dec = new F.Decoder(enc.K, blockSize, data.length);

  let s = (rngSeed * 2654435761) >>> 0;
  const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };

  let sent = 0, delivered = 0;
  while (!dec.isComplete()) {
    const d = enc.droplet();
    sent++;
    if (rand() >= lossRate) {
      // exercise the real wire format on the way through
      const frame = F.encodeDroplet(1234, d.seed, d.data);
      const p = F.parseFrame(frame);
      dec.add(p.seed, p.data);
      delivered++;
    }
    if (sent > enc.K * 60 + 10000) return { ok: false, K: enc.K, sent, delivered };
  }

  const out = dec.result();
  let ok = out.length === data.length;
  if (ok) for (let i = 0; i < data.length; i++) if (out[i] !== data[i]) { ok = false; break; }
  ok = ok && F.crc32(out) === F.crc32(data);
  return { ok, K: enc.K, sent, delivered, overhead: delivered / enc.K };
}

console.log('size     K     loss   delivered/K   frames sent   ok');
console.log('------------------------------------------------------');
let allOk = true;
for (const [size, bs] of [[1024, 200], [50 * 1024, 800], [250 * 1024, 800], [1024 * 1024, 1200]]) {
  for (const loss of [0, 0.1, 0.3, 0.5, 0.7]) {
    let agg = { ok: true, ov: 0, sent: 0, K: 0, n: 0 };
    for (let t = 0; t < 5; t++) {
      const r = trial(size, bs, loss, 7919 * (t + 1) + size);
      if (!r.ok) agg.ok = false;
      agg.ov += r.overhead || 0; agg.sent += r.sent; agg.K = r.K; agg.n++;
    }
    if (!agg.ok) allOk = false;
    console.log(
      `${String(Math.round(size / 1024) + 'K').padEnd(8)} ${String(agg.K).padEnd(5)} ` +
      `${String(Math.round(loss * 100) + '%').padEnd(6)} ${(agg.ov / agg.n).toFixed(3).padEnd(13)} ` +
      `${String(Math.round(agg.sent / agg.n)).padEnd(13)} ${agg.ok ? 'PASS' : 'FAIL'}`
    );
  }
}

// Sanity: seeds must map to identical index sets on both sides.
const cdf = F.buildDegreeCdf(500);
let deterministic = true;
for (let seed = 0; seed < 3000; seed++) {
  const a = F.indicesForSeed(seed, 500, cdf).join(',');
  const b = F.indicesForSeed(seed, 500, F.buildDegreeCdf(500)).join(',');
  if (a !== b) { deterministic = false; break; }
}
console.log('\nseed->indices deterministic :', deterministic ? 'PASS' : 'FAIL');
console.log('overall                     :', allOk && deterministic ? 'PASS' : 'FAIL');
process.exit(allOk && deterministic ? 0 : 1);
