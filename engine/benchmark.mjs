// The verifier. Everything in OUROBOROS is allowed to propose; only this file
// is allowed to decide. It is deliberately boring, deterministic and unaware of
// where a candidate came from.

import { compile } from './expr.mjs';
import { getSuites, FAMILIES } from './problems.mjs';

/**
 * One pass of online bin packing.
 * Items arrive one at a time and must be placed immediately -- no lookahead,
 * no repacking. Among the bins that still fit, the one with the highest score
 * wins; ties go to the older bin. If nothing fits, a new bin is opened.
 */
export function packInstance(score, inst) {
  const C = inst.capacity;
  const sizes = inst.sizes;
  const rem = [];
  let n = 0;
  for (let s = 0; s < sizes.length; s++) {
    const item = sizes[s];
    const iN = item / C;
    let best = -Infinity;
    let bestIdx = -1;
    const denom = n > 1 ? n - 1 : 1;
    for (let b = 0; b < n; b++) {
      const R = rem[b];
      if (R < item) continue;
      const rN = R / C;
      const sc = score(iN, rN, rN - iN, b / denom);
      if (sc > best) { best = sc; bestIdx = b; }
    }
    if (bestIdx < 0) { rem[n++] = C - item; } else { rem[bestIdx] -= item; }
  }
  return n;
}

/** Next Fit keeps only the most recent bin open, so it needs its own loop. */
function packNextFit(inst) {
  const C = inst.capacity;
  let bins = 0;
  let rem = -1;
  for (const item of inst.sizes) {
    if (bins === 0 || rem < item) { bins++; rem = C - item; }
    else rem -= item;
  }
  return bins;
}

/** Best Fit Decreasing is offline -- it sorts first. Reference only, never a target. */
function packBFD(inst) {
  const C = inst.capacity;
  const sorted = [...inst.sizes].sort((a, b) => b - a);
  const rem = [];
  for (const item of sorted) {
    let bestIdx = -1;
    let bestGap = Infinity;
    for (let b = 0; b < rem.length; b++) {
      const gap = rem[b] - item;
      if (gap >= 0 && gap < bestGap) { bestGap = gap; bestIdx = b; }
    }
    if (bestIdx < 0) rem.push(C - item);
    else rem[bestIdx] -= item;
  }
  return rem.length;
}

/** Excess over the trivial lower bound, in percent. Lower is better; 0 is a
 *  perfect packing. This is the single number the whole project optimises. */
function excessOf(bins, inst) {
  return (bins / inst.lowerBound - 1) * 100;
}

export function scoreSuite(score, suite) {
  const perFamily = {};
  const perInstance = [];
  let sum = 0;
  for (const inst of suite) {
    const bins = packInstance(score, inst);
    const ex = excessOf(bins, inst);
    sum += ex;
    perInstance.push({ id: inst.id, bins, lowerBound: inst.lowerBound, excess: r4(ex) });
    (perFamily[inst.family] ||= []).push(ex);
  }
  const fam = {};
  for (const [k, v] of Object.entries(perFamily)) fam[k] = r4(v.reduce((a, b) => a + b, 0) / v.length);
  return { excess: r4(sum / suite.length), perFamily: fam, perInstance };
}

/** Train-fold excess only -- the hot path, called thousands of times per run. */
export function quickTrain(score) {
  const { train } = getSuites();
  let sum = 0;
  for (const inst of train) sum += excessOf(packInstance(score, inst), inst);
  return r4(sum / train.length);
}

/** The veto fold. Only ever called for candidates that already won on train,
 *  which is a few dozen times a night rather than a few thousand. */
export function quickVal(score) {
  const { val } = getSuites();
  let sum = 0;
  for (const inst of val) sum += excessOf(packInstance(score, inst), inst);
  return r4(sum / val.length);
}

export function evaluateExpr(expr) {
  const { train, val, test } = getSuites();
  const score = compile(expr);
  return {
    train: scoreSuite(score, train),
    val: scoreSuite(score, val),
    test: scoreSuite(score, test),
  };
}

export const BASELINES = [
  { id: 'nextFit', label: 'Next Fit', zh: '下次适应', kind: 'online',
    note: '只保留最后一个箱子，其余全部封箱' },
  { id: 'firstFit', label: 'First Fit', zh: '首次适应', kind: 'online',
    note: '放进第一个装得下的箱子', expr: '−k' },
  { id: 'worstFit', label: 'Worst Fit', zh: '最差适应', kind: 'online',
    note: '放进最空的箱子', expr: 'g' },
  { id: 'bestFit', label: 'Best Fit', zh: '最佳适应', kind: 'online',
    note: '放进缝隙最小的箱子，也是本项目的第 0 代', expr: '−g' },
  { id: 'bestFitDecreasing', label: 'Best Fit Decreasing', zh: '降序最佳适应', kind: 'offline',
    note: '先把所有物品降序排好再放 — 需要预知全部输入，不是同一个赛道' },
];

const BASELINE_FNS = {
  firstFit: (i, r, g, k) => -k,
  bestFit: (i, r, g, k) => -g,
  worstFit: (i, r, g, k) => g,
};

/** Baselines never change, so they are computed once and cached in the genome. */
export function computeBaselines() {
  const { train, val, test } = getSuites();
  const out = {};
  for (const b of BASELINES) {
    let run;
    if (b.id === 'nextFit') run = (suite) => suiteWith(suite, packNextFit);
    else if (b.id === 'bestFitDecreasing') run = (suite) => suiteWith(suite, packBFD);
    else run = (suite) => scoreSuite(BASELINE_FNS[b.id], suite);
    out[b.id] = { train: run(train), val: run(val), test: run(test) };
  }
  return out;
}

function suiteWith(suite, packer) {
  const perFamily = {};
  let sum = 0;
  for (const inst of suite) {
    const ex = excessOf(packer(inst), inst);
    sum += ex;
    (perFamily[inst.family] ||= []).push(ex);
  }
  const fam = {};
  for (const [k, v] of Object.entries(perFamily)) fam[k] = r4(v.reduce((a, b) => a + b, 0) / v.length);
  return { excess: r4(sum / suite.length), perFamily: fam };
}

export function familyMeta(id) { return FAMILIES.find((f) => f.id === id); }

function r4(x) { return Math.round(x * 1e4) / 1e4; }
