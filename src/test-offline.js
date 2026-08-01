const APP = require('./app-path');
/* Once loaded over https, does Lumen still work with the network cut? */
const { webkit, devices } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(APP.appPath());
let served = 0;
const srv = http.createServer((q, r) => {
  served++;
  r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  r.end(HTML);
}).listen(8790, '127.0.0.1');

(async () => {
  const browser = await webkit.launch();
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();

  await page.goto('http://127.0.0.1:8790/lumen.html');
  await page.waitForTimeout(900);
  console.log('loaded online, server hits =', served);

  // Shut the origin down completely — more realistic than a network flag,
  // and it proves the app needs nothing from the server once loaded.
  await new Promise(r => srv.close(r));
  console.log('server shut down');
  const offlineWorks = await page.evaluate(async () => {
    const { QR, Fountain, RX, PRESETS, go } = window.__qrs;
    const p = PRESETS[1];
    const src = new Uint8Array(12 * 1024);
    crypto.getRandomValues(src);
    const enc = new Fountain.Encoder(src, p.block);
    const meta = { v:1, i:77, n:'off.bin', t:'application/octet-stream', s:src.length,
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
      const im = cx.getImageData(0,0,cv.width,cv.height);
      return QRDecode.decode(im.data, cv.width, cv.height);
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
    return { done: !!out, same, frames:n, integrity: RX.stats && RX.stats.integrity };
  }).catch(e => ({ error: e.message }));

  console.log('offline transfer:', JSON.stringify(offlineWorks));

  // A hard reload with no network — the Home Screen relaunch case.
  let reloadOk = false, reloadErr = '';
  try {
    await page.reload({ timeout: 15000 });
    await page.waitForTimeout(600);
    reloadOk = await page.evaluate(() => !!window.__qrs && !!document.querySelector('#view-role'));
  } catch (e) { reloadErr = e.message.split('\n')[0]; }
  console.log('offline reload survives:', reloadOk, reloadErr);
  console.log('total server hits:', served);

  await browser.close();
})();
