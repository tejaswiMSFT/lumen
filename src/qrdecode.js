/* ------------------------------------------------------------------
 * qrdecode.js — QR Code decoder implemented from ISO/IEC 18004.
 *
 * Exists so the app has zero network dependencies: browsers without
 * BarcodeDetector fall back to this instead of fetching a library.
 *
 * Pipeline: greyscale -> adaptive binarisation -> finder-pattern search
 * -> alignment pattern -> perspective sampling -> format/version info
 * -> unmask -> deinterleave -> Reed-Solomon correction -> segment parse.
 * ------------------------------------------------------------------ */
var QRDecode = (function () {
  'use strict';

  /* ---------- GF(256) ---------- */
  var EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
    for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
  })();
  function mul(a, b) { return (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]]; }
  function inv(a) { return EXP[255 - LOG[a]]; }

  /* ---------- Polynomial helpers (coefficients low-order first) ---------- */
  function polyMul(a, b) {
    var r = new Uint8Array(a.length + b.length - 1);
    for (var i = 0; i < a.length; i++) {
      if (!a[i]) continue;
      for (var j = 0; j < b.length; j++) r[i + j] ^= mul(a[i], b[j]);
    }
    return r;
  }
  function polyEval(p, x) {
    var y = 0;
    for (var i = p.length - 1; i >= 0; i--) y = mul(y, x) ^ p[i];
    return y;
  }
  function trim(p) {
    var n = p.length;
    while (n > 1 && p[n - 1] === 0) n--;
    return p.subarray(0, n);
  }

  /* ---------- Reed-Solomon: syndromes, Berlekamp-Massey, Chien, Forney ---------- */
  function rsCorrect(data, eccLen) {
    var synd = new Uint8Array(eccLen);
    var bad = false;
    for (var i = 0; i < eccLen; i++) {
      synd[i] = polyEval(data, EXP[i]);
      if (synd[i]) bad = true;
    }
    if (!bad) return data;

    // Berlekamp-Massey
    var sigma = new Uint8Array([1]);
    var old = new Uint8Array([1]);
    for (var n = 0; n < eccLen; n++) {
      var delta = 0;
      for (var k = 0; k < sigma.length; k++) {
        if (n - k >= 0) delta ^= mul(sigma[k], synd[n - k]);
      }
      var shifted = new Uint8Array(old.length + 1);
      shifted.set(old, 1);
      old = shifted;
      if (delta !== 0) {
        if (old.length > sigma.length) {
          var newOld = new Uint8Array(sigma.length);
          var scale = inv(delta);
          for (var a = 0; a < sigma.length; a++) newOld[a] = mul(sigma[a], scale);
          var grown = new Uint8Array(old.length);
          for (var b = 0; b < sigma.length; b++) grown[b] = sigma[b];
          for (var c = 0; c < old.length; c++) grown[c] ^= mul(old[c], delta);
          sigma = grown;
          old = newOld;
        } else {
          var g2 = new Uint8Array(Math.max(sigma.length, old.length));
          g2.set(sigma);
          for (var d = 0; d < old.length; d++) g2[d] ^= mul(old[d], delta);
          sigma = g2;
        }
      }
    }
    sigma = trim(sigma);
    var errCount = sigma.length - 1;
    if (errCount <= 0 || errCount * 2 > eccLen) return null;

    // Chien search for error positions
    var positions = [];
    for (var p = 0; p < data.length; p++) {
      if (polyEval(sigma, inv(EXP[p])) === 0) positions.push(p);
    }
    if (positions.length !== errCount) return null;

    // Forney: omega = (synd * sigma) mod x^eccLen
    var omega = polyMul(synd, sigma).subarray(0, eccLen);
    // sigma'(x): formal derivative -> odd-index coefficients
    var deriv = new Uint8Array(Math.max(1, sigma.length - 1));
    for (var e = 1; e < sigma.length; e++) if (e & 1) deriv[e - 1] = sigma[e];

    var out = Uint8Array.from(data);
    for (var q = 0; q < positions.length; q++) {
      var pos = positions[q];
      var xInv = inv(EXP[pos]);
      var num = polyEval(omega, xInv);
      var den = polyEval(deriv, xInv);
      if (den === 0) return null;
      out[pos] ^= mul(num, inv(den));
    }
    // Verify
    for (var v = 0; v < eccLen; v++) if (polyEval(out, EXP[v]) !== 0) return null;
    return out;
  }

  /* ---------- Capacity tables (mirror of the encoder) ---------- */
  var ECC_CW = [
    [-1,7,10,15,20,26,18,20,24,30,18,20,24,26,30,22,24,28,30,28,28,28,28,30,30,26,28,30,30,30,30,30,30,30,30,30,30,30,30,30,30],
    [-1,10,16,26,18,24,16,18,22,22,26,30,22,22,24,24,28,28,26,26,26,26,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28],
    [-1,13,22,18,26,18,24,18,22,20,24,28,26,24,20,30,24,28,28,26,30,28,30,30,30,30,28,30,30,30,30,30,30,30,30,30,30,30,30,30,30],
    [-1,17,28,22,16,22,28,26,26,24,28,24,28,22,24,24,30,28,28,26,28,30,24,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30]
  ];
  var NUM_BLOCKS = [
    [-1,1,1,1,1,1,2,2,2,2,4,4,4,4,4,6,6,6,6,7,8,8,9,9,10,12,12,12,13,14,15,16,17,18,19,19,20,21,22,24,25],
    [-1,1,1,1,2,2,4,4,4,5,5,5,8,9,9,10,10,11,13,14,16,17,17,18,20,21,23,25,26,28,29,31,33,35,37,38,40,43,45,47,49],
    [-1,1,1,2,2,4,4,6,6,8,8,8,10,12,16,12,17,16,18,21,20,23,23,25,27,29,34,34,35,38,40,43,45,48,51,53,56,59,62,65,68],
    [-1,1,1,2,4,4,4,5,6,8,8,11,11,16,16,18,16,19,21,25,25,25,34,30,32,35,37,40,42,45,48,51,54,57,60,63,66,70,74,77,81]
  ];
  // Format-info bits -> ECC level index (L,M,Q,H order used by the tables above)
  var FORMAT_TO_ECL = { 1: 0, 0: 1, 3: 2, 2: 3 };

  function rawDataModules(ver) {
    var r = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      var n = Math.floor(ver / 7) + 2;
      r -= (25 * n - 10) * n - 55;
      if (ver >= 7) r -= 36;
    }
    return r;
  }
  function alignPositions(ver) {
    if (ver === 1) return [];
    var n = Math.floor(ver / 7) + 2;
    var step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
    var res = [6];
    for (var pos = ver * 4 + 10; res.length < n; pos -= step) res.splice(1, 0, pos);
    return res;
  }

  /* ---------- Greyscale + adaptive binarisation ---------- */
  var BLOCK = 8;
  function binarize(rgba, w, h) {
    var gray = new Uint8Array(w * h);
    for (var i = 0, p = 0; i < gray.length; i++, p += 4) {
      gray[i] = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8;
    }
    var bw = Math.max(1, Math.ceil(w / BLOCK)), bh = Math.max(1, Math.ceil(h / BLOCK));
    var means = new Uint8Array(bw * bh);
    for (var by = 0; by < bh; by++) {
      for (var bx = 0; bx < bw; bx++) {
        var x0 = bx * BLOCK, y0 = by * BLOCK;
        var x1 = Math.min(x0 + BLOCK, w), y1 = Math.min(y0 + BLOCK, h);
        var sum = 0, mn = 255, mx = 0, cnt = 0;
        for (var y = y0; y < y1; y++) {
          for (var x = x0; x < x1; x++) {
            var g = gray[y * w + x];
            sum += g; cnt++;
            if (g < mn) mn = g;
            if (g > mx) mx = g;
          }
        }
        var avg = cnt ? sum / cnt : 128;
        // Low-contrast blocks are probably uniform: bias toward the darker neighbour.
        if (mx - mn <= 24) {
          avg = mn / 2;
          if (by > 0 && bx > 0) {
            var neighbour = (means[(by - 1) * bw + bx] + means[by * bw + bx - 1] +
                             means[(by - 1) * bw + bx - 1]) / 3;
            if (mn < neighbour) avg = neighbour;
          }
        }
        means[by * bw + bx] = avg;
      }
    }
    // Threshold each block against a 5x5 neighbourhood of block means.
    var bits = new Uint8Array(w * h);
    for (var cy = 0; cy < bh; cy++) {
      for (var cx = 0; cx < bw; cx++) {
        var t = 0, n = 0;
        for (var dy = -2; dy <= 2; dy++) {
          var yy = cy + dy; if (yy < 0 || yy >= bh) continue;
          for (var dx = -2; dx <= 2; dx++) {
            var xx = cx + dx; if (xx < 0 || xx >= bw) continue;
            t += means[yy * bw + xx]; n++;
          }
        }
        var thr = t / n;
        var sx = cx * BLOCK, sy = cy * BLOCK;
        var ex = Math.min(sx + BLOCK, w), ey = Math.min(sy + BLOCK, h);
        for (var py = sy; py < ey; py++)
          for (var px = sx; px < ex; px++)
            bits[py * w + px] = gray[py * w + px] < thr ? 1 : 0;
      }
    }
    return bits;
  }

  /* ---------- Finder pattern detection ---------- */
  function runsOf(get, len) {
    var runs = [], start = 0, cur = get(0);
    for (var i = 1; i < len; i++) {
      var v = get(i);
      if (v !== cur) { runs.push({ s: start, l: i - start, c: cur }); start = i; cur = v; }
    }
    runs.push({ s: start, l: len - start, c: cur });
    return runs;
  }

  // Checks a 5-run window against the 1:1:3:1:1 finder ratio.
  function ratioOk(r) {
    var total = r[0].l + r[1].l + r[2].l + r[3].l + r[4].l;
    if (total < 7) return 0;
    var mod = total / 7;
    var tol = mod * 0.6;
    if (Math.abs(mod - r[0].l) > tol) return 0;
    if (Math.abs(mod - r[1].l) > tol) return 0;
    if (Math.abs(3 * mod - r[2].l) > 3 * tol) return 0;
    if (Math.abs(mod - r[3].l) > tol) return 0;
    if (Math.abs(mod - r[4].l) > tol) return 0;
    return mod;
  }

  function scanLine(get, len) {
    var out = [];
    var runs = runsOf(get, len);
    for (var i = 0; i + 4 < runs.length; i++) {
      if (runs[i].c !== 1) continue;
      var win = [runs[i], runs[i + 1], runs[i + 2], runs[i + 3], runs[i + 4]];
      var mod = ratioOk(win);
      if (mod) out.push({ centre: win[2].s + win[2].l / 2, mod: mod });
    }
    return out;
  }

  /* A real finder shows 1:1:3:1:1 along its diagonals too. Data modules
     rarely satisfy all three axes, so this kills most false positives. */
  function diagonalOk(bits, w, h, cx, cy, mod) {
    for (var dir = 0; dir < 2; dir++) {
      var sx = dir === 0 ? 1 : -1;
      var counts = [0, 0, 0, 0, 0];
      // Walk outward from the centre in both directions along this diagonal.
      var ok = true;
      for (var side = 0; side < 2 && ok; side++) {
        var step = side === 0 ? 1 : -1;
        var state = 0, i = 0;
        var seen = [0, 0, 0];
        for (;;) {
          var x = Math.round(cx + step * i * sx), y = Math.round(cy + step * i);
          if (x < 0 || y < 0 || x >= w || y >= h) break;
          var v = bits[y * w + x];
          var want = state === 0 ? 1 : state === 1 ? 0 : 1;
          if (v === want) seen[state]++;
          else { state++; if (state > 2) break; seen[state]++; }
          i++;
          if (i > mod * 6) break;
        }
        if (seen[0] < mod * 0.5 || seen[1] < mod * 0.4) ok = false;
        counts[0] += seen[0]; counts[1] += seen[1]; counts[2] += seen[2];
      }
      if (!ok) return false;
      // counts[0] spans the centre block (3 modules across both halves),
      // counts[1] the light ring, counts[2] the outer dark ring.
      var centre = counts[0] - 1;
      if (Math.abs(centre - 3 * mod) > 2 * mod) return false;
      if (Math.abs(counts[1] / 2 - mod) > mod * 0.9) return false;
    }
    return true;
  }

  function findFinders(bits, w, h) {
    var cands = [];
    var rowStep = Math.max(1, Math.floor(h / 320));
    for (var y = 0; y < h; y += rowStep) {
      var row = scanLine(function (x) { return bits[y * w + x]; }, w);
      for (var i = 0; i < row.length; i++) {
        var cx = Math.round(row[i].centre);
        // Confirm the same ratio vertically through the candidate centre.
        var col = scanLine(function (yy) { return bits[yy * w + cx]; }, h);
        for (var j = 0; j < col.length; j++) {
          if (Math.abs(col[j].centre - y) > row[i].mod * 2.5) continue;
          if (Math.abs(col[j].mod - row[i].mod) > Math.max(1, row[i].mod * 0.7)) continue;
          var mod = (row[i].mod + col[j].mod) / 2;
          if (!diagonalOk(bits, w, h, cx, col[j].centre, mod)) break;
          cands.push({ x: cx, y: col[j].centre, mod: mod });
          break;
        }
      }
    }
    // Cluster nearby hits.
    var clusters = [];
    for (var k = 0; k < cands.length; k++) {
      var c = cands[k], hit = null;
      for (var m = 0; m < clusters.length; m++) {
        var cl = clusters[m];
        if (Math.abs(cl.x - c.x) < cl.mod * 2 && Math.abs(cl.y - c.y) < cl.mod * 2) { hit = cl; break; }
      }
      if (hit) {
        hit.x = (hit.x * hit.n + c.x) / (hit.n + 1);
        hit.y = (hit.y * hit.n + c.y) / (hit.n + 1);
        hit.mod = (hit.mod * hit.n + c.mod) / (hit.n + 1);
        hit.n++;
      } else {
        clusters.push({ x: c.x, y: c.y, mod: c.mod, n: 1 });
      }
    }
    return clusters.filter(function (c) { return c.n >= 2; })
                   .sort(function (a, b) { return b.n - a.n; });
  }

  function orderFinders(a, b, c) {
    function d2(p, q) { var dx = p.x - q.x, dy = p.y - q.y; return dx * dx + dy * dy; }
    var ab = d2(a, b), bc = d2(b, c), ac = d2(a, c);
    var topLeft, p1, p2;
    if (bc >= ab && bc >= ac) { topLeft = a; p1 = b; p2 = c; }
    else if (ac >= ab && ac >= bc) { topLeft = b; p1 = a; p2 = c; }
    else { topLeft = c; p1 = a; p2 = b; }
    // Right-handed ordering: with y increasing downward, (tr-tl) x (bl-tl) is positive.
    var cross = (p1.x - topLeft.x) * (p2.y - topLeft.y) - (p1.y - topLeft.y) * (p2.x - topLeft.x);
    return cross > 0 ? { tl: topLeft, tr: p1, bl: p2 } : { tl: topLeft, tr: p2, bl: p1 };
  }

  /* ---------- Perspective transform ---------- */
  function squareToQuad(x0, y0, x1, y1, x2, y2, x3, y3) {
    var dx3 = x0 - x1 + x2 - x3, dy3 = y0 - y1 + y2 - y3;
    if (dx3 === 0 && dy3 === 0) {
      return [x1 - x0, x2 - x1, x0, y1 - y0, y2 - y1, y0, 0, 0, 1];
    }
    var dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2;
    var den = dx1 * dy2 - dx2 * dy1;
    if (den === 0) return null;
    var a13 = (dx3 * dy2 - dx2 * dy3) / den;
    var a23 = (dx1 * dy3 - dx3 * dy1) / den;
    return [
      x1 - x0 + a13 * x1, x3 - x0 + a23 * x3, x0,
      y1 - y0 + a13 * y1, y3 - y0 + a23 * y3, y0,
      a13, a23, 1
    ];
  }
  function quadToSquare(x0, y0, x1, y1, x2, y2, x3, y3) {
    var m = squareToQuad(x0, y0, x1, y1, x2, y2, x3, y3);
    if (!m) return null;
    // adjugate
    return [
      m[4] * m[8] - m[5] * m[7], m[2] * m[7] - m[1] * m[8], m[1] * m[5] - m[2] * m[4],
      m[5] * m[6] - m[3] * m[8], m[0] * m[8] - m[2] * m[6], m[2] * m[3] - m[0] * m[5],
      m[3] * m[7] - m[4] * m[6], m[1] * m[6] - m[0] * m[7], m[0] * m[4] - m[1] * m[3]
    ];
  }
  function matMul(a, b) {
    // Row-major over (a11,a21,a31, a12,a22,a32, a13,a23,a33): applies b first, then a.
    return [
      a[0]*b[0] + a[1]*b[3] + a[2]*b[6],
      a[0]*b[1] + a[1]*b[4] + a[2]*b[7],
      a[0]*b[2] + a[1]*b[5] + a[2]*b[8],
      a[3]*b[0] + a[4]*b[3] + a[5]*b[6],
      a[3]*b[1] + a[4]*b[4] + a[5]*b[7],
      a[3]*b[2] + a[4]*b[5] + a[5]*b[8],
      a[6]*b[0] + a[7]*b[3] + a[8]*b[6],
      a[6]*b[1] + a[7]*b[4] + a[8]*b[7],
      a[6]*b[2] + a[7]*b[5] + a[8]*b[8]
    ];
  }
  function applyT(m, x, y) {
    var d = m[6] * x + m[7] * y + m[8];
    return [(m[0] * x + m[1] * y + m[2]) / d, (m[3] * x + m[4] * y + m[5]) / d];
  }

  /* ---------- Alignment pattern search ----------
   * The outer ring of an alignment pattern merges with surrounding data,
   * so the dependable signature is its isolated light:dark:light core,
   * confirmed by probing the 5x5 structure in two dimensions. */
  function lightDarkLight(runs, i, mod) {
    if (runs[i].c !== 0) return null;
    var a = runs[i], b = runs[i + 1], c = runs[i + 2];
    if (b.c !== 1 || c.c !== 0) return null;
    var tol = Math.max(1, mod * 0.75);
    if (Math.abs(b.l - mod) > tol) return null;
    if (a.l < mod * 0.4 || c.l < mod * 0.4) return null;
    return b.s + b.l / 2;
  }

  // Probe the canonical 5x5 alignment structure around a candidate centre.
  function alignmentShapeOk(bits, w, h, cx, cy, mod) {
    function at(dx, dy) {
      var x = Math.round(cx + dx * mod), y = Math.round(cy + dy * mod);
      if (x < 0 || y < 0 || x >= w || y >= h) return -1;
      return bits[y * w + x];
    }
    if (at(0, 0) !== 1) return false;
    if (at(-1, 0) !== 0 || at(1, 0) !== 0 || at(0, -1) !== 0 || at(0, 1) !== 0) return false;
    if (at(-2, 0) !== 1 || at(2, 0) !== 1 || at(0, -2) !== 1 || at(0, 2) !== 1) return false;
    if (at(-1, -1) !== 0 || at(1, 1) !== 0 || at(-1, 1) !== 0 || at(1, -1) !== 0) return false;
    return true;
  }

  function findAlignments(bits, w, h, ex, ey, mod, dim) {
    // The estimate comes from an affine fit, which drifts under perspective,
    // and the drift grows with symbol size. Collect every shape-verified
    // candidate nearby and let the caller test them; a wrong pick is rejected
    // by Reed-Solomon, so being generous here costs only a little time.
    var radius = Math.ceil(mod * Math.max(6, dim * 0.16));
    var found = [];
    var y0 = Math.max(0, Math.floor(ey - radius)), y1 = Math.min(h - 1, Math.ceil(ey + radius));
    for (var y = y0; y <= y1; y++) {
      var runs = runsOf(function (x) { return bits[y * w + x]; }, w);
      for (var i = 0; i + 2 < runs.length; i++) {
        var cx = lightDarkLight(runs, i, mod);
        if (cx === null || Math.abs(cx - ex) > radius) continue;
        var col = runsOf(function (yy) { return bits[yy * w + Math.round(cx)]; }, h);
        for (var j = 0; j + 2 < col.length; j++) {
          var cy = lightDarkLight(col, j, mod);
          if (cy === null || Math.abs(cy - y) > mod * 1.5) continue;
          if (!alignmentShapeOk(bits, w, h, cx, cy, mod)) continue;
          var d = (cx - ex) * (cx - ex) + (cy - ey) * (cy - ey);
          // Merge duplicates from adjacent scan rows.
          var dup = false;
          for (var k = 0; k < found.length; k++) {
            if (Math.abs(found[k].x - cx) < mod && Math.abs(found[k].y - cy) < mod) { dup = true; break; }
          }
          if (!dup) found.push({ x: cx, y: cy, d: d });
          break;
        }
      }
    }
    found.sort(function (a, b) { return a.d - b.d; });
    return found.slice(0, 6);
  }

  /* ---------- Sampling ---------- */
  function sample(bits, w, h, dim, tl, tr, bl, align) {
    var edge = dim - 3.5;
    var m;
    if (align) {
      m = quadToSquare(3.5, 3.5, edge, 3.5, dim - 6.5, dim - 6.5, 3.5, edge);
      if (!m) return null;
      m = matMul(squareToQuad(tl.x, tl.y, tr.x, tr.y, align.x, align.y, bl.x, bl.y), m);
    } else {
      var brx = tr.x + bl.x - tl.x, bry = tr.y + bl.y - tl.y;
      m = quadToSquare(3.5, 3.5, edge, 3.5, edge, edge, 3.5, edge);
      if (!m) return null;
      m = matMul(squareToQuad(tl.x, tl.y, tr.x, tr.y, brx, bry, bl.x, bl.y), m);
    }
    var out = new Uint8Array(dim * dim);
    for (var y = 0; y < dim; y++) {
      for (var x = 0; x < dim; x++) {
        var p = applyT(m, x + 0.5, y + 0.5);
        var px = Math.round(p[0]), py = Math.round(p[1]);
        if (px < 0 || py < 0 || px >= w || py >= h) return null;
        out[y * dim + x] = bits[py * w + px];
      }
    }
    return out;
  }

  /* ---------- Format & version information ---------- */
  function bchFormat(bits) {
    var best = -1, bestD = 99;
    for (var d = 0; d < 32; d++) {
      var rem = d;                                  // seed with the data bits, not d<<10
      for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      var full = ((((d << 10) | rem) ^ 0x5412) >>> 0) & 0x7fff;
      var diff = popcount(full ^ (bits & 0x7fff));
      if (diff < bestD) { bestD = diff; best = d; }
    }
    return bestD <= 3 ? best : -1;
  }
  function popcount(v) { var c = 0; while (v) { c += v & 1; v >>>= 1; } return c; }

  function readFormat(mat, dim) {
    var a = 0;
    for (var i = 0; i <= 5; i++) a = (a << 1) | mat[i * dim + 8];
    a = (a << 1) | mat[7 * dim + 8];
    a = (a << 1) | mat[8 * dim + 8];
    a = (a << 1) | mat[8 * dim + 7];
    for (var j = 5; j >= 0; j--) a = (a << 1) | mat[8 * dim + j];
    // The bit order above is MSB-first (bit14..bit0); reverse to match encoding.
    var rev = 0;
    for (var k = 0; k < 15; k++) rev |= ((a >>> k) & 1) << (14 - k);

    var b = 0;
    for (var m = 0; m < 7; m++) b = (b << 1) | mat[(dim - 1 - m) * dim + 8];
    for (var n = 0; n < 8; n++) b = (b << 1) | mat[8 * dim + (dim - 8 + n)];
    var revB = 0;
    for (var q = 0; q < 15; q++) revB |= ((b >>> q) & 1) << (14 - q);

    var d1 = bchFormat(rev);
    if (d1 >= 0) return d1;
    return bchFormat(revB);
  }

  function readVersion(mat, dim) {
    var ver = (dim - 17) / 4;
    if (ver < 7) return ver;
    var bits = 0;
    for (var i = 17; i >= 0; i--) {
      var a = dim - 11 + (i % 3), b = Math.floor(i / 3);
      bits = (bits << 1) | mat[b * dim + a];
    }
    var best = -1, bestD = 99;
    for (var v = 7; v <= 40; v++) {
      var rem = v;
      for (var k = 0; k < 12; k++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      var full = ((v << 12) | rem) >>> 0;
      var d = popcount(full ^ bits);
      if (d < bestD) { bestD = d; best = v; }
    }
    return bestD <= 3 ? best : ver;
  }

  /* ---------- Function-module map, unmasking, codeword extraction ---------- */
  function functionMap(dim, ver) {
    var fn = new Uint8Array(dim * dim);
    function box(x0, y0, wd, ht) {
      for (var y = y0; y < y0 + ht; y++)
        for (var x = x0; x < x0 + wd; x++)
          if (x >= 0 && y >= 0 && x < dim && y < dim) fn[y * dim + x] = 1;
    }
    box(0, 0, 9, 9);
    box(dim - 8, 0, 8, 9);
    box(0, dim - 8, 9, 8);
    for (var i = 0; i < dim; i++) { fn[6 * dim + i] = 1; fn[i * dim + 6] = 1; }
    var pos = alignPositions(ver), n = pos.length;
    for (var a = 0; a < n; a++)
      for (var b = 0; b < n; b++) {
        if ((a === 0 && b === 0) || (a === 0 && b === n - 1) || (a === n - 1 && b === 0)) continue;
        box(pos[a] - 2, pos[b] - 2, 5, 5);
      }
    if (ver >= 7) { box(dim - 11, 0, 3, 6); box(0, dim - 11, 6, 3); }
    return fn;
  }

  function maskBit(mask, x, y) {
    switch (mask) {
      case 0: return ((x + y) % 2) === 0;
      case 1: return (y % 2) === 0;
      case 2: return (x % 3) === 0;
      case 3: return ((x + y) % 3) === 0;
      case 4: return ((Math.floor(x / 3) + Math.floor(y / 2)) % 2) === 0;
      case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
      case 6: return ((((x * y) % 2) + ((x * y) % 3)) % 2) === 0;
      default: return ((((x + y) % 2) + ((x * y) % 3)) % 2) === 0;
    }
  }

  function extractCodewords(mat, dim, ver, mask) {
    var fn = functionMap(dim, ver);
    var total = Math.floor(rawDataModules(ver) / 8);
    var out = new Uint8Array(total);
    var bit = 0;
    for (var right = dim - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < dim; vert++) {
        for (var j = 0; j < 2; j++) {
          var x = right - j;
          var upward = ((right + 1) & 2) === 0;
          var y = upward ? dim - 1 - vert : vert;
          var idx = y * dim + x;
          if (fn[idx]) continue;
          if (bit >= total * 8) continue;
          var v = mat[idx];
          if (maskBit(mask, x, y)) v ^= 1;
          out[bit >>> 3] |= v << (7 - (bit & 7));
          bit++;
        }
      }
    }
    return out;
  }

  function deinterleave(all, ver, ecl) {
    var numBlocks = NUM_BLOCKS[ecl][ver];
    var eccLen = ECC_CW[ecl][ver];
    var raw = Math.floor(rawDataModules(ver) / 8);
    var shortBlocks = numBlocks - (raw % numBlocks);
    var shortLen = Math.floor(raw / numBlocks);

    var dataLens = [], blocks = [];
    for (var i = 0; i < numBlocks; i++) {
      var len = shortLen - eccLen + (i < shortBlocks ? 0 : 1);
      dataLens.push(len);
      blocks.push(new Uint8Array(len + eccLen));
    }
    var idx = 0, maxLen = shortLen - eccLen + 1;
    for (var r = 0; r < maxLen; r++)
      for (var b = 0; b < numBlocks; b++)
        if (r < dataLens[b]) blocks[b][r] = all[idx++];
    for (var e = 0; e < eccLen; e++)
      for (var b2 = 0; b2 < numBlocks; b2++) blocks[b2][dataLens[b2] + e] = all[idx++];

    var result = [];
    for (var k = 0; k < numBlocks; k++) {
      // RS routines here treat index 0 as the lowest power, so reverse.
      var rev = Uint8Array.from(blocks[k]).reverse();
      var fixed = rsCorrect(rev, eccLen);
      if (!fixed) return null;
      var restored = Uint8Array.from(fixed).reverse();
      result.push(restored.subarray(0, dataLens[k]));
    }
    var outLen = 0;
    result.forEach(function (b) { outLen += b.length; });
    var out = new Uint8Array(outLen), o = 0;
    result.forEach(function (b) { out.set(b, o); o += b.length; });
    return out;
  }

  /* ---------- Segment parsing ---------- */
  var ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
  function parseSegments(data, ver) {
    var bitPos = 0;
    var totalBits = data.length * 8;
    function read(n) {
      var v = 0;
      for (var i = 0; i < n; i++) {
        if (bitPos >= totalBits) throw new Error('overrun');
        v = (v << 1) | ((data[bitPos >>> 3] >>> (7 - (bitPos & 7))) & 1);
        bitPos++;
      }
      return v;
    }
    var out = '';
    for (;;) {
      if (totalBits - bitPos < 4) break;
      var mode = read(4);
      if (mode === 0) break;
      if (mode === 2) { // alphanumeric
        var cc = read(ver <= 9 ? 9 : ver <= 26 ? 11 : 13);
        var i = 0;
        for (; i + 1 < cc; i += 2) {
          var pair = read(11);
          out += ALNUM[Math.floor(pair / 45)] + ALNUM[pair % 45];
        }
        if (i < cc) out += ALNUM[read(6)];
      } else if (mode === 4) { // byte
        var n = read(ver <= 9 ? 8 : 16);
        var bytes = new Uint8Array(n);
        for (var k = 0; k < n; k++) bytes[k] = read(8);
        out += new TextDecoder().decode(bytes);
      } else if (mode === 1) { // numeric
        var nc = read(ver <= 9 ? 10 : ver <= 26 ? 12 : 14);
        var done = 0;
        while (nc - done >= 3) { out += String(read(10)).padStart(3, '0'); done += 3; }
        if (nc - done === 2) { out += String(read(7)).padStart(2, '0'); done += 2; }
        else if (nc - done === 1) { out += String(read(4)); done += 1; }
      } else {
        break; // unsupported mode for this application
      }
    }
    return out;
  }

  /* ---------- Public entry point ---------- */
  /**
   * @param {Uint8ClampedArray|Uint8Array} rgba  RGBA pixels
   * @returns {string|null} decoded text, or null
   */
  function decode(rgba, w, h) {
    try {
      var bits = binarize(rgba, w, h);
      var finders = findFinders(bits, w, h);
      if (finders.length < 3) return null;

      // Try the most plausible finder triples.
      var limit = Math.min(finders.length, 6);
      for (var a = 0; a < limit - 2; a++) {
        for (var b = a + 1; b < limit - 1; b++) {
          for (var c = b + 1; c < limit; c++) {
            var got = attempt(bits, w, h, finders[a], finders[b], finders[c]);
            if (got !== null) return got;
          }
        }
      }
      return null;
    } catch (e) { return null; }
  }

  function attempt(bits, w, h, f1, f2, f3) {
    // Reject triples whose estimated module sizes disagree badly.
    var mods = [f1.mod, f2.mod, f3.mod];
    var mMin = Math.min.apply(null, mods), mMax = Math.max.apply(null, mods);
    if (mMin <= 0.9 || mMax / mMin > 1.7) return null;

    var o = orderFinders(f1, f2, f3);
    var tl = o.tl, tr = o.tr, bl = o.bl;
    var mod = (tl.mod + tr.mod + bl.mod) / 3;

    var dTR = Math.sqrt((tr.x - tl.x) * (tr.x - tl.x) + (tr.y - tl.y) * (tr.y - tl.y));
    var dBL = Math.sqrt((bl.x - tl.x) * (bl.x - tl.x) + (bl.y - tl.y) * (bl.y - tl.y));
    if (dTR <= 0 || dBL <= 0) return null;
    // The two sides of a QR symbol are equal; allow for perspective.
    var ratio = dTR / dBL;
    if (ratio < 0.65 || ratio > 1.55) return null;

    var dimF = dTR / mod + 7;
    var dim = Math.round(dimF);
    dim = dim + ((1 - (dim % 4)) + 4) % 4;   // snap to 4v+17
    if (dim < 21 || dim > 177) return null;
    var ver = (dim - 17) / 4;

    // Perspective can bias the dimension estimate, so try the neighbours too.
    // A successful Reed-Solomon decode is proof we guessed right.
    var dims = [dim, dim - 4, dim + 4, dim - 8, dim + 8];
    for (var di = 0; di < dims.length; di++) {
      var D = dims[di];
      if (D < 21 || D > 177) continue;
      var V = (D - 17) / 4;

      var cands = [null];
      if (V >= 2) {
        var corr = 1 - 3 / (D - 7);
        var ex = tl.x + corr * ((tr.x - tl.x) + (bl.x - tl.x));
        var ey = tl.y + corr * ((tr.y - tl.y) + (bl.y - tl.y));
        cands = findAlignments(bits, w, h, ex, ey, mod, D);
        cands.push(null);              // plain three-point fit as a last resort
      }

      for (var ci = 0; ci < cands.length; ci++) {
        var mat = sample(bits, w, h, D, tl, tr, bl, cands[ci]);
        if (!mat) continue;
        var fmt = readFormat(mat, D);
        if (fmt < 0) continue;
        var ecl = FORMAT_TO_ECL[(fmt >> 3) & 3];
        var mask = fmt & 7;
        if (readVersion(mat, D) !== V) continue;
        var cw = extractCodewords(mat, D, V, mask);
        var data = deinterleave(cw, V, ecl);
        if (!data) continue;
        var text = parseSegments(data, V);
        if (text) return text;
      }
    }
    return null;
  }

  return { decode: decode };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = QRDecode;
