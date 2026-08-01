/* Exercise the from-scratch decoder against our own encoder,
 * including the distortions a real camera introduces. */
const QR = require('./qr.js');
const QRD = require('./qrdecode.js');
const F = require('./fountain.js');

function ra(n, seed) {
  let s = seed >>> 0, o = '';
  for (let i = 0; i < n; i++) { s = (s * 1664525 + 1013904223) >>> 0; o += QR.ALNUM_CHARS[(s >>> 16) % 45]; }
  return o;
}

/* Render a QR into an RGBA buffer, optionally with rotation, perspective,
   blur, noise and a non-integer scale — i.e. what a handheld camera produces. */
function render(q, opts = {}) {
  const scale = opts.scale || 4;
  const quiet = opts.quiet == null ? 4 : opts.quiet;
  const pad = opts.pad || 0;
  const side = Math.round((q.size + quiet * 2) * scale) + pad * 2;
  const W = side, H = side;
  const rgba = new Uint8ClampedArray(W * H * 4).fill(255);

  const rot = (opts.rotate || 0) * Math.PI / 180;
  const persp = opts.perspective || 0;
  const cx = W / 2, cy = H / 2;
  const cos = Math.cos(-rot), sin = Math.sin(-rot);

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      // Map destination pixel back into code space.
      let dx = x - cx, dy = y - cy;
      let rx = dx * cos - dy * sin;
      let ry = dx * sin + dy * cos;
      if (persp) {
        const k = 1 + persp * (ry / (H / 2));
        rx /= k; ry /= k;
      }
      const sxp = rx + cx - pad, syp = ry + cy - pad;
      const mx = Math.floor(sxp / scale) - quiet;
      const my = Math.floor(syp / scale) - quiet;
      let dark = 0;
      if (mx >= 0 && my >= 0 && mx < q.size && my < q.size) dark = q.modules[my * q.size + mx];
      else if (sxp < 0 || syp < 0 || sxp >= (q.size + quiet * 2) * scale || syp >= (q.size + quiet * 2) * scale) dark = 0;
      const v = dark ? 0 : 255;
      const p = (y * W + x) * 4;
      rgba[p] = rgba[p + 1] = rgba[p + 2] = v;
    }
  }

  if (opts.blur) boxBlur(rgba, W, H, opts.blur);
  if (opts.noise) {
    let s = 12345;
    for (let i = 0; i < W * H; i++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      const n = (((s >>> 20) & 255) - 128) * opts.noise;
      const p = i * 4;
      const v = Math.max(0, Math.min(255, rgba[p] + n));
      rgba[p] = rgba[p + 1] = rgba[p + 2] = v;
    }
  }
  if (opts.contrast != null) {
    for (let i = 0; i < W * H; i++) {
      const p = i * 4;
      const v = 128 + (rgba[p] - 128) * opts.contrast;
      rgba[p] = rgba[p + 1] = rgba[p + 2] = Math.max(0, Math.min(255, v));
    }
  }
  return { rgba, W, H };
}

function boxBlur(rgba, W, H, r) {
  const src = Uint8ClampedArray.from(rgba);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let sum = 0, n = 0;
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= H) continue;
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx; if (xx < 0 || xx >= W) continue;
          sum += src[(yy * W + xx) * 4]; n++;
        }
      }
      const p = (y * W + x) * 4;
      rgba[p] = rgba[p + 1] = rgba[p + 2] = sum / n;
    }
  }
}

function run(label, opts, versions = [8, 14, 20, 26], trials = 3) {
  let ok = 0, total = 0;
  for (const v of versions) {
    for (let t = 0; t < trials; t++) {
      const text = ra(Math.min(QR.capacityAlnum(v, QR.ECL.M), 900), v * 31 + t);
      const q = QR.encode(text, { ecl: QR.ECL.M, version: v });
      const img = render(q, opts);
      const got = QRD.decode(img.rgba, img.W, img.H);
      total++;
      if (got === text) ok++;
    }
  }
  const pct = Math.round((ok / total) * 100);
  console.log(`${label.padEnd(34)} ${String(ok + '/' + total).padEnd(8)} ${pct}%`);
  return { ok, total };
}

console.log('condition                          passed   rate');
console.log('---------------------------------------------------');
let agg = { ok: 0, total: 0 };
const add = r => { agg.ok += r.ok; agg.total += r.total; };

add(run('clean, scale 4',        { scale: 4 }));
add(run('clean, scale 3',        { scale: 3 }));
add(run('clean, scale 6',        { scale: 6 }));
add(run('non-integer scale 3.7', { scale: 3.7 }));
add(run('minimal quiet zone (2)',{ scale: 4, quiet: 2 }));
add(run('extra padding',         { scale: 4, pad: 40 }));
add(run('rotated 3 deg',         { scale: 5, pad: 30, rotate: 3 }));
add(run('rotated 8 deg',         { scale: 5, pad: 40, rotate: 8 }));
add(run('rotated -12 deg',       { scale: 5, pad: 50, rotate: -12 }));
add(run('perspective 0.10',      { scale: 5, pad: 30, perspective: 0.10 }));
add(run('perspective 0.18',      { scale: 5, pad: 30, perspective: 0.18 }));
add(run('blur r=1',              { scale: 5, blur: 1 }));
add(run('blur r=2',              { scale: 6, blur: 2 }));
add(run('noise 0.25',            { scale: 4, noise: 0.25 }));
add(run('low contrast 0.45',     { scale: 4, contrast: 0.45 }));
add(run('rotate+blur+noise',     { scale: 6, pad: 40, rotate: 5, blur: 1, noise: 0.15 }));

console.log('---------------------------------------------------');
console.log(`TOTAL                              ${agg.ok}/${agg.total}   ${Math.round(agg.ok/agg.total*100)}%`);

/* The presets as shipped, at their full payload — the exact symbols a phone
   will actually have to read, including the lower ECC used by Fast. */
const PRESETS = require('./presets.js').readPresets(QR);
const ECLN = ['L','M','Q','H'];
const REAL = [
  { label: 'hand-held',   o: { scale: 5, pad: 30, rotate: 4, blur: 1, noise: 0.10 } },
  { label: 'at an angle', o: { scale: 5, pad: 30, perspective: 0.10 } },
  { label: 'soft focus',  o: { scale: 6, blur: 2 } },
  { label: 'dim screen',  o: { scale: 5, contrast: 0.5 } }
];
console.log('\npreset symbols at full payload');
console.log('---------------------------------------------------');
let presetOk = 0, presetTotal = 0;
for (const p of PRESETS) {
  const chars = QR.capacityAlnum(p.ver, p.ecl);
  let ok = 0, total = 0;
  const per = [];
  for (const cond of REAL) {
    let cOk = 0;
    for (let t = 0; t < 3; t++) {
      const text = ra(chars, p.ver * 53 + t);
      const q = QR.encode(text, { ecl: p.ecl, version: p.ver });
      const img = render(q, cond.o);
      if (QRD.decode(img.rgba, img.W, img.H) === text) { ok++; cOk++; }
      total++;
    }
    per.push(`${cond.label} ${cOk}/3`);
  }
  presetOk += ok; presetTotal += total;
  console.log(`${(p.name + ' v' + p.ver + ' ' + ECLN[p.ecl] + ' ' + chars + 'ch').padEnd(34)} ` +
              `${String(ok + '/' + total).padEnd(8)} ${String(Math.round(ok / total * 100) + '%').padEnd(6)} ` +
              per.join('  '));
}

process.exit(agg.ok / agg.total > 0.9 && presetOk / presetTotal > 0.8 ? 0 : 1);

/* Full wire-format round trip through the decoder. */
const payload = new Uint8Array(600);
for (let i = 0; i < payload.length; i++) payload[i] = (i * 37) & 255;
const frame = F.encodeDroplet(1234, 99, payload.subarray(0, 637 - 0));
const text = F.base45Encode(frame);
const q = QR.encode(text, { ecl: QR.ECL.M, version: 20 });
const img = render(q, { scale: 4 });
const back = QRD.decode(img.rgba, img.W, img.H);
const parsed = back ? F.parseFrame(F.base45Decode(back)) : null;
console.log('\nwire round-trip through decoder :',
  parsed && parsed.type === 'droplet' && parsed.seed === 99 && parsed.transferId === 1234 ? 'PASS' : 'FAIL');

process.exit(agg.ok / agg.total > 0.9 ? 0 : 1);
