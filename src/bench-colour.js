/* Can colour carry more data per frame?
 *
 * The idea: render three independent QR symbols into the red, green and blue
 * channels of one image, tripling the payload. The obstacle is that camera
 * pipelines carry colour at lower resolution than brightness — YUV 4:2:0
 * halves chroma in both axes — and screens, white balance and sensor crosstalk
 * all shift hue. This measures what actually survives that path.
 *
 * Two schemes are tested:
 *   rgb3  - three full symbols, one per channel (3x payload if it works)
 *   duo   - two symbols: one in luminance, one in the blue-yellow axis (2x)
 */
const QR = require('./qr.js');
const QRD = require('./qrdecode.js');

function ra(n, seed) {
  const A = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
  let s = seed >>> 0, o = '';
  for (let i = 0; i < n; i++) { s = (s * 1664525 + 1013904223) >>> 0; o += A[(s >>> 24) % A.length]; }
  return o;
}

/* Draw symbols into separate channels at a given module size. */
function renderMulti(qs, scale, quiet, scheme) {
  const size = qs[0].size;
  const dim = (size + quiet * 2) * scale;
  const R = new Float32Array(dim * dim).fill(255);
  const G = new Float32Array(dim * dim).fill(255);
  const B = new Float32Array(dim * dim).fill(255);
  const put = (arr, q) => {
    for (let y = 0; y < q.size; y++)
      for (let x = 0; x < q.size; x++) {
        if (!q.modules[y * q.size + x]) continue;
        for (let dy = 0; dy < scale; dy++)
          for (let dx = 0; dx < scale; dx++)
            arr[((y + quiet) * scale + dy) * dim + ((x + quiet) * scale + dx)] = 0;
      }
  };
  if (scheme === 'rgb3') { put(R, qs[0]); put(G, qs[1]); put(B, qs[2]); }
  else { put(R, qs[0]); put(G, qs[0]); put(B, qs[1]); }   // luma + blue axis
  return { R, G, B, dim };
}

/* The camera path: chroma subsampled 2x2, blur, noise, and a white-balance
   gain per channel — every one of which a real phone applies. */
function throughCamera({ R, G, B, dim }, { blur = 1, noise = 0.05, wb = [1.06, 1.0, 0.94], subsample = true }) {
  const Y = new Float32Array(dim * dim);
  const U = new Float32Array(dim * dim);
  const V = new Float32Array(dim * dim);
  for (let i = 0; i < dim * dim; i++) {
    const r = R[i] * wb[0], g = G[i] * wb[1], b = B[i] * wb[2];
    Y[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    U[i] = -0.169 * r - 0.331 * g + 0.5 * b + 128;
    V[i] = 0.5 * r - 0.419 * g - 0.081 * b + 128;
  }
  const halve = arr => {
    if (!subsample) return arr;
    const out = new Float32Array(dim * dim);
    for (let y = 0; y < dim; y += 2)
      for (let x = 0; x < dim; x += 2) {
        let s = 0, n = 0;
        for (let dy = 0; dy < 2 && y + dy < dim; dy++)
          for (let dx = 0; dx < 2 && x + dx < dim; dx++) { s += arr[(y + dy) * dim + x + dx]; n++; }
        const avg = s / n;
        for (let dy = 0; dy < 2 && y + dy < dim; dy++)
          for (let dx = 0; dx < 2 && x + dx < dim; dx++) out[(y + dy) * dim + x + dx] = avg;
      }
    return out;
  };
  const U2 = halve(U), V2 = halve(V);

  let Yb = Y;
  for (let b2 = 0; b2 < blur; b2++) {
    const t = new Float32Array(dim * dim);
    for (let y = 0; y < dim; y++)
      for (let x = 0; x < dim; x++) {
        let s = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const yy = y + dy, xx = x + dx;
            if (yy < 0 || xx < 0 || yy >= dim || xx >= dim) continue;
            s += Yb[yy * dim + xx]; n++;
          }
        t[y * dim + x] = s / n;
      }
    Yb = t;
  }

  const out = new Uint8ClampedArray(dim * dim * 4);
  let s = 777;
  for (let i = 0; i < dim * dim; i++) {
    const y = Yb[i], u = U2[i] - 128, v = V2[i] - 128;
    let r = y + 1.402 * v, g = y - 0.344 * u - 0.714 * v, b = y + 1.772 * u;
    s = (s * 1664525 + 1013904223) >>> 0;
    const nz = ((s >>> 24) / 255 - 0.5) * 255 * noise;
    out[i * 4]     = Math.max(0, Math.min(255, r + nz));
    out[i * 4 + 1] = Math.max(0, Math.min(255, g + nz));
    out[i * 4 + 2] = Math.max(0, Math.min(255, b + nz));
    out[i * 4 + 3] = 255;
  }
  return out;
}

/* Pull one channel out as a greyscale RGBA buffer the decoder can read. */
function channel(rgba, dim, which) {
  const g = new Uint8ClampedArray(dim * dim * 4);
  for (let i = 0; i < dim * dim; i++) {
    let v;
    if (which === 'r') v = rgba[i * 4];
    else if (which === 'g') v = rgba[i * 4 + 1];
    else if (which === 'b') v = rgba[i * 4 + 2];
    else if (which === 'y') v = 0.299 * rgba[i*4] + 0.587 * rgba[i*4+1] + 0.114 * rgba[i*4+2];
    else { // blue-yellow axis, normalised
      const u = -0.169 * rgba[i*4] - 0.331 * rgba[i*4+1] + 0.5 * rgba[i*4+2];
      v = Math.max(0, Math.min(255, 128 + u * 2.2));
    }
    g[i * 4] = g[i * 4 + 1] = g[i * 4 + 2] = v; g[i * 4 + 3] = 255;
  }
  return g;
}

const VER = Number(process.argv[2]) || 14;
const ECL = process.argv[3] === 'L' ? QR.ECL.L : QR.ECL.M;
const PXMOD = Number(process.argv[4]) || 6;
const chars = QR.capacityAlnum(VER, ECL);
const CONDS = [
  { label: 'ideal (no subsample)', o: { blur: 0, noise: 0.02, wb: [1,1,1], subsample: false } },
  { label: 'camera, gentle',       o: { blur: 1, noise: 0.05 } },
  { label: 'camera, typical',      o: { blur: 1, noise: 0.10 } },
  { label: 'camera, shaky',        o: { blur: 2, noise: 0.12 } }
];

console.log(`v${VER} symbols, ${chars} chars each, \ px/module\n`);
console.log('scheme  condition                planes recovered   effective payload');
console.log('-'.repeat(70));

for (const scheme of ['rgb3', 'duo']) {
  const planes = scheme === 'rgb3' ? 3 : 2;
  for (const cond of CONDS) {
    let okTotal = 0, trials = 3;
    for (let t = 0; t < trials; t++) {
      const texts = [];
      const qs = [];
      for (let i = 0; i < planes; i++) {
        const txt = ra(chars, VER * 91 + t * 7 + i);
        texts.push(txt);
        qs.push(QR.encode(txt, { ecl: ECL, version: VER }));
      }
      const img = renderMulti(qs, PXMOD, 4, scheme);
      const rgba = throughCamera(img, cond.o);
      const picks = scheme === 'rgb3' ? ['r', 'g', 'b'] : ['y', 'u'];
      for (let i = 0; i < planes; i++) {
        const grey = channel(rgba, img.dim, picks[i]);
        if (QRD.decode(grey, img.dim, img.dim) === texts[i]) okTotal++;
      }
    }
    const rate = okTotal / (trials * planes);
    const effective = (rate * planes).toFixed(2);
    console.log(`${scheme.padEnd(8)}${cond.label.padEnd(25)}${(okTotal + '/' + trials * planes).padEnd(18)}` +
                `${effective}x  ${rate < 0.99 ? '<- lossy' : ''}`);
  }
  console.log('');
}

/* Baseline: one plain symbol through the same camera path. */
let base = 0;
for (const cond of CONDS) {
  let ok = 0;
  for (let t = 0; t < 3; t++) {
    const txt = ra(chars, VER * 91 + t);
    const q = QR.encode(txt, { ecl: ECL, version: VER });
    const img = renderMulti([q, q, q], PXMOD, 4, 'rgb3');
    // grey: same symbol in all three channels
    const rgba = throughCamera(img, cond.o);
    if (QRD.decode(channel(rgba, img.dim, 'y'), img.dim, img.dim) === txt) ok++;
  }
  console.log(`baseline  ${cond.label.padEnd(25)}${ok}/3 monochrome`);
  base += ok;
}
