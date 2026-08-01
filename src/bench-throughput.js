/* Which (version, ECL) carries the most bytes per second through a real
 * camera-like path? Measures payload, decode cost and success under the same
 * distortions test-decode.js uses, then ranks by effective throughput. */
const path = require('path');
const QR = require(path.join(__dirname, 'qr.js'));
const Fountain = require(path.join(__dirname, 'fountain.js'));
const QRDecode = require(path.join(__dirname, 'qrdecode.js'));

const ECL_NAME = { 0:'L', 1:'M', 2:'Q', 3:'H' };

function rand(n, seed) {
  const o = new Uint8Array(n); let s = seed >>> 0;
  for (let i = 0; i < n; i++) { s = (s * 1664525 + 1013904223) >>> 0; o[i] = s >>> 24; }
  return o;
}

/* Render a symbol the way a phone screen would present it, then apply a
   distortion, mimicking a hand-held camera. */
function render(q, scale, quiet) {
  const dim = (q.size + quiet * 2) * scale;
  const g = new Float32Array(dim * dim).fill(255);
  for (let y = 0; y < q.size; y++)
    for (let x = 0; x < q.size; x++) {
      if (!q.modules[y * q.size + x]) continue;
      for (let dy = 0; dy < scale; dy++)
        for (let dx = 0; dx < scale; dx++)
          g[((y + quiet) * scale + dy) * dim + ((x + quiet) * scale + dx)] = 0;
    }
  return { g, dim };
}

function warp(src, dim, { rot = 0, persp = 0, blur = 0, noise = 0, contrast = 1 }, seed) {
  const out = new Float32Array(dim * dim).fill(255);
  const c = dim / 2, cos = Math.cos(rot * Math.PI / 180), sin = Math.sin(rot * Math.PI / 180);
  for (let y = 0; y < dim; y++)
    for (let x = 0; x < dim; x++) {
      let u = x - c, v = y - c;
      const k = 1 + persp * (v / dim);
      u /= k; v /= k;
      const sx = u * cos + v * sin + c, sy = -u * sin + v * cos + c;
      const ix = Math.round(sx), iy = Math.round(sy);
      out[y * dim + x] = (ix >= 0 && iy >= 0 && ix < dim && iy < dim) ? src[iy * dim + ix] : 255;
    }
  let cur = out;
  for (let b = 0; b < blur; b++) {
    const t = new Float32Array(dim * dim);
    for (let y = 0; y < dim; y++)
      for (let x = 0; x < dim; x++) {
        let s = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const yy = y + dy, xx = x + dx;
            if (yy < 0 || xx < 0 || yy >= dim || xx >= dim) continue;
            s += cur[yy * dim + xx]; n++;
          }
        t[y * dim + x] = s / n;
      }
    cur = t;
  }
  let s = seed >>> 0;
  const rgba = new Uint8ClampedArray(dim * dim * 4);
  for (let i = 0; i < dim * dim; i++) {
    let v = (cur[i] - 128) * contrast + 128;
    if (noise) { s = (s * 1664525 + 1013904223) >>> 0; v += ((s >>> 24) / 255 - 0.5) * 255 * noise; }
    v = v < 0 ? 0 : v > 255 ? 255 : v;
    rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = v; rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

/* Conditions a phone actually produces: slight tilt, hand shake, angle. */
const CONDITIONS = [
  { name: 'clean',        o: {} },
  { name: 'rot 4',        o: { rot: 4 } },
  { name: 'rot -7',       o: { rot: -7 } },
  { name: 'persp 0.10',   o: { persp: 0.10 } },
  { name: 'blur 1',       o: { blur: 1 } },
  { name: 'blur 2',       o: { blur: 2 } },
  { name: 'noise 0.20',   o: { noise: 0.20 } },
  { name: 'contrast .5',  o: { contrast: 0.5 } },
  { name: 'shake',        o: { rot: 3, blur: 1, noise: 0.12 } }
];

/* A phone camera frame is capped around 1000px in the app, and the symbol
   fills most of the sender's screen. Pick the scale that mimics that. */
const CAPTURE = 900;

const CANDIDATES = [];
for (const ver of [14, 20, 26, 29, 33, 37, 40])
  for (const ecl of [QR.ECL.L, QR.ECL.M])
    CANDIDATES.push({ ver, ecl });

console.log('ver  ecl  modules  px/mod  payload  decode_ms  success   bytes/s@success');
console.log('-'.repeat(78));

const results = [];
for (const c of CANDIDATES) {
  const chars = QR.capacityAlnum(c.ver, c.ecl);
  const payload = Fountain.bytesForChars(chars);
  const block = payload - 9;
  const size = c.ver * 4 + 17;
  const quiet = 4;
  const scale = Math.max(2, Math.floor(CAPTURE / (size + quiet * 2)));
  const pxPerModule = scale;

  let ok = 0, total = 0, ms = 0;
  for (let rep = 0; rep < 2; rep++) {
    const text = Fountain.base45Encode(
      Fountain.encodeDroplet(7, rep + 1, rand(block, c.ver * 31 + rep)));
    const q = QR.encode(text, { ecl: c.ecl, version: c.ver });
    const { g, dim } = render(q, scale, quiet);
    for (const cond of CONDITIONS) {
      const rgba = warp(g, dim, cond.o, c.ver * 17 + rep);
      const t0 = process.hrtime.bigint();
      const got = QRDecode.decode(rgba, dim, dim);
      ms += Number(process.hrtime.bigint() - t0) / 1e6;
      total++;
      if (got === text) ok++;
    }
  }
  const success = ok / total;
  const avgMs = ms / total;
  // A decode costs avgMs; the sender can go no faster than the receiver reads.
  const fps = Math.min(20, 1000 / Math.max(avgMs, 50));
  const bps = block * fps * success;
  results.push({ ...c, block, pxPerModule, avgMs, success, fps, bps, size });
  console.log(
    `${String(c.ver).padStart(3)}  ${ECL_NAME[c.ecl].padEnd(3)}  ${String(size).padStart(7)}  ` +
    `${String(pxPerModule).padStart(6)}  ${String(block).padStart(7)}  ${avgMs.toFixed(1).padStart(9)}  ` +
    `${(success * 100).toFixed(0).padStart(6)}%  ${(bps / 1024).toFixed(1).padStart(14)} KB/s`);
}

console.log('\nRanked by usable throughput (success-weighted):');
results.filter(r => r.success >= 0.85)
  .sort((a, b) => b.bps - a.bps).slice(0, 6)
  .forEach(r => console.log(
    `  v${r.ver} ${ECL_NAME[r.ecl]}  ${r.block} B/frame  ${(r.bps / 1024).toFixed(1)} KB/s  ` +
    `(${(r.success * 100).toFixed(0)}% readable, ${r.avgMs.toFixed(0)} ms/decode)`));
