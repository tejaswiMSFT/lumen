/* Verify the published GitHub Pages site behaves in WebKit. */
const { webkit, devices } = require('playwright');

const URL_ = process.argv[2] || 'https://tejaswimsft.github.io/lumen/';

(async () => {
  const browser = await webkit.launch();
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));

  const reqs = [];
  page.on('request', r => reqs.push(r.url()));

  await page.goto(URL_, { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(1500);

  const s = await page.evaluate(() => ({
    origin: location.origin,
    secure: window.isSecureContext,
    modules: !!window.__qrs,
    bannerGone: !document.getElementById('nojs'),
    appVisible: !!document.querySelector('#view-role.active'),
    manifest: !!document.querySelector('link[rel=manifest]'),
    title: document.title
  }));

  let f = 0;
  const line = (l, ok, d) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${l.padEnd(40)} ${d || ''}`); if (!ok) f++; };
  line('live site loads', s.appVisible, s.title);
  line('secure context (camera allowed)', s.secure, s.origin);
  line('all modules present', s.modules);
  line('preview warning removed', s.bannerGone);
  line('home-screen manifest', s.manifest);
  line('no page errors', errs.length === 0, errs[0] || '');

  // A full transfer, on the real published file.
  const t = await page.evaluate(async () => {
    const { QR, Fountain, RX, PRESETS, go } = window.__qrs;
    const p = PRESETS[1];
    const src = new Uint8Array(16 * 1024);
    crypto.getRandomValues(src);
    const enc = new Fountain.Encoder(src, p.block);
    const meta = { v:1, i:9, n:'live.bin', t:'application/octet-stream', s:src.length,
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
    go('view-recv'); RX.reset(); RX.running = true;
    RX.engine='Built-in decoder'; RX.lockedAt = performance.now();
    RX.onText(read(Fountain.base45Encode(Fountain.encodeManifest(meta))));
    if (!RX.dec) return { error:'manifest rejected' };
    let n = 0;
    while (!RX.dec.isComplete() && n < enc.K*6) {
      n++;
      const d = enc.droplet();
      const got = read(Fountain.base45Encode(Fountain.encodeDroplet(meta.i, d.seed, d.data)));
      if (got) RX.onText(got);
    }
    await new Promise(r => setTimeout(r, 400));
    const out = RX.result ? new Uint8Array(await RX.result.arrayBuffer()) : null;
    let same = !!out && out.length === src.length;
    if (same) for (let i=0;i<src.length;i++) if (out[i]!==src[i]) { same=false; break; }
    return { blocks:enc.K, frames:n, same, integrity: RX.stats && RX.stats.integrity };
  });
  line('full transfer byte-identical', t.same === true, `${t.blocks} blocks, ${t.frames} frames`);
  line('integrity verified', t.integrity === 'verified');

  // The privacy claim: nothing beyond the page itself.
  const external = reqs.filter(u => !u.startsWith(URL_) && !u.startsWith('data:') && !u.startsWith('blob:'));
  line('no third-party requests', external.length === 0,
       external.length ? external.slice(0, 3).join(' , ') : `${reqs.length} request(s), all first-party`);

  await browser.close();
  console.log(f ? `\n${f} FAILURE(S)` : '\nLIVE SITE OK');
  process.exit(f ? 1 : 0);
})();
