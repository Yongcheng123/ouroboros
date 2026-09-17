// Deterministic pseudo-randomness. Every run of OUROBOROS must be replayable
// from (date, generation) alone, so nothing here may touch Math.random().

export function fnv1a(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function mulberry32(a) {
  let s = a >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class RNG {
  constructor(seed) {
    this.seed = seed >>> 0;
    this._next = mulberry32(this.seed);
  }
  float() { return this._next(); }
  range(lo, hi) { return lo + (hi - lo) * this._next(); }
  int(n) { return Math.floor(this._next() * n); }
  pick(arr) { return arr[this.int(arr.length)]; }
  chance(p) { return this._next() < p; }
  gauss() {
    let u = 0, v = 0;
    while (u === 0) u = this._next();
    while (v === 0) v = this._next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  /** Weighted pick over [{item, w}]; falls back to uniform if all weights are 0. */
  weighted(entries) {
    let total = 0;
    for (const e of entries) total += Math.max(0, e.w);
    if (!(total > 0)) return this.pick(entries).item;
    let r = this._next() * total;
    for (const e of entries) {
      r -= Math.max(0, e.w);
      if (r <= 0) return e.item;
    }
    return entries[entries.length - 1].item;
  }
}

export function seedFor(...parts) {
  return fnv1a(parts.join('::'));
}
