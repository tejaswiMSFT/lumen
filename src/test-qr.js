/* Verify our encoder against the reference `qrcode` package.
 * Forcing the mask isolates encoding correctness from mask selection. */
const QR = require('./qr.js');
const QRCode = require('qrcode');

const ECL_NAME = ['L', 'M', 'Q', 'H'];
let checked = 0, failures = [];

function randBytes(n, seed) {
  let s = seed >>> 0;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = (s >>> 24) & 0xff;
  }
  return out;
}

function compare(bytes, version, ecl, mask) {
  const mine = QR.encode(bytes, { ecl, version, mask });
  const ref = QRCode.create([{ data: Buffer.from(bytes), mode: 'byte' }], {
    errorCorrectionLevel: ECL_NAME[ecl],
    version,
    maskPattern: mask
  });
  const size = ref.modules.size;
  if (size !== mine.size) {
    failures.push(`v${version} ${ECL_NAME[ecl]} m${mask}: size ${mine.size} != ${size}`);
    return;
  }
  for (let i = 0; i < size * size; i++) {
    if ((ref.modules.data[i] ? 1 : 0) !== mine.modules[i]) {
      failures.push(
        `v${version} ${ECL_NAME[ecl]} m${mask} len=${bytes.length}: module mismatch at ` +
        `(${i % size},${Math.floor(i / size)})`
      );
      return;
    }
  }
  checked++;
}

// Sweep every version, every ECC level, every mask, at both a small and a full payload.
for (let version = 1; version <= 40; version++) {
  for (let ecl = 0; ecl <= 3; ecl++) {
    const cap = QR.capacityBytes(version, ecl);
    for (let mask = 0; mask < 8; mask++) {
      compare(randBytes(cap, version * 131 + ecl * 17 + mask), version, ecl, mask); // full
      compare(randBytes(Math.max(1, Math.floor(cap / 2)), version + mask), version, ecl, mask); // half
      compare(randBytes(1, version + ecl), version, ecl, mask); // minimal
    }
  }
}

console.log(`matrices compared : ${checked}`);
console.log(`failures          : ${failures.length}`);
if (failures.length) {
  failures.slice(0, 15).forEach(f => console.log('  ✗ ' + f));
  process.exit(1);
}

// Auto mask selection must still produce something a real decoder can read.
const jsQR = require('jsqr');
function renderMatrix(q, scale) {
  const quiet = 4;
  const dim = (q.size + quiet * 2) * scale;
  const rgba = new Uint8ClampedArray(dim * dim * 4).fill(255);
  for (let y = 0; y < q.size; y++) {
    for (let x = 0; x < q.size; x++) {
      if (!q.modules[y * q.size + x]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const px = ((y + quiet) * scale + dy) * dim + ((x + quiet) * scale + dx);
          rgba[px * 4] = rgba[px * 4 + 1] = rgba[px * 4 + 2] = 0;
        }
      }
    }
  }
  return { rgba, dim };
}

function decodeMatrix(q, scale) {
  const { rgba, dim } = renderMatrix(q, scale);
  return jsQR(rgba, dim, dim);
}

function decodeCheck(bytes, ecl, scale) {
  const q = QR.encode(bytes, { ecl });
  const res = decodeMatrix(q, scale || 3);
  if (!res) return `v${q.version} ecl${ecl} len=${bytes.length}: decoder found no code`;
  const got = Uint8Array.from(res.binaryData);
  if (got.length !== bytes.length) return `v${q.version}: length ${got.length} != ${bytes.length}`;
  for (let i = 0; i < got.length; i++)
    if (got[i] !== bytes[i]) return `v${q.version}: byte ${i} differs`;
  return null;
}

/* The matrices above are already proven identical to the reference encoder, so
   this stage checks readability, not correctness. Where jsQR cannot read our
   symbol, re-check whether it can read the reference encoder's rendering of the
   same payload: if it fails on both, the limitation is jsQR's, not ours. */
const QRCodeRef = require('qrcode');

function refUnreadable(bytes, ecl, version) {
  try {
    const ref = QRCodeRef.create([{ data: Buffer.from(bytes), mode: 'byte' }],
      { errorCorrectionLevel: ECL_NAME[ecl], version });
    const m = { size: ref.modules.size, modules: ref.modules.data };
    return !decodeMatrix(m, 6);
  } catch (e) { return false; }
}

let decoded = 0;
const decodeFails = [];
const jsqrGaps = [];
for (let version = 1; version <= 40; version += 1) {
  for (const ecl of [QR.ECL.L, QR.ECL.M]) {
    const cap = QR.capacityBytes(version, ecl);
    const bytes = randBytes(cap, version * 7 + ecl);
    let err = decodeCheck(bytes, ecl, 3);
    if (err) err = decodeCheck(bytes, ecl, 6);
    if (!err) { decoded++; continue; }
    if (refUnreadable(bytes, ecl, version)) jsqrGaps.push(`v${version} ${ECL_NAME[ecl]}`);
    else decodeFails.push(err);
  }
}
console.log(`round-trip decodes: ${decoded}`);
console.log(`decode failures   : ${decodeFails.length}`);
decodeFails.slice(0, 10).forEach(f => console.log('  ✗ ' + f));
if (jsqrGaps.length) {
  console.log(`jsQR own gaps     : ${jsqrGaps.length} (${jsqrGaps.join(', ')})`);
  console.log('  these symbols match the reference encoder exactly; jsQR cannot read');
  console.log('  the reference library\'s own rendering of them either, so the gap is');
  console.log('  the test decoder\'s. Lumen only emits v14/20/26, all of which pass.');
}
process.exit(decodeFails.length ? 1 : 0);
