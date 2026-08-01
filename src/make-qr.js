const APP = require('./app-path');
/* Render a QR of the tunnel URL using Lumen's own encoder. */
const { webkit } = require('playwright');
const path = require('path');
const fs = require('fs');

const URL_ = process.argv[2];
const OUT = process.argv[3] || path.join(__dirname, 'open-on-iphone.png');

(async () => {
  const b = await webkit.launch();
  const p = await b.newPage();
  await p.goto(APP.appUrl());
  await p.waitForTimeout(800);

  const dataUrl = await p.evaluate(({ url }) => {
    const { QR } = window.__qrs;
    const q = QR.encode(new TextEncoder().encode(url), { ecl: QR.ECL.Q });
    const QUIET = 4, mod = 12, total = q.size + QUIET * 2;
    const cv = document.createElement('canvas');
    cv.width = cv.height = total * mod;
    const cx = cv.getContext('2d');
    cx.fillStyle = '#fff'; cx.fillRect(0, 0, cv.width, cv.height);
    cx.fillStyle = '#000';
    for (let y = 0; y < q.size; y++)
      for (let x = 0; x < q.size; x++)
        if (q.modules[y * q.size + x]) cx.fillRect((x + QUIET) * mod, (y + QUIET) * mod, mod, mod);
    return cv.toDataURL('image/png');
  }, { url: URL_ });

  fs.writeFileSync(OUT, Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log('wrote', OUT, fs.statSync(OUT).size, 'bytes');

  // Verify it decodes back to exactly the URL we encoded.
  const back = await p.evaluate(async ({ d }) => {
    const img = new Image();
    await new Promise(r => { img.onload = r; img.src = d; });
    const cv = document.createElement('canvas');
    cv.width = img.width; cv.height = img.height;
    const cx = cv.getContext('2d', { willReadFrequently: true });
    cx.drawImage(img, 0, 0);
    const res = window.__qrs.QRDecode.decode(cx.getImageData(0, 0, cv.width, cv.height).data, cv.width, cv.height);
    return res ? (typeof res === 'string' ? res : res.text) : null;
  }, { d: dataUrl });

  console.log('decoded  :', back);
  console.log('round-trip:', back === URL_ ? 'PASS' : 'FAIL');
  await b.close();
})();
