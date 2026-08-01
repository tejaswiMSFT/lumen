const QR = require('./qr.js');
const F = require('./fountain.js');
const QRCode = require('qrcode');
const jsQR = require('jsqr');

const ECL_NAME = ['L', 'M', 'Q', 'H'];
function rb(n, seed) {
  let s = seed >>> 0;
  const o = new Uint8Array(n);
  for (let i = 0; i < n; i++) { s = (s * 1664525 + 1013904223) >>> 0; o[i] = (s >>> 24) & 255; }
  return o;
}

/* ---- 1. Base45 round-trip, including RFC 9285 test vectors ---- */
let b45ok = true;
const vectors = [['AB', 'BB8'], ['Hello!!', '%69 VD92EX0'], ['base-45', 'UJCLQE7W581'], ['ietf!', 'QED8WEX0']];
for (const [plain, expected] of vectors) {
  const got = F.base45Encode(new TextEncoder().encode(plain));
  if (got !== expected) { b45ok = false; console.log(`  ✗ vector "${plain}" -> "${got}" expected "${expected}"`); }
}
for (let t = 0; t < 3000; t++) {
  const src = rb(1 + (t % 700), t * 31 + 5);
  const back = F.base45Decode(F.base45Encode(src));
  if (!back || back.length !== src.length) { b45ok = false; break; }
  for (let i = 0; i < src.length; i++) if (back[i] !== src[i]) { b45ok = false; break; }
}
console.log('base45 round-trip + RFC vectors :', b45ok ? 'PASS' : 'FAIL');

/* ---- 2. Alphanumeric matrices must match the reference exactly ---- */
let alnumChecked = 0;
const alnumFails = [];
function randAlnum(n, seed) {
  let s = seed >>> 0, out = '';
  for (let i = 0; i < n; i++) { s = (s * 1664525 + 1013904223) >>> 0; out += QR.ALNUM_CHARS[(s >>> 16) % 45]; }
  return out;
}
for (let version = 1; version <= 40; version++) {
  for (let ecl = 0; ecl <= 3; ecl++) {
    const cap = QR.capacityAlnum(version, ecl);
    for (let mask = 0; mask < 8; mask++) {
      for (const len of [cap, Math.max(1, cap >> 1), 1]) {
        const text = randAlnum(len, version * 977 + ecl * 31 + mask + len);
        const mine = QR.encode(text, { ecl, version, mask });
        const ref = QRCode.create([{ data: text, mode: 'alphanumeric' }], {
          errorCorrectionLevel: ECL_NAME[ecl], version, maskPattern: mask
        });
        let bad = ref.modules.size !== mine.size;
        if (!bad) for (let i = 0; i < mine.size * mine.size; i++)
          if ((ref.modules.data[i] ? 1 : 0) !== mine.modules[i]) { bad = true; break; }
        if (bad) alnumFails.push(`v${version} ${ECL_NAME[ecl]} m${mask} len=${len}`);
        else alnumChecked++;
      }
    }
  }
}
console.log(`alphanumeric matrices vs reference : ${alnumChecked} ok, ${alnumFails.length} failed`);
alnumFails.slice(0, 8).forEach(f => console.log('  ✗ ' + f));

/* ---- 3. Full transport pipeline through a real decoder ---- */
function renderAndDecode(q, scale = 4, quiet = 4) {
  const dim = (q.size + quiet * 2) * scale;
  const rgba = new Uint8ClampedArray(dim * dim * 4).fill(255);
  for (let y = 0; y < q.size; y++) for (let x = 0; x < q.size; x++) {
    if (!q.modules[y * q.size + x]) continue;
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const p = ((y + quiet) * scale + dy) * dim + ((x + quiet) * scale + dx);
      rgba[p * 4] = rgba[p * 4 + 1] = rgba[p * 4 + 2] = 0;
    }
  }
  const r = jsQR(rgba, dim, dim);
  return r ? r.data : null;
}

const PRESETS = require('./presets.js').readPresets(QR);

console.log('\npreset    qrVer  chars  payload  block   ok');
console.log('--------------------------------------------------');
let pipelineOk = true;
for (const p of PRESETS) {
  const chars = QR.capacityAlnum(p.ver, p.ecl);
  const payloadBytes = F.bytesForChars(chars);
  const blockSize = payloadBytes - 9; // droplet header

  // Simulate a whole transfer end to end, losing 25% of frames.
  const original = rb(40 * 1024, 4242);
  const enc = new F.Encoder(original, blockSize);
  const dec = new F.Decoder(enc.K, blockSize, original.length);
  let lost = 0, seedCounter = 0, iterations = 0;
  while (!dec.isComplete() && iterations++ < enc.K * 8) {
    const d = enc.droplet(seedCounter++);
    const frame = F.encodeDroplet(99, d.seed, d.data);
    const text = F.base45Encode(frame);
    if (text.length > chars) { pipelineOk = false; console.log(`  ✗ ${p.name}: frame overflows QR (${text.length}>${chars})`); break; }
    if (iterations % 4 === 0) { lost++; continue; } // dropped frame
    const q = QR.encode(text, { ecl: p.ecl, version: p.ver });
    const decodedText = renderAndDecode(q);
    if (decodedText === null) { pipelineOk = false; console.log(`  ✗ ${p.name}: QR decode failed`); break; }
    const parsed = F.parseFrame(F.base45Decode(decodedText));
    if (!parsed || parsed.type !== 'droplet') { pipelineOk = false; console.log(`  ✗ ${p.name}: frame parse failed`); break; }
    dec.add(parsed.seed, parsed.data);
  }
  const out = dec.result();
  let match = !!out && out.length === original.length && F.crc32(out) === F.crc32(original);
  if (!match) pipelineOk = false;
  console.log(
    `${p.name.padEnd(9)} ${String(p.ver).padEnd(6)} ${String(chars).padEnd(6)} ` +
    `${String(payloadBytes).padEnd(8)} ${String(blockSize).padEnd(7)} ${match ? 'PASS' : 'FAIL'}`
  );
}

const allOk = b45ok && alnumFails.length === 0 && pipelineOk;
console.log('\noverall :', allOk ? 'PASS' : 'FAIL');
process.exit(allOk ? 0 : 1);
