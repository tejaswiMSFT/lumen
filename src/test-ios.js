const APP = require('./app-path');
/* Regression against WebKit (Safari's engine) on an iPhone-sized viewport,
 * including the JavaScript-disabled case that iOS Quick Look produces. */
const { webkit, devices } = require('playwright');
const path = require('path');

const FILE = APP.appUrl();


function line(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(42)} ${detail || ''}`);
  return ok ? 0 : 1;
}

(async () => {
  let failures = 0;
  const browser = await webkit.launch();

  /* ---- 1. JavaScript disabled: the iOS Quick Look case ---- */
  {
    const ctx = await browser.newContext({
      ...devices['iPhone 13'],
      javaScriptEnabled: false
    });
    const page = await ctx.newPage();
    await page.goto(FILE);
    await page.waitForTimeout(400);
    const banner = await page.evaluate(() => {
      const n = document.getElementById('nojs');
      if (!n) return null;
      const cs = getComputedStyle(n);
      const r = n.getBoundingClientRect();
      return { visible: cs.display !== 'none' && cs.visibility !== 'hidden' && r.height > 100,
               heading: (n.querySelector('h1') || {}).textContent,
               mentionsSafari: n.textContent.includes('Open in Safari'),
               coversScreen: r.height >= window.innerHeight * 0.9 };
    }).catch(() => null);
    failures += line('Quick Look: warning is visible', !!(banner && banner.visible),
                     banner ? `"${banner.heading}"` : 'banner missing');
    failures += line('Quick Look: gives the Safari instruction', !!(banner && banner.mentionsSafari));
    failures += line('Quick Look: covers the whole screen', !!(banner && banner.coversScreen));
    await page.screenshot({ path: 'C:/Users/tejaswic/.scout/IOS-nojs.png', fullPage: false });
    await ctx.close();
  }

  /* ---- 2. JavaScript enabled from file://: the banner must vanish ---- */
  {
    const ctx = await browser.newContext({ ...devices['iPhone 13'] });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(e.message));
    await page.goto(FILE);
    await page.waitForTimeout(900);
    const s = await page.evaluate(() => ({
      bannerGone: !document.getElementById('nojs'),
      title: document.title,
      appVisible: !!document.querySelector('#view-role.active'),
      modules: typeof QR !== 'undefined' && typeof QRDecode !== 'undefined' && typeof Fountain !== 'undefined',
      secure: window.isSecureContext,
      camera: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
      barcodeDetector: typeof BarcodeDetector !== 'undefined',
      compression: typeof CompressionStream !== 'undefined',
      share: typeof navigator.share === 'function',
      canShareFiles: (() => { try { return navigator.canShare && navigator.canShare({ files:[new File(['x'],'a.html',{type:'text/html'})] }); } catch(e){ return false; } })(),
      wakeLock: 'wakeLock' in navigator,
      rvfc: 'requestVideoFrameCallback' in document.createElement('video')
    }));
    failures += line('Safari file://: warning removed', s.bannerGone);
    failures += line('Safari file://: app renders', s.appVisible, s.title);
    failures += line('Safari file://: all modules loaded', s.modules);
    failures += line('Safari file://: secure context', s.secure);
    // The Playwright WebKit build carries no media stack, so this cannot be
    // exercised here. Real iOS Safari does expose getUserMedia; what matters
    // is that the app degrades cleanly when it is absent.
    console.log(`NOTE  ${'Safari file://: camera API present'.padEnd(42)} ` +
                `${s.camera ? 'yes' : 'not in this WebKit build — informational'}`);
    failures += line('Safari file://: no page errors', errs.length === 0, errs[0] || '');
    console.log(`      WebKit support — BarcodeDetector:${s.barcodeDetector} CompressionStream:${s.compression} ` +
                `share:${s.share} shareFiles:${s.canShareFiles} wakeLock:${s.wakeLock} rVFC:${s.rvfc}`);

    /* Taps must actually work — this is the user's core complaint. */
    await page.tap('#go-send');
    await page.waitForTimeout(700);
    const sendOpen = await page.evaluate(() => !!document.querySelector('#view-send.active'));
    failures += line('Safari: tap navigates to Send', sendOpen);

    await page.tap('[data-back]');
    await page.waitForTimeout(700);
    const backHome = await page.evaluate(() => !!document.querySelector('#view-role.active'));
    failures += line('Safari: back tap returns home', backHome);

    await page.tap('#theme-cycle');
    await page.waitForTimeout(600);
    const themed = await page.evaluate(() => document.querySelector('#theme-cycle').dataset.mode);
    failures += line('Safari: theme button responds', themed === 'light', `mode=${themed}`);

    /* Scroll the target in and let the smooth scroll settle: dispatching a tap
       while the scroller is still animating lands it on the wrong element. */
    const settle = async sel => {
      await page.locator(sel).scrollIntoViewIfNeeded();
      await page.waitForFunction(() => new Promise(res => {
        const s = document.querySelector('.view.active .scroll') || document.scrollingElement;
        let last = s.scrollTop, still = 0;
        const tick = () => {
          if (s.scrollTop === last) { if (++still >= 3) return res(true); }
          else { still = 0; last = s.scrollTop; }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }), null, { timeout: 5000 });
    };

    await settle('#acc-how .acc-h');
    await page.tap('#acc-how .acc-h');
    await page.waitForTimeout(800);
    const accOpen = await page.evaluate(() => {
      const a = document.querySelector('#acc-how');
      return a.classList.contains('open') && a.querySelector('.acc-b').getBoundingClientRect().height > 50;
    });
    failures += line('Safari: accordion expands on tap', accOpen);

    /* The real work: a full transfer through WebKit's own rendering. */
    const transfer = await page.evaluate(async () => {
      const { QR, Fountain, RX, PRESETS, go } = window.__qrs;
      const p = PRESETS[1];
      const src = new Uint8Array(24 * 1024);
      for (let i = 0; i < src.length; i += 65536)
        crypto.getRandomValues(src.subarray(i, Math.min(i + 65536, src.length)));
      const enc = new Fountain.Encoder(src, p.block);
      const meta = { v:1, i:64, n:'ios.bin', t:'application/octet-stream', s:src.length,
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
      let n = 0, unread = 0;
      while (!RX.dec.isComplete() && n < enc.K*6) {
        n++;
        const d = enc.droplet();
        if (n % 6 === 0) continue;
        const got = read(Fountain.base45Encode(Fountain.encodeDroplet(meta.i, d.seed, d.data)));
        RX.framesSeen++;
        if (!got) { unread++; continue; }
        RX.decodeHits++; RX.onText(got);
      }
      await new Promise(r => setTimeout(r, 400));
      const out = RX.result ? new Uint8Array(await RX.result.arrayBuffer()) : null;
      let same = !!out && out.length === src.length;
      if (same) for (let i=0;i<src.length;i++) if (out[i]!==src[i]) { same=false; break; }
      return { blocks:enc.K, frames:n, unreadable:unread, byteIdentical:same,
               integrity: RX.stats && RX.stats.integrity };
    });
    failures += line('Safari: full transfer byte-identical', transfer.byteIdentical === true,
                     `${transfer.blocks} blocks, ${transfer.frames} frames, ${transfer.unreadable} unreadable`);
    failures += line('Safari: integrity verified', transfer.integrity === 'verified');

    /* Self-replication must also work under WebKit. */
    const repl = await page.evaluate(async () => {
      const html = await window.__qrs.SelfShare.blob().text();
      return { bytes: html.length,
               keepsWarning: html.includes('id="nojs"'),
               complete: html.startsWith('<!DOCTYPE html>') && html.trimEnd().endsWith('</html>') };
    });
    failures += line('Safari: copy is complete', repl.complete, `${(repl.bytes/1024).toFixed(1)} KB`);
    failures += line('Safari: copy keeps the preview warning', repl.keepsWarning);

    /* With no camera at all, tapping Receive must explain itself rather than
       hang or throw. This is the graceful-degradation path. */
    await page.evaluate(() => window.__qrs.go('view-role'));
    await page.waitForTimeout(500);
    await page.tap('#go-recv');
    await page.waitForTimeout(900);
    const degraded = await page.evaluate(() => ({
      onRecv: !!document.querySelector('#view-recv.active'),
      message: document.querySelector('#aim-txt').textContent,
      warned: document.querySelector('#aim-pill').classList.contains('warn')
    }));
    failures += line('Safari: no-camera message is clear',
                     degraded.warned && /camera/i.test(degraded.message),
                     `"${degraded.message}"`);

    await page.screenshot({ path: 'C:/Users/tejaswic/.scout/IOS-app.png' });
    await ctx.close();
  }

  /* ---- 3. Served over http, as an installed-app candidate ---- */
  {
    const http = require('http');
    const fs = require('fs');
    const html = fs.readFileSync(APP.appPath());
    const srv = http.createServer((q, r) => {
      r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      r.end(html);
    });
    // Port 0 lets the OS pick a free one, so a stray server can't break the run.
    await new Promise(res => srv.listen(0, '127.0.0.1', res));
    const served = `http://127.0.0.1:${srv.address().port}/lumen.html`;

    const ctx = await browser.newContext({ ...devices['iPhone 13'] });
    const page = await ctx.newPage();
    try {
      await page.goto(served, { timeout: 10000 });
      await page.waitForTimeout(800);
      const m = await page.evaluate(() => {
        const l = document.querySelector('link[rel=manifest]');
        return { hasManifest: !!l, appleCapable: !!document.querySelector('meta[name="apple-mobile-web-app-capable"]') };
      });
      failures += line('Served: web app manifest installed', m.hasManifest);
      failures += line('Served: apple-mobile-web-app meta present', m.appleCapable);
    } catch (e) {
      failures += line('Served: origin reachable', false, e.message.split('\n')[0]);
    }
    await ctx.close();
    await new Promise(res => srv.close(res));
  }

  await browser.close();
  console.log(`\n${failures === 0 ? 'ALL WEBKIT CHECKS PASSED' : failures + ' FAILURE(S)'}`);
  process.exit(failures ? 1 : 0);
})();
