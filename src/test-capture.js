/* Guards the failure that actually bit in the field: the sender is plainly
 * showing codes, and the receiver reports it cannot see one.
 *
 * Cause was resolution. The receiver downscaled the whole camera frame to
 * 1000 px, so a v26 symbol filling a normal 70% of a portrait frame arrived at
 * ~3 px per module and never decoded. This asserts that every shipping preset
 * survives the real capture path at ordinary holding distances.
 */
const QR = require('./qr.js');
const QRD = require('./qrdecode.js');
const F = require('./fountain.js');
const { capture } = require('./bench-capture.js');
const { readPresets } = require('./presets.js');

const ECLN = ['L', 'M', 'Q', 'H'];
const PRESETS = readPresets(QR);
PRESETS.forEach(p => { p.chars = QR.capacityAlnum(p.ver, p.ecl); });

function ra(n, seed) {
  const A = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
  let s = seed >>> 0, o = '';
  for (let i = 0; i < n; i++) { s = (s * 1664525 + 1013904223) >>> 0; o += A[(s >>> 24) % A.length]; }
  return o;
}

const CAMS = [
  { label: 'portrait',  camW: 1080, camH: 1920 },
  { label: 'landscape', camW: 1920, camH: 1080 }
];
// How much of the frame the sender's symbol fills. 0.9 is holding it close,
// 0.7 is a natural arm's-length grip — both must work.
const FILLS = [0.9, 0.7];

let failures = 0;
console.log('preset          orientation  fill  px/module  decoded');
console.log('-'.repeat(58));

for (const p of PRESETS) {
  for (const cam of CAMS) {
    for (const fill of FILLS) {
      let ok = 0, mod = 0;
      const trials = 3;
      for (let t = 0; t < trials; t++) {
        const text = ra(p.chars, p.ver * 71 + t);
        const q = QR.encode(text, { ecl: p.ecl, version: p.ver });
        const c = capture(q, { ...cam, fill, target: 1000, mode: 'crop' });
        mod = c.modPx;
        if (QRD.decode(c.rgba, c.w, c.h) === text) ok++;
      }
      const good = ok === trials;
      if (!good) failures++;
      console.log(`${(p.name + ' v' + p.ver + ECLN[p.ecl]).padEnd(16)}${cam.label.padEnd(13)}` +
                  `${String(Math.round(fill * 100) + '%').padEnd(6)}${mod.toFixed(1).padStart(9)}  ` +
                  `${ok}/${trials}${good ? '' : '   <-- FAIL'}`);
    }
  }
}

/* And a full wire frame, not just filler text — the real thing a phone reads. */
const p = PRESETS[PRESETS.length - 1];
const payload = new Uint8Array(F.bytesForChars(p.chars) - 9);
for (let i = 0; i < payload.length; i++) payload[i] = (i * 31) & 255;
const text = F.base45Encode(F.encodeDroplet(4242, 17, payload));
const q = QR.encode(text, { ecl: p.ecl, version: p.ver });
const c = capture(q, { camW: 1080, camH: 1920, fill: 0.75, target: 1000, mode: 'crop' });
const back = QRD.decode(c.rgba, c.w, c.h);
const parsed = back ? F.parseFrame(F.base45Decode(back)) : null;
const wireOk = !!parsed && parsed.type === 'droplet' && parsed.seed === 17 && parsed.transferId === 4242;
console.log(`\nwire droplet through the camera path : ${wireOk ? 'PASS' : 'FAIL'}`);
if (!wireOk) failures++;

console.log(failures ? `\n${failures} FAILURE(S)` : '\nCAPTURE OK');
process.exit(failures ? 1 : 0);
