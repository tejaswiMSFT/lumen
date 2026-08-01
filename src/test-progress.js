/* The receiver must always say where it has got to. A silent pill is what
 * makes a transfer feel stuck, which is the bug this guards against. */
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
    const p = PRESETS[2];                       // Fast
    const src = new Uint8Array(60 * 1024);
    crypto.getRandomValues(src);
    const enc = new Fountain.Encoder(src, p.block);
    const meta = { v:1, i:5, n:'p.bin', t:'application/octet-stream', s:src.length,
                   z:0, c:Fountain.crc32(src), k:enc.K, b:p.block, l:src.length, qv:p.ver };
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
    const pill = () => document.getElementById('aim-txt').textContent;
    const diag = () => document.getElementById('aim-diag').textContent;

    go('view-recv'); RX.reset(); RX.running = true;
    RX.engine = 'Built-in decoder';

    // Scanning has begun but nothing has been seen yet.
    RX.framesSeen = 0; RX.decodeHits = 0; RX.aimAt = 0;
    RX.paintAim(performance.now());
    const atStart = pill();

    // Codes are being read, but the manifest has not arrived yet.
    RX.framesSeen = 20; RX.decodeHits = 6; RX.aimAt = 0;
    RX.paintAim(performance.now());
    const beforeLock = pill();

    // Nothing readable at all.
    RX.reset(); RX.running = true;
    RX.framesSeen = 30; RX.decodeHits = 0; RX.aimAt = 0;
    RX.camRes = { w:1920, h:1080 };
    RX.paintAim(performance.now());
    const nothingSeen = pill();
    const diagBefore = diag();

    // Now run a real transfer and sample the pill as it goes.
    RX.reset(); RX.running = true;
    RX.engine = 'Built-in decoder'; RX.lockedAt = performance.now();
    RX.onText(read(Fountain.base45Encode(Fountain.encodeManifest(meta))));
    if (!RX.dec) return { error: 'manifest rejected' };

    const sheetShown = !document.getElementById('recv-sheet').classList.contains('hidden');
    const samples = [];
    let n = 0;
    while (!RX.dec.isComplete() && n < enc.K * 6) {
      n++;
      const d = enc.droplet();
      const got = read(Fountain.base45Encode(Fountain.encodeDroplet(meta.i, d.seed, d.data)));
      if (got) RX.onText(got);
      RX.aimAt = 0;                       // sample without the 400 ms throttle
      RX.paintAim(performance.now());
      if (n % 12 === 0) samples.push(pill());
    }
    return {
      atStart, beforeLock, nothingSeen, sheetShown, samples, diagBefore,
      diagDuring: diag(),
      blocks: enc.K, frames: n,
      pctEl: document.getElementById('pct').textContent,
      blocksEl: document.getElementById('blocks').textContent
    };
  });

  if (r.error) { console.log('FAIL ', r.error); process.exit(1); }

  f += line('idle: tells the user where to point', /point at the sending screen/i.test(r.atStart), `"${r.atStart}"`);
  f += line('reading, not yet locked: says so', /waiting for the file details/i.test(r.beforeLock), `"${r.beforeLock}"`);
  f += line('nothing readable: gives a remedy', /fill the bright square/i.test(r.nothingSeen), `"${r.nothingSeen}"`);
  f += line('progress sheet appears on lock', r.sheetShown === true);
  f += line('diagnostics show scans and codes', /\d+ scans · \d+ codes/.test(r.diagBefore), `"${r.diagBefore}"`);
  f += line('diagnostics switch to droplet counts', /good · .*repeat/.test(r.diagDuring), `"${r.diagDuring}"`);

  const withPct = r.samples.filter(s => /Receiving \d+%/.test(s));
  f += line('pill shows a live percentage', withPct.length >= 3,
            r.samples.length ? `e.g. "${withPct[Math.floor(withPct.length/2)] || r.samples[0]}"` : 'no samples');

  const pcts = withPct.map(s => parseInt(s.match(/Receiving (\d+)%/)[1], 10));
  const rising = pcts.every((v, i) => i === 0 || v >= pcts[i - 1]);
  f += line('percentage never goes backwards', rising, pcts.length ? `${pcts[0]}% → ${pcts[pcts.length-1]}%` : '');
  f += line('block counter matches the ring', r.blocksEl === `${r.blocks}/${r.blocks}`, r.blocksEl);
  f += line('finishes at 100%', r.pctEl === '100%', r.pctEl);

  await browser.close();
  console.log(f ? `\n${f} FAILURE(S)` : '\nRECEIVER FEEDBACK OK');
  process.exit(f ? 1 : 0);
})();
