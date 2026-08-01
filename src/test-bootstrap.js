/* The field failure: the sender is plainly showing codes, the receiver reads a
 * handful, and it never locks — so nothing is ever assembled.
 *
 * Two causes, both guarded here:
 *   1. Droplets read before the manifest arrived were discarded. When codes are
 *      hard to read those are the ones you can least afford to lose.
 *   2. Manifests were too sparse: a receiver that manages 15 frames could catch
 *      none of them and sit forever saying nothing had arrived.
 */
const APP = require('./app-path');
const { webkit, devices } = require('playwright');

function line(l, ok, d) { console.log(`${ok ? 'PASS' : 'FAIL'}  ${l.padEnd(46)} ${d || ''}`); return ok ? 0 : 1; }

(async () => {
  let f = 0;
  const browser = await webkit.launch();
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();
  await page.goto(APP.appUrl());
  await page.waitForTimeout(900);

  const r = await page.evaluate(async () => {
    const { QR, Fountain, RX, PRESETS, go } = window.__qrs;
    const p = PRESETS[1];
    const src = new Uint8Array(40 * 1024);
    crypto.getRandomValues(src);

    const cv = document.createElement('canvas');
    const cx = cv.getContext('2d', { willReadFrequently:true });
    const read = text => {
      const q = QR.encode(text, { ecl:p.ecl, version:p.ver });
      const Q = 4, mod = 4, total = q.size + Q*2;
      cv.width = cv.height = total*mod;
      cx.fillStyle='#fff'; cx.fillRect(0,0,cv.width,cv.height);
      cx.fillStyle='#000';
      for (let y=0;y<q.size;y++) for (let x=0;x<q.size;x++)
        if (q.modules[y*q.size+x]) cx.fillRect((x+Q)*mod,(y+Q)*mod,mod,mod);
      return QRDecode.decode(cx.getImageData(0,0,cv.width,cv.height).data, cv.width, cv.height);
    };

    const enc = new Fountain.Encoder(src, p.block);
    const meta = { v:1, i:31, n:'held.bin', t:'application/octet-stream', s:src.length,
                   z:0, c:Fountain.crc32(src), k:enc.K, b:p.block, l:src.length, qv:p.ver };

    /* --- 1. Droplets seen before the manifest must be kept, not dropped --- */
    go('view-recv'); RX.reset(); RX.running = true; RX.engine = 'Built-in decoder';
    const early = 25;
    for (let i = 0; i < early; i++) {
      const d = enc.droplet();
      RX.onText(read(Fountain.base45Encode(Fountain.encodeDroplet(meta.i, d.seed, d.data))));
    }
    const heldBeforeManifest = RX.pending.length;
    const countBefore = RX.dec ? RX.dec.count : 0;

    RX.onText(read(Fountain.base45Encode(Fountain.encodeManifest(meta))));
    const countAfterManifest = RX.dec ? RX.dec.count : 0;
    const heldAfter = RX.pending.length;

    /* --- 2. A stingy receiver must still lock. Simulate one that reads only a
             small fraction of frames, as a phone held too far away does. --- */
    RX.reset(); RX.running = true; RX.engine = 'Built-in decoder';
    const enc2 = new Fountain.Encoder(src, p.block);
    const meta2 = Object.assign({}, meta, { i:32 });
    let framesEmitted = 0, framesRead = 0, lockedAtFrame = -1;
    const YIELD = 12;                       // reads 1 frame in 12
    while (framesEmitted < 700 && lockedAtFrame < 0) {
      const n = framesEmitted++;
      let text;
      if (window.__qrs.manifestDue ? window.__qrs.manifestDue(n)
                                   : (n < 2 || n % 8 === 0)) {
        text = Fountain.base45Encode(Fountain.encodeManifest(meta2));
      } else {
        const d = enc2.droplet();
        text = Fountain.base45Encode(Fountain.encodeDroplet(meta2.i, d.seed, d.data));
      }
      if (n % YIELD !== 0) continue;        // the receiver misses most frames
      framesRead++;
      RX.onText(read(text));
      if (RX.dec && lockedAtFrame < 0) lockedAtFrame = framesRead;
    }

    return {
      early, heldBeforeManifest, countBefore, countAfterManifest, heldAfter,
      lockedAtFrame, framesRead,
      K: enc.K
    };
  });

  f += line('early droplets are held, not dropped', r.heldBeforeManifest === r.early,
            `${r.heldBeforeManifest}/${r.early} held`);
  f += line('nothing decoded before the manifest', r.countBefore === 0);
  f += line('held droplets replay on lock', r.countAfterManifest >= r.early,
            `${r.countAfterManifest} blocks recovered`);
  f += line('buffer is drained after replay', r.heldAfter === 0);
  f += line('a receiver reading 1 frame in 12 still locks', r.lockedAtFrame > 0,
            r.lockedAtFrame > 0 ? `locked after ${r.lockedAtFrame} reads` : 'never locked');
  f += line('locks within a few reads', r.lockedAtFrame > 0 && r.lockedAtFrame <= 6,
            `${r.lockedAtFrame} reads`);

  await browser.close();
  console.log(f ? `\n${f} FAILURE(S)` : '\nBOOTSTRAP OK');
  process.exit(f ? 1 : 0);
})();
