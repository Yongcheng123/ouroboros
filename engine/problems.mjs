// The benchmark instances. These are FROZEN: the seeds, sizes and item counts
// below must never change, otherwise fitness recorded on day 1 is not
// comparable with fitness recorded on day 300 and the whole lineage is fiction.
//
// Four item-size distributions, each generated from a fixed seed:
//   weibull  -- OR-library style, heavy-ish tail, the classic bin-packing testbed
//   uniform  -- sizes uniform in [20,100] with capacity 150 (the "u120" shape)
//   triplet  -- sizes near C/3, so a perfect packing needs exactly three per bin
//   bimodal  -- a mixture of small filler items and large blockers

import { RNG } from './rng.mjs';

export const ITEMS_PER_INSTANCE = 500;

export const FAMILIES = [
  { id: 'weibull', label: 'Weibull', zh: '韦布尔分布', capacity: 100,
    note: 'shape 3.0 / scale 45，OR-Library 风格的经典测试集' },
  { id: 'uniform', label: 'Uniform', zh: '均匀分布', capacity: 150,
    note: '尺寸均匀取自 [20,100]，容量 150' },
  { id: 'triplet', label: 'Triplet', zh: '三元组', capacity: 1000,
    note: '尺寸贴近 C/3，最优解需要恰好三件一箱' },
  { id: 'bimodal', label: 'Bimodal', zh: '双峰分布', capacity: 100,
    note: '70% 小件填充 + 30% 大件阻塞，考验"留白"策略' },
];

function weibullSample(rng, shape, scale) {
  const u = Math.min(0.999999, Math.max(1e-9, rng.float()));
  return scale * Math.pow(-Math.log(1 - u), 1 / shape);
}

function makeSizes(familyId, capacity, n, rng) {
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    let v;
    if (familyId === 'weibull') {
      v = Math.round(weibullSample(rng, 3.0, 45));
    } else if (familyId === 'uniform') {
      v = 20 + rng.int(81); // 20..100 inclusive
    } else if (familyId === 'triplet') {
      v = 250 + rng.int(150); // 250..399, capacity 1000
    } else {
      v = rng.chance(0.7) ? 1 + rng.int(25) : 40 + rng.int(36);
    }
    out[i] = Math.max(1, Math.min(capacity, v));
  }
  return out;
}

function buildInstance(familyId, seed, tag) {
  const fam = FAMILIES.find((f) => f.id === familyId);
  const rng = new RNG(seed);
  const sizes = makeSizes(familyId, fam.capacity, ITEMS_PER_INSTANCE, rng);
  let total = 0;
  for (const s of sizes) total += s;
  return {
    id: `${familyId}-${tag}`,
    family: familyId,
    capacity: fam.capacity,
    sizes,
    total,
    lowerBound: Math.ceil(total / fam.capacity),
  };
}

// Frozen seeds. Three disjoint folds, and which fold a seed lands in is the
// single most important design decision in this project:
//
//   TRAIN  drives the search. Every candidate is scored here, thousands a night.
//   VAL    is a veto. A candidate that wins on TRAIN but loses here is dropped.
//   TEST   decides nothing, ever. It exists only so the page can report a number
//          that no part of the system was allowed to optimise against.
//
// TRAIN is kept small because it is the hot path; TEST is the largest because
// it is the only honest one.
const TRAIN_SEEDS = {
  weibull: [1011, 1012],
  uniform: [2011, 2012],
  triplet: [3011, 3012],
  bimodal: [4011, 4012],
};
const VAL_SEEDS = {
  weibull: [1501],
  uniform: [2501],
  triplet: [3501],
  bimodal: [4501],
};
const TEST_SEEDS = {
  weibull: [1901, 1902, 1903],
  uniform: [2901, 2902, 2903],
  triplet: [3901, 3902, 3903],
  bimodal: [4901, 4902, 4903],
};

let _cache = null;

export function getSuites() {
  if (_cache) return _cache;
  const build = (table, tag) => {
    const list = [];
    for (const fam of FAMILIES) {
      table[fam.id].forEach((seed, i) => list.push(buildInstance(fam.id, seed, `${tag}${i + 1}`)));
    }
    return list;
  };
  _cache = {
    train: build(TRAIN_SEEDS, 't'),
    val: build(VAL_SEEDS, 'g'),
    test: build(TEST_SEEDS, 'v'),
  };
  return _cache;
}

/** A short fingerprint of the frozen suite, printed on the page as tamper evidence. */
export function suiteFingerprint() {
  const { train, val, test } = getSuites();
  let h = 2166136261 >>> 0;
  for (const inst of [...train, ...val, ...test]) {
    for (const s of inst.sizes) {
      h ^= s;
      h = Math.imul(h, 16777619) >>> 0;
    }
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
