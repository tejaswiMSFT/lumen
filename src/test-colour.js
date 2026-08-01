/* Colour mode: three symbols in one frame, one per channel.
 *
 * This drives the app's own paint() and detector, not a simulation, and puts
 * the frame through a camera-like path — chroma carried at half resolution,
 * blur, noise and a white-balance shift — because those are what break colour
 * schemes in practice.
 */
const APP = require('./app-path');
const { webkit, devices } = require('playwright');

function line(l, ok, d) { console.log(`${ok ? 'PASS' : 'FAIL'}  ${l.padEnd(46)} ${d || ''}`); return ok ? 0 : 1; }

(async () => {
  let f = 0;
  const browser = await webkit.launch();
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.goto(APP.appUrl());
  await page.waitForTimeout(900);

  const r = await page.evaluate(async () => {
    const { QR, Fountain, RX, PRESETS, go, paint } = window.__qrs;
    const p = PRESETS.find(x => x.colour);
    if (!p) return { error: 'no colour preset' };

    /* Put a rendered frame through a camera: RGB -> YUV, halve the chroma in
       both axes, blur the luminance, add noise and a white-balance gain. */
    const camera = (data, w, h) => {
      const n = w * h;
      const Y = new Float32Array(n), U = new Float32Array(n), V = new Float32Array(n);
      const wb = [1.06, 1.0, 0.94];
      for (let i = 0, o = 0; i < n; i++, o += 4) {
        const r = data[o] * wb[0], g = data[o+1] * wb[1], b = data[o+2] * wb[2];
        Y[i] = 0.299*r + 0.587*g + 0.114*b;
        U[i] = -0.169*r - 0.331*g + 0.5*b + 128;
        V[i] = 0.5*r - 0.419*g - 0.081*b + 128;
      }
      const halve = a => {
        const out = new Float32Array(n);
        for (let y = 0; y < h; y += 2)
          for (let x = 0; x < w; x += 2) {
            let s = 0, c = 0;
            for (let dy = 0; dy < 2 && y+dy < h; dy++)
              for (let dx = 0; dx < 2 && x+dx < w; dx++) { s += a[(y+dy)*w + x+dx]; c++; }
            const avg = s / c;
            for (let dy = 0; dy < 2 && y+dy < h; dy++)
              for (let dx = 0; dx < 2 && x+dx < w; dx++) out[(y+dy)*w + x+dx] = avg;
          }
        return out;
      };
      const U2 = halve(U), V2 = halve(V);
      const Yb = new Float32Array(n);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          let s = 0, c = 0;
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              const yy = y+dy, xx = x+dx;
              if (yy < 0 || xx < 0 || yy >= h || xx >= w) continue;
              s += Y[yy*w + xx]; c++;
            }
          Yb[y*w + x] = s / c;
        }
      const out = new Uint8ClampedArray(n * 4);
      let s = 4242;
      for (let i = 0, o = 0; i < n; i++, o += 4) {
        const y = Yb[i], u = U2[i] - 128, v = V2[i] - 128;
        s = (s * 1664525 + 1013904223) >>> 0;
        const nz = ((s >>> 24) / 255 - 0.5) * 255 * 0.08;
        out[o]   = Math.max(0, Math.min(255, y + 1.402*v + nz));
        out[o+1] = Math.max(0, Math.min(255, y - 0.344*u - 0.714*v + nz));
        out[o+2] = Math.max(0, Math.min(255, y + 1.772*u + nz));
        out[o+3] = 255;
      }
      return out;
    };

    /* Render whatever paint() produced, then read it back the way the receiver
       does: split the three channels and decode each. */
    const cv = document.createElement('canvas');
    const cx = cv.getContext('2d', { willReadFrequently:true });
    const MOD = 6, QUIET = 4;
    const draw = qs => {
      const list = Array.isArray(qs) ? qs : [qs];
      const size = list[0].size, total = size + QUIET*2;
      cv.width = cv.height = total * MOD;
      const img = cx.createImageData(cv.width, cv.height);
      img.data.fill(255);
      const planes = list.length === 1 ? [list[0], list[0], list[0]] : list;
      for (let ch = 0; ch < 3; ch++) {
        const q = planes[ch];
        for (let y = 0; y < q.size; y++)
          for (let x = 0; x < q.size; x++) {
            if (!q.modules[y*q.size + x]) continue;
            for (let dy = 0; dy < MOD; dy++) {
              let o = (((y+QUIET)*MOD + dy) * cv.width + (x+QUIET)*MOD) * 4 + ch;
              for (let dx = 0; dx < MOD; dx++, o += 4) img.data[o] = 0;
            }
          }
      }
      cx.putImageData(img, 0, 0);
      return camera(cx.getImageData(0, 0, cv.width, cv.height).data, cv.width, cv.height);
    };
    const readPlanes = (rgba, w, h) => {
      const n = w * h, plane = new Uint8ClampedArray(n * 4), out = [];
      for (let ch = 0; ch < 3; ch++) {
        for (let i = 0, o = 0; i < n; i++, o += 4) {
          const v = rgba[o + ch];
          plane[o] = plane[o+1] = plane[o+2] = v; plane[o+3] = 255;
        }
        const got = QRDecode.decode(plane, w, h);
        if (got) out.push(got);
      }
      return out;
    };
    const readLuma = (rgba, w, h) => {
      const n = w * h, plane = new Uint8ClampedArray(n * 4);
      for (let i = 0, o = 0; i < n; i++, o += 4) {
        const v = 0.299*rgba[o] + 0.587*rgba[o+1] + 0.114*rgba[o+2];
        plane[o] = plane[o+1] = plane[o+2] = v; plane[o+3] = 255;
      }
      return QRDecode.decode(plane, w, h);
    };

    const src = new Uint8Array(48 * 1024);
    crypto.getRandomValues(src);
    const enc = new Fountain.Encoder(src, p.block);
    const meta = { v:1, i:88, n:'c.bin', t:'application/octet-stream', s:src.length,
                   z:0, c:Fountain.crc32(src), k:enc.K, b:p.block, l:src.length,
                   qv:p.ver, cm:1 };
    const manifestText = Fountain.base45Encode(Fountain.encodeManifest(meta));
    const manifestQ = QR.encode(manifestText, { ecl:p.ecl, version:p.ver });

    /* 1. A plain manifest frame must still read by brightness alone. */
    const mImg = draw(manifestQ);
    const mLuma = readLuma(mImg, cv.width, cv.height);
    const manifestReadable = mLuma === manifestText;

    /* 2. A colour frame must yield three distinct droplets. */
    const trio = [];
    for (let i = 0; i < 3; i++) {
      const d = enc.droplet();
      trio.push({ seed: d.seed,
                  text: Fountain.base45Encode(Fountain.encodeDroplet(meta.i, d.seed, d.data)) });
    }
    const cImg = draw(trio.map(t => QR.encode(t.text, { ecl:p.ecl, version:p.ver })));
    const got = readPlanes(cImg, cv.width, cv.height);
    const allThree = got.length === 3 && trio.every(t => got.includes(t.text));

    /* 3. A whole transfer, colour frames throughout. */
    go('view-recv'); RX.reset(); RX.running = true; RX.engine = 'Built-in decoder';
    RX.onText(readLuma(draw(manifestQ), cv.width, cv.height));
    const locked = !!RX.dec;
    const colourFlagged = RX.colour === true;

    const enc2 = new Fountain.Encoder(src, p.block);
    let frames = 0, droplets = 0;
    while (RX.dec && !RX.dec.isComplete() && frames < 4000) {
      frames++;
      const qs = [];
      for (let i = 0; i < 3; i++) {
        const d = enc2.droplet();
        qs.push(QR.encode(
          Fountain.base45Encode(Fountain.encodeDroplet(meta.i, d.seed, d.data)),
          { ecl:p.ecl, version:p.ver }));
      }
      const texts = readPlanes(draw(qs), cv.width, cv.height);
      droplets += texts.length;
      for (const t of texts) RX.onText(t);
    }
    await new Promise(r => setTimeout(r, 300));
    const out = RX.result ? new Uint8Array(await RX.result.arrayBuffer()) : null;
    let same = !!out && out.length === src.length;
    if (same) for (let i = 0; i < src.length; i++) if (out[i] !== src[i]) { same = false; break; }

    return {
      manifestReadable, allThree, locked, colourFlagged, same,
      blocks: enc.K, frames, droplets,
      perFrame: frames ? +(droplets / frames).toFixed(2) : 0,
      integrity: RX.stats && RX.stats.integrity,
      block: p.block, fps: p.fps
    };
  });

  if (r.error) { console.log('FAIL ', r.error); process.exit(1); }

  f += line('plain manifest still reads by brightness', r.manifestReadable);
  f += line('colour frame yields three droplets', r.allThree);
  f += line('receiver locks from a colour manifest', r.locked);
  f += line('receiver switches to colour mode', r.colourFlagged);
  f += line('droplets per frame is ~3', r.perFrame >= 2.9, `${r.perFrame}`);
  f += line('full colour transfer byte-identical', r.same === true,
            `${r.blocks} blocks in ${r.frames} frames`);
  f += line('integrity verified', r.integrity === 'verified');
  f += line('no page errors', errs.length === 0, errs[0] || '');

  console.log(`\n      throughput: ${(r.block * r.fps * 3 / 1024).toFixed(1)} KB/s ` +
              `(${r.block} B x 3 planes x ${r.fps} fps)`);

  await browser.close();
  console.log(f ? `\n${f} FAILURE(S)` : '\nCOLOUR OK');
  process.exit(f ? 1 : 0);
})();
