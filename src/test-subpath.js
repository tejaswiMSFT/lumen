const APP = require('./app-path');
/* GitHub Pages project sites serve from https://user.github.io/<repo>/ —
 * verify Lumen works from a subpath, and as the directory index. */
const { webkit, devices } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(APP.appPath());
const BASE = '/lumen-app';

const srv = http.createServer((q, r) => {
  const u = q.url.split('?')[0];
  if (u === BASE || u === BASE + '/' || u === BASE + '/index.html' || u === BASE + '/lumen.html') {
    r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return r.end(HTML);
  }
  r.writeHead(404); r.end('not found');
}).listen(8795, '127.0.0.1');

(async () => {
  const browser = await webkit.launch();
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();
  let fails = 0;

  for (const url of [
    'http://127.0.0.1:8795/lumen-app/',
    'http://127.0.0.1:8795/lumen-app/lumen.html'
  ]) {
    const errs = [];
    page.on('pageerror', e => errs.push(e.message));
    await page.goto(url);
    await page.waitForTimeout(900);

    const r = await page.evaluate(() => {
      const m = document.querySelector('link[rel=manifest]');
      return {
        secure: window.isSecureContext,
        modules: !!window.__qrs,
        bannerGone: !document.getElementById('nojs'),
        manifestHref: m ? m.href.slice(0, 5) : null,
        appVisible: !!document.querySelector('#view-role.active')
      };
    });

    // The self-share copy must still be complete when served from a subpath.
    const repl = await page.evaluate(async () => {
      const h = await window.__qrs.SelfShare.blob().text();
      return { bytes: h.length, complete: h.startsWith('<!DOCTYPE html>') && h.trimEnd().endsWith('</html>') };
    });

    // And the beam QR must encode this exact page URL.
    await page.evaluate(() => document.querySelector('#acc-share .acc-h').click());
    await page.waitForTimeout(700);
    const beam = await page.evaluate(() => {
      const c = document.querySelector('#beam-card');
      return { shown: !c.hidden, url: (document.querySelector('#beam-url') || {}).textContent };
    });

    const ok = r.modules && r.appVisible && r.bannerGone && repl.complete &&
               beam.shown && beam.url === url && errs.length === 0;
    if (!ok) fails++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${url}`);
    console.log(`      modules=${r.modules} app=${r.appVisible} manifest=${r.manifestHref} ` +
                `copy=${repl.bytes}B/${repl.complete} beam="${beam.url}" errs=${errs.length ? errs[0] : 0}`);
    page.removeAllListeners('pageerror');
  }

  await browser.close();
  srv.close();
  console.log(fails ? `\n${fails} FAILURE(S)` : '\nSUBPATH OK');
  process.exit(fails ? 1 : 0);
})();
