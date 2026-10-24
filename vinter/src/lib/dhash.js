// 64-bit difference hash (dHash) for near-duplicate photo detection, plus a small
// index that reports matches between listings of different sellers.
(function (root) {
  'use strict';
  const V = (root.Vinter = root.Vinter || {});

  const W = 9;
  const H = 8;
  const MATCH_DISTANCE = 6; // of 64 bits
  const MAX_ENTRIES = 5000;

  // gray: 72 luminance values (9 columns x 8 rows, row-major).
  function fromGray(gray) {
    let hi = 0;
    let lo = 0;
    let bit = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W - 1; x++) {
        const set = gray[y * W + x] > gray[y * W + x + 1] ? 1 : 0;
        if (bit < 32) hi = (hi << 1) | set;
        else lo = (lo << 1) | set;
        bit++;
      }
    }
    return (hi >>> 0).toString(16).padStart(8, '0') + (lo >>> 0).toString(16).padStart(8, '0');
  }

  function fromRGBA(data) {
    const gray = new Array(W * H);
    for (let i = 0; i < W * H; i++) {
      gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    }
    return fromGray(gray);
  }

  function popcount32(n) {
    n -= (n >>> 1) & 0x55555555;
    n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
    return (((n + (n >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
  }

  const split = (hex) => [parseInt(hex.slice(0, 8), 16) >>> 0, parseInt(hex.slice(8, 16), 16) >>> 0];

  function distance(a, b) {
    const [ah, al] = split(a);
    const [bh, bl] = split(b);
    return popcount32((ah ^ bh) >>> 0) + popcount32((al ^ bl) >>> 0);
  }

  // Flat or nearly flat images (placeholders, solid backgrounds) match everything.
  function isInformative(hex) {
    const [h, l] = split(hex);
    const ones = popcount32(h) + popcount32(l);
    return ones >= 6 && ones <= 58;
  }

  class PhotoIndex {
    constructor() {
      this.entries = []; // { itemId, sellerId, hi, lo }
      this.byItem = new Map();
    }

    // Returns item IDs of other sellers' listings that look like the same photo.
    add(itemId, sellerId, hex) {
      if (this.byItem.has(itemId) || !isInformative(hex)) return [];
      const [hi, lo] = split(hex);
      const matches = [];
      for (const e of this.entries) {
        if (e.sellerId === sellerId) continue;
        if (popcount32((e.hi ^ hi) >>> 0) + popcount32((e.lo ^ lo) >>> 0) <= MATCH_DISTANCE) matches.push(e.itemId);
      }
      const entry = { itemId, sellerId, hi, lo };
      this.entries.push(entry);
      this.byItem.set(itemId, entry);
      if (this.entries.length > MAX_ENTRIES) this.byItem.delete(this.entries.shift().itemId);
      return matches;
    }
  }

  V.dhash = { W, H, MATCH_DISTANCE, fromGray, fromRGBA, distance, isInformative, PhotoIndex };
  if (typeof module === 'object' && module.exports) module.exports = V.dhash;
})(globalThis);
