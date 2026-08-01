/* The sender is usually a large screen and the receiver a phone, but the app
 * must stay usable on a phone in both roles. This checks the send view on a
 * small viewport: the code stays square and fully visible, the controls stay
 * reachable, and nothing overlaps the code itself — anything drawn over it
 * would corrupt what the camera reads.
 */
const APP = require('./app-path');
const { webkit, devices } = require('playwright');

function line(l, ok, d) { console.log(`${ok ? 'PASS' : 'FAIL'}  ${l.padEnd(44)} ${d || ''}`); return ok ? 0 : 1; }

const VIEWPORTS = [
  { label: 'iPhone SE',  width: 375, height: 667, dpr: 2 },
  { label: 'iPhone 13',  width: 390, height: 844, dpr: 3 },
  { label: 'small landscape', width: 844, height: 390, dpr: 3 },
  { label: 'laptop',     width: 1440, height: 820, dpr: 1 }
];

(async () => {
  let f = 0;
  const browser = await webkit.launch();

  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: vp.dpr, isMobile: vp.width < 900, hasTouch: vp.width < 900
    });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(e.message));
    await page.goto(APP.appUrl());
    await page.waitForTimeout(700);

    const r = await page.evaluate(() => {
      const { QR, PRESETS, go, paint, TX } = window.__qrs;
      go('view-tx');
      const p = PRESETS[0];
      const q = QR.encode('LUMEN LAYOUT CHECK 0123456789', { ecl: p.ecl, version: p.ver });
      TX.last = q; paint(q);

      const cv = document.getElementById('qr');
      const box = cv.getBoundingClientRect();
      const bar = document.querySelector('#view-tx .txbar').getBoundingClientRect();
      const vw = innerWidth, vh = innerHeight;

      // Nothing may sit on top of the code: sample its corners and centre.
      const pts = [[box.left + 4, box.top + 4], [box.right - 4, box.top + 4],
                   [box.left + 4, box.bottom - 4], [box.right - 4, box.bottom - 4],
                   [box.left + box.width / 2, box.top + box.height / 2]];
      const covering = pts
        .map(([x, y]) => document.elementFromPoint(x, y))
        .filter(el => el && el.id !== 'qr')
        .map(el => el.id || el.className);

      return {
        w: Math.round(box.width), h: Math.round(box.height),
        square: Math.abs(box.width - box.height) <= 1,
        insideX: box.left >= -1 && box.right <= vw + 1,
        insideY: box.top >= -1 && box.bottom <= vh + 1,
        barVisible: bar.width > 0 && bar.bottom <= vh + 1 && bar.top >= 0,
        clearOfBar: box.bottom <= bar.top + 1,
        covering,
        fill: +(Math.min(box.width, box.height) / Math.min(vw, vh)).toFixed(2)
      };
    });

    console.log(`\n${vp.label} (${vp.width}x${vp.height} @${vp.dpr}x)`);
    f += line('code is square', r.square, `${r.w}x${r.h} css px`);
    f += line('code fits horizontally', r.insideX);
    f += line('code fits vertically', r.insideY);
    f += line('controls visible on screen', r.barVisible);
    f += line('code does not run under controls', r.clearOfBar);
    f += line('nothing overlaps the code', r.covering.length === 0, r.covering.join(', '));
    f += line('code uses most of the short edge', r.fill >= 0.55, `${Math.round(r.fill * 100)}%`);
    f += line('no page errors', errs.length === 0, errs[0] || '');

    await ctx.close();
  }

  await browser.close();
  console.log(f ? `\n${f} FAILURE(S)` : '\nLAYOUT OK');
  process.exit(f ? 1 : 0);
})();
