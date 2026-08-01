/* ------------------------------------------------------------------
 * fountain.js — LT (Luby transform) rateless codec + wire format.
 *
 * Droplets are self-describing: a 32-bit seed replays the same PRNG on
 * both sides, so the receiver can reconstruct which source blocks a
 * droplet combines without any back-channel. Seeds 0..K-1 are reserved
 * for a systematic first pass (plain block i), which makes the common
 * good-conditions case near-optimal; everything after that is LT.
 * ------------------------------------------------------------------ */
var Fountain = (function () {
  'use strict';

  /* ---------- deterministic PRNG (mulberry32) ---------- */
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ---------- CRC-32 ---------- */
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(buf) {
    var c = 0xffffffff;
    for (var i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  /* ---------- Robust soliton degree distribution ---------- */
  function buildDegreeCdf(K, c, delta) {
    c = c == null ? 0.1 : c;
    delta = delta == null ? 0.5 : delta;
    if (K === 1) return [1];

    var R = c * Math.log(K / delta) * Math.sqrt(K);
    var pivot = Math.max(1, Math.round(K / R));
    var p = new Float64Array(K + 1); // 1-indexed

    p[1] = 1 / K;
    for (var i = 2; i <= K; i++) p[i] = 1 / (i * (i - 1));

    for (var j = 1; j < pivot; j++) p[j] += R / (j * K);
    if (pivot <= K) p[pivot] += (R * Math.log(R / delta)) / K;

    var sum = 0;
    for (var s = 1; s <= K; s++) sum += p[s];

    var cdf = new Float64Array(K + 1);
    var acc = 0;
    for (var d = 1; d <= K; d++) {
      acc += p[d] / sum;
      cdf[d] = acc;
    }
    cdf[K] = 1;
    return cdf;
  }

  function sampleDegree(cdf, K, rnd) {
    var u = rnd();
    var lo = 1, hi = K;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (cdf[mid] < u) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Indices a droplet combines, derived purely from its seed. */
  function indicesForSeed(seed, K, cdf) {
    if (seed < K) return [seed]; // systematic prefix
    var rnd = mulberry32(seed + 0x9e3779b9);
    var degree = Math.min(K, sampleDegree(cdf, K, rnd));
    var picked = new Set();
    var guard = 0;
    while (picked.size < degree && guard++ < degree * 64) {
      picked.add(Math.floor(rnd() * K) % K);
    }
    return Array.from(picked);
  }

  /* ---------- Encoder ---------- */
  function Encoder(data, blockSize) {
    this.blockSize = blockSize;
    this.K = Math.max(1, Math.ceil(data.length / blockSize));
    this.length = data.length;
    this.blocks = [];
    for (var i = 0; i < this.K; i++) {
      var b = new Uint8Array(blockSize);
      b.set(data.subarray(i * blockSize, Math.min((i + 1) * blockSize, data.length)));
      this.blocks.push(b);
    }
    this.cdf = buildDegreeCdf(this.K);
    this.seed = 0;
  }

  Encoder.prototype.droplet = function (seed) {
    if (seed == null) seed = this.seed++;
    var idx = indicesForSeed(seed, this.K, this.cdf);
    var out = new Uint8Array(this.blockSize);
    out.set(this.blocks[idx[0]]);
    for (var i = 1; i < idx.length; i++) {
      var src = this.blocks[idx[i]];
      for (var j = 0; j < this.blockSize; j++) out[j] ^= src[j];
    }
    return { seed: seed, data: out };
  };

  /* ---------- Decoder (peeling / belief propagation) ---------- */
  function Decoder(K, blockSize, length) {
    this.K = K;
    this.blockSize = blockSize;
    this.length = length;
    this.cdf = buildDegreeCdf(K);
    this.recovered = new Array(K).fill(null);
    this.count = 0;
    this.pending = [];
    this.seen = new Set();
  }

  Decoder.prototype.isComplete = function () {
    return this.count >= this.K;
  };

  /** @returns true if this droplet was new (not a duplicate seed). */
  Decoder.prototype.add = function (seed, data) {
    if (this.seen.has(seed) || this.isComplete()) return false;
    this.seen.add(seed);

    var idx = indicesForSeed(seed, this.K, this.cdf);
    var item = { idx: new Set(idx), data: Uint8Array.from(data) };
    this._reduce(item);

    if (item.idx.size === 0) return true; // redundant, carried no new information
    if (item.idx.size === 1) {
      var queue = [item];
      while (queue.length) {
        var solved = queue.pop();
        var b = solved.idx.values().next().value;
        if (this.recovered[b]) continue;
        this.recovered[b] = solved.data;
        this.count++;

        var still = [];
        for (var i = 0; i < this.pending.length; i++) {
          var p = this.pending[i];
          if (p.idx.has(b)) {
            this._xor(p.data, solved.data);
            p.idx.delete(b);
            if (p.idx.size === 1) { queue.push(p); continue; }
            if (p.idx.size === 0) continue;
          }
          still.push(p);
        }
        this.pending = still;
      }
    } else {
      this.pending.push(item);
    }
    return true;
  };

  Decoder.prototype._xor = function (dst, src) {
    for (var i = 0; i < dst.length; i++) dst[i] ^= src[i];
  };

  Decoder.prototype._reduce = function (item) {
    var self = this;
    item.idx.forEach(function (b) {
      if (self.recovered[b]) {
        self._xor(item.data, self.recovered[b]);
        item.idx.delete(b);
      }
    });
  };

  Decoder.prototype.result = function () {
    if (!this.isComplete()) return null;
    var out = new Uint8Array(this.K * this.blockSize);
    for (var i = 0; i < this.K; i++) out.set(this.recovered[i], i * this.blockSize);
    return out.subarray(0, this.length);
  };

  /* ---------- Wire format ---------- */
  var TYPE_MANIFEST = 0x4d; // 'M'
  var TYPE_DROPLET = 0x44; // 'D'

  function encodeManifest(meta) {
    var json = new TextEncoder().encode(JSON.stringify(meta));
    var out = new Uint8Array(1 + json.length);
    out[0] = TYPE_MANIFEST;
    out.set(json, 1);
    return out;
  }

  function encodeDroplet(transferId, seed, payload) {
    var out = new Uint8Array(9 + payload.length);
    out[0] = TYPE_DROPLET;
    var dv = new DataView(out.buffer);
    dv.setUint32(1, transferId >>> 0);
    dv.setUint32(5, seed >>> 0);
    out.set(payload, 9);
    return out;
  }

  function parseFrame(bytes) {
    if (!bytes || bytes.length < 1) return null;
    if (bytes[0] === TYPE_MANIFEST) {
      try {
        return { type: 'manifest', meta: JSON.parse(new TextDecoder().decode(bytes.subarray(1))) };
      } catch (e) {
        return null;
      }
    }
    if (bytes[0] === TYPE_DROPLET && bytes.length > 9) {
      var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return {
        type: 'droplet',
        transferId: dv.getUint32(1),
        seed: dv.getUint32(5),
        data: bytes.subarray(9)
      };
    }
    return null;
  }

  /* ---------- Base45 (RFC 9285) ----------
   * Maps binary onto QR's alphanumeric charset: 2 bytes -> 3 chars.
   * ~3% overhead, versus 33% for Base64, and survives string-only decoders. */
  var B45_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
  var B45_MAP = (function () {
    var m = Object.create(null);
    for (var i = 0; i < B45_CHARS.length; i++) m[B45_CHARS[i]] = i;
    return m;
  })();

  function base45Encode(bytes) {
    var out = '';
    var i = 0;
    for (; i + 1 < bytes.length; i += 2) {
      var n = bytes[i] * 256 + bytes[i + 1];
      out += B45_CHARS[n % 45];
      n = (n / 45) | 0;
      out += B45_CHARS[n % 45];
      out += B45_CHARS[(n / 45) | 0];
    }
    if (i < bytes.length) {
      var v = bytes[i];
      out += B45_CHARS[v % 45];
      out += B45_CHARS[(v / 45) | 0];
    }
    return out;
  }

  function base45Decode(str) {
    var len = str.length;
    var rem = len % 3;
    if (rem === 1) return null;
    var out = new Uint8Array(((len / 3) | 0) * 2 + (rem === 2 ? 1 : 0));
    var o = 0;
    var i = 0;
    for (; i + 2 < len; i += 3) {
      var a = B45_MAP[str[i]], b = B45_MAP[str[i + 1]], c = B45_MAP[str[i + 2]];
      if (a === undefined || b === undefined || c === undefined) return null;
      var n = a + b * 45 + c * 2025;
      if (n > 0xffff) return null;
      out[o++] = n >>> 8;
      out[o++] = n & 0xff;
    }
    if (rem === 2) {
      var d = B45_MAP[str[i]], e = B45_MAP[str[i + 1]];
      if (d === undefined || e === undefined) return null;
      var m = d + e * 45;
      if (m > 0xff) return null;
      out[o++] = m;
    }
    return out;
  }

  /** Payload bytes that fit in a QR carrying `chars` alphanumeric characters. */
  function bytesForChars(chars) {
    return ((chars / 3) | 0) * 2 + (chars % 3 >= 2 ? 1 : 0);
  }

  return {
    Encoder: Encoder,
    Decoder: Decoder,
    crc32: crc32,
    encodeManifest: encodeManifest,
    encodeDroplet: encodeDroplet,
    parseFrame: parseFrame,
    indicesForSeed: indicesForSeed,
    buildDegreeCdf: buildDegreeCdf,
    base45Encode: base45Encode,
    base45Decode: base45Decode,
    bytesForChars: bytesForChars
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Fountain;
