/* ------------------------------------------------------------------
 * qr.js — QR Code encoder implemented from ISO/IEC 18004
 * Byte mode, versions 1..40, ECC levels L/M/Q/H, all 8 mask patterns.
 * Works in Node (module.exports) and in the browser (global QR).
 * ------------------------------------------------------------------ */
var QR = (function () {
  'use strict';

  /* ---------- Galois field GF(256), primitive polynomial 0x11D ---------- */
  var EXP = new Uint8Array(512);
  var LOG = new Uint8Array(256);
  (function initGF() {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
  })();

  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[LOG[a] + LOG[b]];
  }

  /* ---------- Reed-Solomon ---------- */
  var genCache = new Map();

  // Coefficients of the divisor polynomial, highest power first,
  // with the monic leading term omitted.
  function rsGenerator(degree) {
    var cached = genCache.get(degree);
    if (cached) return cached;
    var result = new Uint8Array(degree);
    result[degree - 1] = 1;
    var root = 1;
    for (var i = 0; i < degree; i++) {
      for (var j = 0; j < degree; j++) {
        result[j] = gfMul(result[j], root);
        if (j + 1 < degree) result[j] ^= result[j + 1];
      }
      root = gfMul(root, 2);
    }
    genCache.set(degree, result);
    return result;
  }

  function rsRemainder(data, degree) {
    var gen = rsGenerator(degree);
    var result = new Uint8Array(degree);
    for (var i = 0; i < data.length; i++) {
      var factor = data[i] ^ result[0];
      result.copyWithin(0, 1);
      result[degree - 1] = 0;
      for (var j = 0; j < degree; j++) result[j] ^= gfMul(gen[j], factor);
    }
    return result;
  }

  /* ---------- Capacity tables (index 0 unused, versions 1..40) ---------- */
  // Order of ECC levels: L, M, Q, H
  var ECC_CODEWORDS_PER_BLOCK = [
    // v1  2   3   4   5   6   7   8   9  10  11  12  13  14  15  16  17  18  19  20  21  22  23  24  25  26  27  28  29  30  31  32  33  34  35  36  37  38  39  40
    [-1,  7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // L
    [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28], // M
    [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // Q
    [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30]  // H
  ];

  var NUM_ERROR_CORRECTION_BLOCKS = [
    [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4,  4,  4,  4,  4,  6,  6,  6,  6,  7,  8,  8,  9,  9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25], // L
    [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5,  5,  8,  9,  9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49], // M
    [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8,  8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68], // Q
    [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81]  // H
  ];

  // Bit encoding of each ECC level inside the format information.
  var ECL_FORMAT_BITS = [1, 0, 3, 2]; // L, M, Q, H
  var ECL = { L: 0, M: 1, Q: 2, H: 3 };

  function getNumRawDataModules(ver) {
    var result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      var numAlign = Math.floor(ver / 7) + 2;
      result -= (25 * numAlign - 10) * numAlign - 55;
      if (ver >= 7) result -= 36;
    }
    return result;
  }

  function getNumDataCodewords(ver, ecl) {
    return (
      Math.floor(getNumRawDataModules(ver) / 8) -
      ECC_CODEWORDS_PER_BLOCK[ecl][ver] * NUM_ERROR_CORRECTION_BLOCKS[ecl][ver]
    );
  }

  function getAlignmentPatternPositions(ver) {
    if (ver === 1) return [];
    var numAlign = Math.floor(ver / 7) + 2;
    var step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
    var result = [6];
    for (var pos = ver * 4 + 10; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
    return result;
  }

  /* ---------- Byte-mode capacity helpers ---------- */
  function charCountBits(ver) {
    return ver <= 9 ? 8 : 16;
  }

  /* ---------- Alphanumeric mode ----------
   * QR's alphanumeric charset is exactly the Base45 alphabet, which lets us
   * carry binary payloads through decoders that only hand back strings
   * (BarcodeDetector) at ~3% overhead instead of Base64's 33%. */
  var ALNUM_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
  var ALNUM_MAP = (function () {
    var m = Object.create(null);
    for (var i = 0; i < ALNUM_CHARS.length; i++) m[ALNUM_CHARS[i]] = i;
    return m;
  })();

  function charCountBitsAlnum(ver) {
    return ver <= 9 ? 9 : ver <= 26 ? 11 : 13;
  }

  /** Largest alphanumeric string length that fits the version + ECC level. */
  function capacityAlnum(ver, ecl) {
    var avail = getNumDataCodewords(ver, ecl) * 8 - 4 - charCountBitsAlnum(ver);
    if (avail <= 0) return 0;
    var pairs = Math.floor(avail / 11);
    var chars = pairs * 2;
    if (avail - pairs * 11 >= 6) chars += 1;
    return chars;
  }

  function fitVersionAlnum(len, ecl, minVersion, maxVersion) {
    var lo = minVersion || 1;
    var hi = maxVersion || 40;
    for (var v = lo; v <= hi; v++) if (capacityAlnum(v, ecl) >= len) return v;
    return -1;
  }

  /** Largest byte-mode payload that fits in the given version + ECC level. */
  function capacityBytes(ver, ecl) {
    var dataBits = getNumDataCodewords(ver, ecl) * 8;
    return Math.max(0, Math.floor((dataBits - 4 - charCountBits(ver)) / 8));
  }

  /** Smallest version in [min,max] that holds `len` bytes, or -1. */
  function fitVersion(len, ecl, minVersion, maxVersion) {
    var lo = minVersion || 1;
    var hi = maxVersion || 40;
    for (var v = lo; v <= hi; v++) if (capacityBytes(v, ecl) >= len) return v;
    return -1;
  }

  /* ---------- Bit buffer ---------- */
  function BitBuffer() {
    this.bits = [];
  }
  BitBuffer.prototype.append = function (val, len) {
    for (var i = len - 1; i >= 0; i--) this.bits.push((val >>> i) & 1);
  };

  /* ---------- Data codeword assembly ---------- */
  function finishCodewords(bb, capacityBits) {
    if (bb.bits.length > capacityBits) throw new Error('QR: data too long for version');
    // Terminator, then pad to a byte boundary, then alternating pad bytes.
    bb.append(0, Math.min(4, capacityBits - bb.bits.length));
    bb.append(0, (8 - (bb.bits.length % 8)) % 8);
    for (var pad = 0xec; bb.bits.length < capacityBits; pad ^= 0xec ^ 0x11) bb.append(pad, 8);

    var out = new Uint8Array(bb.bits.length / 8);
    for (var k = 0; k < bb.bits.length; k++) out[k >>> 3] |= bb.bits[k] << (7 - (k & 7));
    return out;
  }

  function makeDataCodewords(bytes, ver, ecl) {
    var capacityBits = getNumDataCodewords(ver, ecl) * 8;
    var bb = new BitBuffer();
    bb.append(0x4, 4); // byte mode indicator
    bb.append(bytes.length, charCountBits(ver));
    for (var i = 0; i < bytes.length; i++) bb.append(bytes[i], 8);
    return finishCodewords(bb, capacityBits);
  }

  function makeDataCodewordsAlnum(text, ver, ecl) {
    var capacityBits = getNumDataCodewords(ver, ecl) * 8;
    var bb = new BitBuffer();
    bb.append(0x2, 4); // alphanumeric mode indicator
    bb.append(text.length, charCountBitsAlnum(ver));
    var i = 0;
    for (; i + 1 < text.length; i += 2) {
      var a = ALNUM_MAP[text[i]];
      var b = ALNUM_MAP[text[i + 1]];
      if (a === undefined || b === undefined) throw new Error('QR: char outside alphanumeric set');
      bb.append(a * 45 + b, 11);
    }
    if (i < text.length) {
      var c = ALNUM_MAP[text[i]];
      if (c === undefined) throw new Error('QR: char outside alphanumeric set');
      bb.append(c, 6);
    }
    return finishCodewords(bb, capacityBits);
  }

  function addEccAndInterleave(data, ver, ecl) {
    var numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ecl][ver];
    var blockEccLen = ECC_CODEWORDS_PER_BLOCK[ecl][ver];
    var rawCodewords = Math.floor(getNumRawDataModules(ver) / 8);
    var numShortBlocks = numBlocks - (rawCodewords % numBlocks);
    var shortBlockLen = Math.floor(rawCodewords / numBlocks);

    var dats = [];
    var eccs = [];
    for (var i = 0, k = 0; i < numBlocks; i++) {
      var datLen = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1);
      var dat = data.subarray(k, k + datLen);
      k += datLen;
      dats.push(dat);
      eccs.push(rsRemainder(dat, blockEccLen));
    }

    var result = new Uint8Array(rawCodewords);
    var idx = 0;
    var maxDatLen = shortBlockLen - blockEccLen + 1;
    for (var r = 0; r < maxDatLen; r++)
      for (var b = 0; b < numBlocks; b++) if (r < dats[b].length) result[idx++] = dats[b][r];
    for (var e = 0; e < blockEccLen; e++)
      for (var b2 = 0; b2 < numBlocks; b2++) result[idx++] = eccs[b2][e];
    return result;
  }

  /* ---------- Matrix ---------- */
  function QrMatrix(ver, ecl) {
    this.version = ver;
    this.ecl = ecl;
    this.size = ver * 4 + 17;
    this.modules = new Uint8Array(this.size * this.size);
    this.isFunction = new Uint8Array(this.size * this.size);
  }

  QrMatrix.prototype.get = function (x, y) {
    return this.modules[y * this.size + x];
  };

  QrMatrix.prototype.setFunctionModule = function (x, y, isDark) {
    this.modules[y * this.size + x] = isDark ? 1 : 0;
    this.isFunction[y * this.size + x] = 1;
  };

  QrMatrix.prototype.drawFinderPattern = function (x, y) {
    for (var dy = -4; dy <= 4; dy++) {
      for (var dx = -4; dx <= 4; dx++) {
        var dist = Math.max(Math.abs(dx), Math.abs(dy));
        var xx = x + dx;
        var yy = y + dy;
        if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size)
          this.setFunctionModule(xx, yy, dist !== 2 && dist !== 4);
      }
    }
  };

  QrMatrix.prototype.drawAlignmentPattern = function (x, y) {
    for (var dy = -2; dy <= 2; dy++)
      for (var dx = -2; dx <= 2; dx++)
        this.setFunctionModule(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  };

  QrMatrix.prototype.drawFormatBits = function (mask) {
    var data = (ECL_FORMAT_BITS[this.ecl] << 3) | mask;
    var rem = data;
    for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    var bits = (((data << 10) | rem) ^ 0x5412) >>> 0;

    for (var j = 0; j <= 5; j++) this.setFunctionModule(8, j, (bits >>> j) & 1);
    this.setFunctionModule(8, 7, (bits >>> 6) & 1);
    this.setFunctionModule(8, 8, (bits >>> 7) & 1);
    this.setFunctionModule(7, 8, (bits >>> 8) & 1);
    for (var m = 9; m < 15; m++) this.setFunctionModule(14 - m, 8, (bits >>> m) & 1);

    for (var n = 0; n < 8; n++) this.setFunctionModule(this.size - 1 - n, 8, (bits >>> n) & 1);
    for (var p = 8; p < 15; p++) this.setFunctionModule(8, this.size - 15 + p, (bits >>> p) & 1);
    this.setFunctionModule(8, this.size - 8, 1); // always-dark module
  };

  QrMatrix.prototype.drawVersionBits = function () {
    if (this.version < 7) return;
    var rem = this.version;
    for (var i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    var bits = ((this.version << 12) | rem) >>> 0;
    for (var j = 0; j < 18; j++) {
      var bit = (bits >>> j) & 1;
      var a = this.size - 11 + (j % 3);
      var b = Math.floor(j / 3);
      this.setFunctionModule(a, b, bit);
      this.setFunctionModule(b, a, bit);
    }
  };

  QrMatrix.prototype.drawFunctionPatterns = function () {
    for (var i = 0; i < this.size; i++) {
      this.setFunctionModule(6, i, (i % 2) === 0);
      this.setFunctionModule(i, 6, (i % 2) === 0);
    }
    this.drawFinderPattern(3, 3);
    this.drawFinderPattern(this.size - 4, 3);
    this.drawFinderPattern(3, this.size - 4);

    var pos = getAlignmentPatternPositions(this.version);
    var n = pos.length;
    for (var a = 0; a < n; a++) {
      for (var b = 0; b < n; b++) {
        if ((a === 0 && b === 0) || (a === 0 && b === n - 1) || (a === n - 1 && b === 0)) continue;
        this.drawAlignmentPattern(pos[a], pos[b]);
      }
    }
    this.drawFormatBits(0); // placeholder, rewritten once the mask is chosen
    this.drawVersionBits();
  };

  QrMatrix.prototype.drawCodewords = function (data) {
    var i = 0;
    var total = data.length * 8;
    for (var right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < this.size; vert++) {
        for (var j = 0; j < 2; j++) {
          var x = right - j;
          var upward = ((right + 1) & 2) === 0;
          var y = upward ? this.size - 1 - vert : vert;
          var idx = y * this.size + x;
          if (!this.isFunction[idx] && i < total) {
            this.modules[idx] = (data[i >>> 3] >>> (7 - (i & 7))) & 1;
            i++;
          }
        }
      }
    }
  };

  function maskCondition(mask, x, y) {
    switch (mask) {
      case 0: return ((x + y) % 2) === 0;
      case 1: return (y % 2) === 0;
      case 2: return (x % 3) === 0;
      case 3: return ((x + y) % 3) === 0;
      case 4: return ((Math.floor(x / 3) + Math.floor(y / 2)) % 2) === 0;
      case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
      case 6: return ((((x * y) % 2) + ((x * y) % 3)) % 2) === 0;
      case 7: return ((((x + y) % 2) + ((x * y) % 3)) % 2) === 0;
      default: throw new Error('QR: bad mask');
    }
  }

  QrMatrix.prototype.applyMask = function (mask) {
    for (var y = 0; y < this.size; y++) {
      for (var x = 0; x < this.size; x++) {
        var idx = y * this.size + x;
        if (this.isFunction[idx]) continue;
        if (maskCondition(mask, x, y)) this.modules[idx] ^= 1;
      }
    }
  };

  var FINDER_A = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  var FINDER_B = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  void FINDER_A; void FINDER_B; // retained for reference; rule 3 uses bit windows

  QrMatrix.prototype.penaltyScore = function () {
    var size = this.size;
    var score = 0;
    var x, y;

    // Rule 1 — runs of five or more identical modules in a row or column.
    for (y = 0; y < size; y++) {
      var runColor = -1, runLen = 0;
      for (x = 0; x < size; x++) {
        var c = this.modules[y * size + x];
        if (c === runColor) {
          runLen++;
          if (runLen === 5) score += 3;
          else if (runLen > 5) score += 1;
        } else { runColor = c; runLen = 1; }
      }
    }
    for (x = 0; x < size; x++) {
      var rc = -1, rl = 0;
      for (y = 0; y < size; y++) {
        var c2 = this.modules[y * size + x];
        if (c2 === rc) {
          rl++;
          if (rl === 5) score += 3;
          else if (rl > 5) score += 1;
        } else { rc = c2; rl = 1; }
      }
    }

    // Rule 2 — 2x2 blocks of one colour.
    for (y = 0; y < size - 1; y++) {
      for (x = 0; x < size - 1; x++) {
        var v = this.modules[y * size + x];
        if (
          v === this.modules[y * size + x + 1] &&
          v === this.modules[(y + 1) * size + x] &&
          v === this.modules[(y + 1) * size + x + 1]
        ) score += 3;
      }
    }

    // Rule 3 — finder-like 1:1:3:1:1 patterns with a four-module quiet run.
    // Rolling 11-bit windows: one integer compare instead of eleven.
    var PAT_A = 0x5d0; // 10111010000
    var PAT_B = 0x05d; // 00001011101
    for (y = 0; y < size; y++) {
      var wRow = 0, wCol = 0;
      var base = y * size;
      for (x = 0; x < size; x++) {
        wRow = ((wRow << 1) | this.modules[base + x]) & 0x7ff;
        wCol = ((wCol << 1) | this.modules[x * size + y]) & 0x7ff;
        if (x >= 10) {
          if (wRow === PAT_A || wRow === PAT_B) score += 40;
          if (wCol === PAT_A || wCol === PAT_B) score += 40;
        }
      }
    }

    // Rule 4 — deviation from an even balance of dark and light.
    var dark = 0;
    for (var i = 0; i < this.modules.length; i++) dark += this.modules[i];
    var total = size * size;
    var k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    score += Math.max(0, k) * 10;
    return score;
  };

  /* ---------- Public encode ---------- */
  /**
   * @param {Uint8Array|string} payload  Uint8Array for byte mode, string for alphanumeric
   * @param {object} opts { ecl, minVersion, maxVersion, version, mask }
   * @returns {{size:number, modules:Uint8Array, version:number, mask:number}}
   */
  function encode(payload, opts) {
    opts = opts || {};
    var ecl = typeof opts.ecl === 'number' ? opts.ecl : ECL.M;
    var alnum = typeof payload === 'string';

    var ver = opts.version;
    if (!ver) {
      ver = alnum
        ? fitVersionAlnum(payload.length, ecl, opts.minVersion, opts.maxVersion)
        : fitVersion(payload.length, ecl, opts.minVersion, opts.maxVersion);
    }
    if (ver < 1) throw new Error('QR: payload does not fit in the requested version range');

    var dataCw = alnum
      ? makeDataCodewordsAlnum(payload, ver, ecl)
      : makeDataCodewords(payload, ver, ecl);
    var allCw = addEccAndInterleave(dataCw, ver, ecl);

    var m = new QrMatrix(ver, ecl);
    m.drawFunctionPatterns();
    m.drawCodewords(allCw);

    var chosen = opts.mask;
    if (typeof chosen !== 'number') {
      var best = Infinity;
      for (var msk = 0; msk < 8; msk++) {
        m.applyMask(msk);
        m.drawFormatBits(msk);
        var p = m.penaltyScore();
        if (p < best) { best = p; chosen = msk; }
        m.applyMask(msk); // undo (XOR is its own inverse)
      }
    }
    m.applyMask(chosen);
    m.drawFormatBits(chosen);

    return { size: m.size, modules: m.modules, version: ver, mask: chosen, ecl: ecl };
  }

  return {
    encode: encode,
    ECL: ECL,
    capacityBytes: capacityBytes,
    capacityAlnum: capacityAlnum,
    fitVersion: fitVersion,
    fitVersionAlnum: fitVersionAlnum,
    getNumDataCodewords: getNumDataCodewords,
    ALNUM_CHARS: ALNUM_CHARS
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = QR;
