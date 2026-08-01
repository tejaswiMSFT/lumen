/* What a phone actually sees.
 *
 * The receiver downscales the camera frame to 1000 px on its LONG edge, then
 * decodes. In portrait that leaves ~563 px on the short edge, and the sender's
 * QR only fills part of it — so a v26 symbol (121 modules) can end up with
 * under 3 px per module. This measures decode success against how much of the
 * frame the symbol fills, for each preset, at the real capture pipeline.
 */
const QR = require('./qr.js');
const QRD = require('./qrdecode.js');
const F = require('./fountain.js');
const { readPresets } = require('./presets.js');

const ECLN = ['L', 'M', 'Q', 'H'];
const PRESETS = readPresets(QR);
PRESETS.forEach(p => {
  p.chars = QR.capacityAlnum(p.ver, p.ecl);
  p.payload = F.bytesForChars(p.chars);
  p.block = p.payload - 9;
});

function ra(n, seed) {
  const A = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
  let s = seed >>> 0, o = '';
  for (let i = 0; i < n; i++) { s = (s * 1664525 + 1013904223) >>> 0; o += A[(s >>> 24) % A.length]; }
  return o;
}

/* Paint the symbol into a camera-sized frame at a given fill fraction, add the
   imperfections a hand-held phone always has, then run the receiver's own
   downscale-and-decode path. */
function capture(q, { camW, camH, fill, target, mode = 'full', blur = 1, noise = 0.06, rot = 2 }) {
  const frame = new Float32Array(camW * camH).fill(210);   // screens are not pure white
  const side = Math.round(Math.min(camW, camH) * fill);
  const quiet = 4;
  const modPx = side / (q.size + quiet * 2);
  const ox = Math.round((camW - side) / 2), oy = Math.round((camH - side) / 2);

  const cos = Math.cos(rot * Math.PI / 180), sin = Math.sin(rot * Math.PI / 180);
  const cx = ox + side / 2, cy = oy + side / 2;
  for (let y = oy; y < oy + side; y++) {
    for (let x = ox; x < ox + side; x++) {
      const dx = x - cx, dy = y - cy;
      const sx = dx * cos + dy * sin + cx, sy = -dx * sin + dy * cos + cy;
      const mx = Math.floor((sx - ox) / modPx) - quiet;
      const my = Math.floor((sy - oy) / modPx) - quiet;
      let v = 235;
      if (mx >= 0 && my >= 0 && mx < q.size && my < q.size)
        v = q.modules[my * q.size + mx] ? 25 : 235;
      frame[y * camW + x] = v;
    }
  }

  let cur = frame;
  for (let b = 0; b < blur; b++) {
    const t = new Float32Array(camW * camH);
    for (let y = 0; y < camH; y++)
      for (let x = 0; x < camW; x++) {
        let s = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const yy = y + dy, xx = x + dx;
            if (yy < 0 || xx < 0 || yy >= camH || xx >= camW) continue;
            s += cur[yy * camW + xx]; n++;
          }
        t[y * camW + x] = s / n;
      }
    cur = t;
  }

  // The receiver's capture: either a native-resolution centre-square crop
  // (capped) or the whole frame downscaled, matching makeDetector().
  let sx, sy, cropSide, w, h;
  if (mode === 'crop') {
    cropSide = Math.min(camW, camH);
    sx = Math.round((camW - cropSide) / 2); sy = Math.round((camH - cropSide) / 2);
    const sc = Math.min(1, 1200 / cropSide);
    w = h = Math.max(1, Math.round(cropSide * sc));
  } else {
    cropSide = 0; sx = 0; sy = 0;
    const sc = Math.min(1, target / Math.max(camW, camH));
    w = Math.max(1, Math.round(camW * sc));
    h = Math.max(1, Math.round(camH * sc));
  }
  const srcW = mode === 'crop' ? cropSide : camW;
  const srcH = mode === 'crop' ? cropSide : camH;
  const scaleX = w / srcW, scaleY = h / srcH;

  const rgba = new Uint8ClampedArray(w * h * 4);
  let s = 12345;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const x0 = sx + Math.floor(x / scaleX), x1 = sx + Math.min(srcW, Math.floor((x + 1) / scaleX));
      const y0 = sy + Math.floor(y / scaleY), y1 = sy + Math.min(srcH, Math.floor((y + 1) / scaleY));
      let sum = 0, n = 0;
      for (let yy = y0; yy < Math.max(y1, y0 + 1); yy++)
        for (let xx = x0; xx < Math.max(x1, x0 + 1); xx++) { sum += cur[yy * camW + xx]; n++; }
      let v = sum / n;
      s = (s * 1664525 + 1013904223) >>> 0;
      v += ((s >>> 24) / 255 - 0.5) * 255 * noise;
      v = v < 0 ? 0 : v > 255 ? 255 : v;
      const i = (y * w + x) * 4;
      rgba[i] = rgba[i + 1] = rgba[i + 2] = v; rgba[i + 3] = 255;
    }
  return { rgba, w, h, modPx: modPx * scaleX };
}

const CAM = [
  { label: 'portrait 1080x1920', camW: 1080, camH: 1920 },
  { label: 'landscape 1920x1080', camW: 1920, camH: 1080 }
];
const FILLS = [0.9, 0.7, 0.5];
const RUN = require.main === module;
const MODES = process.argv[2] === 'crop' ? ['crop'] : process.argv[2] === 'both' ? ['full','crop'] : ['full'];
const TARGETS = [1000];

if (RUN) for (const mode of MODES) {
  const target = 1000;
  console.log(`\n=== capture mode: ${mode === 'crop' ? 'native centre crop (new)' : 'downscale whole frame to 1000 (old)'} ===`);
  console.log('preset        cam                  fill  px/module  decoded');
  console.log('-'.repeat(64));
  for (const p of PRESETS) {
    for (const cam of CAM) {
      for (const fill of FILLS) {
        let ok = 0, mod = 0;
        const trials = 3;
        for (let t = 0; t < trials; t++) {
          const text = ra(p.chars, p.ver * 71 + t);
          const q = QR.encode(text, { ecl: p.ecl, version: p.ver });
          const c = capture(q, { ...cam, fill, target, mode });
          mod = c.modPx;
          if (QRD.decode(c.rgba, c.w, c.h) === text) ok++;
        }
        const tag = `${p.name} v${p.ver}${ECLN[p.ecl]}`;
        console.log(`${tag.padEnd(14)}${cam.label.padEnd(21)}${String(Math.round(fill*100)+'%').padEnd(6)}` +
                    `${mod.toFixed(2).padStart(9)}  ${ok}/${trials}${ok < trials ? '   <-- fails' : ''}`);
      }
    }
  }
}

module.exports = { capture };
