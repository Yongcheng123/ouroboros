#!/usr/bin/env node
// One night in the life of OUROBOROS.
//
//   propose (untrusted)  ->  verify (trusted)  ->  select  ->  record  ->  render
//
// The asymmetry in that line is the whole safety design: anything may suggest a
// heuristic -- a mutation operator, an LLM, a future version of this file -- but
// only benchmark.mjs decides, and only on a frozen suite, and only by a margin.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { RNG, seedFor } from './rng.mjs';
import * as X from './expr.mjs';
import { quickTrain, quickVal, evaluateExpr, computeBaselines } from './benchmark.mjs';
import { suiteFingerprint } from './problems.mjs';
import {
  BASE_OPERATORS, applyOperator, freshOperatorRecords,
  updateOperatorWeights, operatorLabel,
} from './operators.mjs';
import { renderSite } from './render.mjs';
import { proposeFromLLM } from './proposer-llm.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GENOME = path.join(ROOT, 'genome.json');
const HISTORY = path.join(ROOT, 'history.json');
const INDEX = path.join(ROOT, 'index.html');

// MAP-Elites: one cell per expression-size band. Keeping a champion per band is
// what stops the search from collapsing into a single bloated lineage.
export const CELLS = [
  { id: '1-3', lo: 1, hi: 3 },
  { id: '4-6', lo: 4, hi: 6 },
  { id: '7-10', lo: 7, hi: 10 },
  { id: '11-15', lo: 11, hi: 15 },
  { id: '16-22', lo: 16, hi: 22 },
  { id: '23-32', lo: 23, hi: 32 },
  { id: '33-48', lo: 33, hi: 48 },
  { id: '49-64', lo: 49, hi: 64 },
];

const cellFor = (n) => CELLS.find((c) => n >= c.lo && n <= c.hi) ?? null;

// ------------------------------------------------------------------ genesis

export function genesisGenome(date) {
  const expr = X.SEED_EXPR;
  const ev = evaluateExpr(expr);
  return {
    schema: 1,
    project: {
      name: 'OUROBOROS',
      tagline: '一个每天重写自己的网站',
      born: date,
      subject: 'online-bin-packing',
      repo: process.env.OUROBOROS_REPO || 'https://github.com/Yongcheng123/ouroboros',
      site: process.env.OUROBOROS_SITE || 'https://yongcheng123.github.io/ouroboros/',
    },
    generation: 0,
    suiteFingerprint: suiteFingerprint(),
    champion: {
      expr,
      size: X.size(expr),
      depth: X.depth(expr),
      train: ev.train,
      val: ev.val,
      test: ev.test,
      bornGen: 0,
      bornOp: 'seed',
      bornDate: date,
      source: 'seed',
    },
    elites: CELLS.map((c) => ({ ...c, expr: null })),
    search: {
      operators: freshOperatorRecords(),
      pairs: {},
      composites: 0,
      sigma: 0.3,
      stagnation: 0,
      acceptMargin: 0.004,
      budget: { evaluations: 12000, min: 6000, max: 60000 },
      caps: { maxSize: 64, maxDepth: 14 },
    },
    baselines: computeBaselines(),
    milestones: [],
    log: [],
    stats: {
      generations: 0, totalEvaluations: 0, totalProposed: 0,
      totalAccepted: 0, totalRejected: 0, totalVetoed: 0,
      llmProposals: 0, llmAccepted: 0,
    },
    lastRun: {
      date, generation: 0, seed: 0, evaluations: 0, proposed: 0,
      accepted: false, elapsedMs: 0, integrity: 'ok', source: 'genesis',
    },
  };
}

// ------------------------------------------------------------- one generation

function selectParent(rng, genome, reheat) {
  // A stuck search that keeps mutating the same champion just re-samples the
  // same neighbourhood all night. Random restarts are the cheapest way out.
  if (reheat && rng.chance(0.18)) return X.randomTree(rng, 4);
  const occupied = genome.elites.filter((e) => e.expr);
  if (occupied.length === 0 || rng.chance(0.35)) return genome.champion.expr;
  return rng.pick(occupied).expr;
}

function withinCaps(tree, caps) {
  return X.size(tree) <= caps.maxSize && X.depth(tree) <= caps.maxDepth;
}

function runGeneration(genome, opts) {
  const started = Date.now();
  const gen = genome.generation + 1;
  const seed = seedFor('ouroboros', opts.date, String(gen));
  const rng = new RNG(seed);
  const caps = genome.search.caps;
  const ops = genome.search.operators;

  // --- integrity gate: does the committed champion still score what we claim?
  const recheck = quickTrain(X.compile(genome.champion.expr));
  const integrity = Math.abs(recheck - genome.champion.train.excess) < 1e-9 ? 'ok' : 'repaired';
  if (integrity === 'repaired') {
    const ev = evaluateExpr(genome.champion.expr);
    genome.champion.train = ev.train;
    genome.champion.val = ev.val;
    genome.champion.test = ev.test;
  }

  const before = {
    train: genome.champion.train.excess,
    val: genome.champion.val.excess,
    test: genome.champion.test.excess,
  };
  const baseVal = before.val;
  const margin = genome.search.acceptMargin ?? 0.004;
  const stagnation = genome.search.stagnation ?? 0;
  const reheat = stagnation >= 2;
  for (const op of ops) { op.runAttempts = 0; op.runHits = 0; }

  const seen = new Set([X.key(genome.champion.expr)]);
  let bestTrain = genome.champion.train.excess;
  let bestVal = genome.champion.val.excess;
  let bestExpr = genome.champion.expr;
  let bestOpId = genome.champion.bornOp;
  let bestSource = genome.champion.source ?? 'gp';
  let evaluations = 0;
  let proposed = 0;
  let cellHits = 0;
  let vetoed = 0;
  let contenders = 0;
  const pairs = genome.search.pairs;
  const runPairs = {};
  const gains = [];

  const consider = (tree, opId, source) => {
    proposed++;
    if (!X.valid(tree)) return false;
    let t = tree;
    if (!withinCaps(t, caps)) {
      t = X.simplify(t);
      if (!withinCaps(t, caps)) return false;
    }
    const k = X.key(t);
    if (seen.has(k)) return false;
    seen.add(k);

    let score;
    try { score = X.compile(t); } catch { return false; }
    let train;
    try { train = quickTrain(score); } catch { return false; }
    evaluations++;
    if (!Number.isFinite(train)) return false;

    let hit = false;
    const cell = cellFor(X.size(t));
    if (cell) {
      const slot = genome.elites.find((e) => e.id === cell.id);
      if (slot && (!slot.expr || train < slot.train - 1e-9)) {
        slot.expr = t;
        slot.train = train;
        slot.size = X.size(t);
        slot.bornGen = gen;
        slot.bornOp = opId;
        hit = true;
        cellHits++;
      }
    }
    if (train < bestTrain - margin) {
      contenders++;
      // The veto fold. A candidate that wins on train but costs bins on val is
      // a candidate that learned this month's instances, not the distribution.
      const v = quickVal(score);
      if (v > baseVal + 1e-9) {
        vetoed++;
        return hit;
      }
      gains.push(Math.round((bestTrain - train) * 1e4) / 1e4);
      bestTrain = train;
      bestExpr = t;
      bestVal = v;
      bestOpId = opId;
      bestSource = source;
      hit = true;
    }
    return hit;
  };

  // --- optional untrusted proposer: an LLM gets to suggest, never to decide
  const llm = { requested: 0, parsed: 0, accepted: 0, model: null, error: null };
  if (opts.llm) {
    const res = proposeFromLLM(genome, opts).catch((e) => ({ error: String(e && e.message || e) }));
    opts.llmPending = res;
  }

  // --- layer 1: evolutionary search
  const budget = genome.search.budget.evaluations;
  const deadline = started + (opts.timeCapMs ?? 240000);
  const ctx = { rng, sigma: genome.search.sigma, caps, donors: [] };

  while (evaluations < budget && Date.now() < deadline) {
    ctx.donors = genome.elites.filter((e) => e.expr).map((e) => e.expr);
    const parent = selectParent(rng, genome, reheat);
    const opRecord = rng.weighted(ops.map((o) => ({ item: o, w: o.weight })));

    // Occasionally chain two operators. Pairs that out-yield every single
    // operator are what later get minted into named composites.
    const chain = opRecord.kind === 'base' && rng.chance(reheat ? 0.28 : 0.12);
    const second = chain ? rng.pick(BASE_OPERATORS.filter((b) => b.id !== opRecord.id)) : null;

    let child;
    try {
      child = applyOperator(opRecord, parent, ctx);
      if (second) child = second.apply(child, ctx);
    } catch { continue; }

    const label = second ? `${opRecord.id}+${second.id}` : opRecord.id;
    const hit = consider(child, label, 'gp');

    opRecord.attempts++; opRecord.runAttempts++;
    if (hit) { opRecord.hits++; opRecord.runHits++; }
    if (second) {
      const pk = `${opRecord.id}|${second.id}`;
      const rec = (runPairs[pk] ||= { attempts: 0, hits: 0 });
      rec.attempts++; if (hit) rec.hits++;
      const life = (pairs[pk] ||= { attempts: 0, hits: 0 });
      life.attempts++; if (hit) life.hits++;
    }
  }

  return {
    gen, seed, started, integrity, before,
    evaluations, proposed, cellHits, gains, runPairs, vetoed, contenders,
    stagnation, reheat,
    bestTrain, bestVal, bestExpr, bestOpId, bestSource, llm,
  };
}

// ---------------------------------------------------------------- adaptation

function adapt(genome, run) {
  const ops = genome.search.operators;
  let attempts = 0, hits = 0;
  for (const op of ops) { attempts += op.runAttempts; hits += op.runHits; }
  const rate = attempts > 0 ? hits / attempts : 0;

  // Step-size control. The first version of this rule compared the hit rate
  // against a fixed 2% threshold, which sounds reasonable and is completely
  // wrong: once the elite archive saturates, a perfectly healthy search hits
  // well under 0.1%, so sigma contracted every single night and the search
  // cooled down exactly when it needed to widen. It sat at one champion for
  // five generations before anyone noticed.
  //
  // The rule now keys off the only signal that means anything -- did tonight
  // produce a new champion -- and reheats on failure instead of freezing.
  const improved = run.gains.length > 0;
  const prevSigma = genome.search.sigma;
  let sigma = improved ? prevSigma * 0.9 : prevSigma * 1.35;
  sigma = Math.max(0.05, Math.min(2, Math.round(sigma * 1e4) / 1e4));
  genome.search.sigma = sigma;
  const prevStagnation = genome.search.stagnation ?? 0;
  genome.search.stagnation = improved ? 0 : prevStagnation + 1;

  updateOperatorWeights(ops);

  // Budget control: a barren night buys more compute for the next one.
  const b = genome.search.budget;
  const prevBudget = b.evaluations;
  let next = improved ? prevBudget * 0.9 : prevBudget * 1.4;
  b.evaluations = Math.round(Math.max(b.min, Math.min(b.max, next)));

  // Mint a composite operator when a chained pair beats every single operator.
  let minted = null;
  const bestSingle = Math.max(
    0,
    ...ops.filter((o) => o.runAttempts >= 40).map((o) => o.runHits / o.runAttempts),
  );
  if ((genome.search.composites ?? 0) < 4) {
    for (const [pk, rec] of Object.entries(genome.search.pairs)) {
      if (rec.attempts < 60) continue;
      const yieldRate = rec.hits / rec.attempts;
      if (!(yieldRate > bestSingle * 1.25) || yieldRate <= 0) continue;
      const parts = pk.split('|');
      const id = `x_${parts.join('_')}`;
      if (ops.some((o) => o.id === id)) continue;
      const record = {
        id, kind: 'composite', parts, born: run.gen,
        q: Math.max(...ops.map((o) => o.q)) * 0.9,
        weight: 0.05, attempts: 0, hits: 0, bestGain: 0, runAttempts: 0, runHits: 0,
      };
      ops.push(record);
      genome.search.composites = (genome.search.composites ?? 0) + 1;
      updateOperatorWeights(ops);
      minted = { id, parts, yieldRate: Math.round(yieldRate * 1e4) / 1e4, bestSingle: Math.round(bestSingle * 1e4) / 1e4 };
      break;
    }
  }

  return {
    rate: Math.round(rate * 1e5) / 1e5, prevSigma, sigma, prevBudget,
    budget: b.evaluations, minted, improved,
    stagnation: genome.search.stagnation, prevStagnation,
  };
}

// ---------------------------------------------------------------- milestones

const MILESTONES = [
  { id: 'beat-firstfit', title: '越过 First Fit',
    test: (g) => g.champion.train.excess < g.baselines.firstFit.train.excess,
    body: (g) => `冠军在训练集上的超额率首次低于 First Fit（${fmt(g.baselines.firstFit.train.excess)}%）。` },
  { id: 'beat-bestfit', title: '越过 Best Fit',
    test: (g) => g.champion.train.excess < g.baselines.bestFit.train.excess,
    body: (g) => `第 0 代的出发点被甩在身后。Best Fit 在训练集上是 ${fmt(g.baselines.bestFit.train.excess)}%，冠军已经更低。` },
  { id: 'gain-025', title: '领先 Best Fit 0.25 个百分点',
    test: (g) => g.baselines.bestFit.train.excess - g.champion.train.excess >= 0.25,
    body: () => '在装箱问题上，四分之一个百分点意味着每四百个箱子省下一个。' },
  { id: 'gain-050', title: '领先 Best Fit 0.5 个百分点',
    test: (g) => g.baselines.bestFit.train.excess - g.champion.train.excess >= 0.5,
    body: () => '差距拉开到半个百分点，已经超出任何一次随机重跑的噪声范围。' },
  { id: 'gain-100', title: '领先 Best Fit 1 个百分点',
    test: (g) => g.baselines.bestFit.train.excess - g.champion.train.excess >= 1.0,
    body: () => '整整一个百分点。此时进化出的规则已经不是"调参"能解释的东西了。' },
  { id: 'beat-bfd', title: '在线算法追平离线的 Best Fit Decreasing',
    test: (g) => g.champion.train.excess < g.baselines.bestFitDecreasing.train.excess,
    body: () => '一个不能预知未来的算法，在这套实例上追平了可以先排序的算法。这条不该轻易出现，如果出现了，第一件事是怀疑实例集而不是庆祝。' },
  { id: 'test-holds', title: '泛化站住了',
    test: (g) => g.generation >= 5 && g.champion.test.excess < g.baselines.bestFit.test.excess,
    body: () => '改进同时出现在从未参与选择的留出集上 — 学到的是分布的结构，不是训练实例的指纹。' },
  { id: 'gen-10', title: '第 10 代', test: (g) => g.generation >= 10, body: () => '十次自我改写。' },
  { id: 'gen-30', title: '第 30 代', test: (g) => g.generation >= 30, body: () => '三十次自我改写，血统表已经比大多数人的实验记录长。' },
  { id: 'gen-100', title: '第 100 代', test: (g) => g.generation >= 100, body: () => '一百次。' },
];

function checkMilestones(genome, gen, date) {
  const fresh = [];
  for (const m of MILESTONES) {
    if (genome.milestones.some((x) => x.id === m.id)) continue;
    let ok = false;
    try { ok = m.test(genome); } catch { ok = false; }
    if (!ok) continue;
    const entry = { id: m.id, title: m.title, body: m.body(genome), gen, date };
    genome.milestones.push(entry);
    fresh.push(entry);
  }
  return fresh;
}

// ------------------------------------------------------------------- logging

function fmt(x, d = 3) { return Number(x).toFixed(d); }
function pp(x) { const v = Number(x); return `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(3)}`; }

function composeLog(genome, run, adaptation, accepted, deltas, fresh) {
  const lines = [];
  const opName = accepted ? labelOf(genome, run.bestOpId) : null;

  if (accepted) {
    lines.push(
      `本轮评估 ${run.evaluations.toLocaleString('en-US')} 个候选，接受 1 个。` +
      `训练集超额率 ${fmt(run.before.train)}% → ${fmt(genome.champion.train.excess)}%（${pp(-deltas.train)} pp），` +
      `由「${opName}」产出，表达式 ${genome.champion.size} 个节点。`,
    );
    const gg = deltas.test;
    if (gg > 1e-6) {
      lines.push(`留出集同步走低 ${pp(-gg)} pp — 改进在从未参与任何决定的实例上也成立。`);
    } else if (gg < -1e-6) {
      lines.push(`但留出集反而上升 ${pp(-gg)} pp — 泛化间隙在扩大。记录在案，不回滚：留出集一旦参与决定就不再是留出集，掩盖它才是作弊。`);
    } else {
      lines.push('留出集分毫未动 — 改进恰好落在训练实例的特异结构上。');
    }
  } else {
    lines.push(
      `本轮评估 ${run.evaluations.toLocaleString('en-US')} 个候选，冠军一个都没被推翻。` +
      `精英档案里有 ${run.cellHits} 个格子被刷新 — 主干没动，侧枝在长。`,
    );
    lines.push(`下一轮预算自动上调到 ${adaptation.budget.toLocaleString('en-US')} 次评估。搜索不出结果时，先加算力，而不是先放宽验收标准。`);
  }

  if (run.vetoed > 0) {
    lines.push(
      `有 ${run.vetoed} 个候选在训练折上确实更优，但被验证折否决 —— 它们在训练实例上省下的箱子，` +
      `在没见过的实例上又赔了回去。这 ${run.vetoed} 次否决是这套三折划分当晚唯一的产出，也是它存在的全部理由。` +
      (run.contenders > 0 ? `当晚共 ${run.contenders} 个候选闯到这一关，${(100 * run.vetoed / run.contenders).toFixed(0)}% 被挡下。` : ''),
    );
  }
  if (adaptation.minted) {
    const parts = adaptation.minted.parts.map((p) => BASE_OPERATORS.find((b) => b.id === p)?.zh ?? p);
    lines.push(
      `引擎自行合成了一个新算子「${parts.join('→')}」：这对组合在 ${genome.search.pairs[adaptation.minted.parts.join('|')].attempts} 次串联试验中的命中率是 ` +
      `${(adaptation.minted.yieldRate * 100).toFixed(2)}%，高于任何单一算子的 ${(adaptation.minted.bestSingle * 100).toFixed(2)}%。算子集合从此多了一行。`,
    );
  }
  if (run.integrity === 'repaired') {
    lines.push('完整性检查不通过：重算冠军得分与记录不符，已按重算结果修正。这一行出现说明某处有非确定性，值得去查。');
  }
  for (const m of fresh) lines.push(`里程碑 — ${m.title}：${m.body}`);

  const sigmaMoved = Math.abs(adaptation.sigma - adaptation.prevSigma) > 1e-6;
  if (sigmaMoved) {
    lines.push(
      accepted
        ? `找到东西之后收紧搜索：退火步长 σ ${adaptation.prevSigma.toFixed(3)} → ${adaptation.sigma.toFixed(3)}，在新冠军附近精修。`
        : `没找到东西就放大搜索：退火步长 σ ${adaptation.prevSigma.toFixed(3)} → ${adaptation.sigma.toFixed(3)}。连续第 ${adaptation.stagnation} 晚无进展` +
          (adaptation.stagnation >= 2
            ? `，已进入重加热状态 —— 18% 的试验改为完全随机重启，算子串联概率从 12% 提到 28%。`
            : '。'),
    );
  }
  if (run.reheat && accepted) {
    lines.push(`这一步是在重加热状态下找到的：卡了 ${run.stagnation} 晚之后，靠放大步长和随机重启走出来。`);
  }
  return lines;
}

function labelOf(genome, opId) {
  if (!opId) return '未知';
  if (opId.includes('+')) {
    return opId.split('+').map((id) => BASE_OPERATORS.find((b) => b.id === id)?.zh ?? id).join('→');
  }
  const rec = genome.search.operators.find((o) => o.id === opId);
  if (rec) return operatorLabel(rec);
  return BASE_OPERATORS.find((b) => b.id === opId)?.zh ?? opId;
}

// ----------------------------------------------------------------- the driver

export async function stepOnce(genome, history, opts) {
  const run = runGeneration(genome, opts);

  // fold in LLM proposals, if any -- they face the identical gate
  if (opts.llmPending) {
    const res = await opts.llmPending;
    opts.llmPending = null;
    run.llm.model = res?.model ?? null;
    run.llm.error = res?.error ?? null;
    run.llm.requested = res?.requested ?? 0;
    const cands = res?.candidates ?? [];
    run.llm.parsed = cands.length;
    for (const expr of cands) {
      if (!X.valid(expr)) continue;
      let score;
      try { score = X.compile(expr); } catch { continue; }
      let train;
      try { train = quickTrain(score); } catch { continue; }
      run.evaluations++;
      if (train < run.bestTrain - (genome.search.acceptMargin ?? 0.004)) {
        run.contenders++;
        const v = quickVal(score);
        if (v > run.before.val + 1e-9) { run.vetoed++; continue; }
        run.bestTrain = train;
        run.bestVal = v;
        run.bestExpr = expr;
        run.bestOpId = 'llm';
        run.bestSource = 'llm';
        run.llm.accepted++;
        run.gains.push(Math.round((run.before.train - train) * 1e4) / 1e4);
      }
    }
    genome.stats.llmProposals += run.llm.parsed;
    genome.stats.llmAccepted += run.llm.accepted;
  }

  const accepted = X.key(run.bestExpr) !== X.key(genome.champion.expr);
  let deltas = { train: 0, val: 0, test: 0 };

  if (accepted) {
    // Store the champion in simplified form whenever simplification is free.
    // Without this the champion drifts up against the size cap, most mutations
    // start overflowing it, and the search quietly strangles itself -- which is
    // exactly what the first run of this engine did, for four nights straight.
    const simp = X.simplify(run.bestExpr);
    if (X.size(simp) < X.size(run.bestExpr)) {
      let same = false;
      try { same = quickTrain(X.compile(simp)) === run.bestTrain; } catch { same = false; }
      if (same) run.bestExpr = simp;
    }
    const ev = evaluateExpr(run.bestExpr);
    deltas = {
      train: run.before.train - ev.train.excess,
      val: run.before.val - ev.val.excess,
      test: run.before.test - ev.test.excess,
    };
    genome.champion = {
      expr: run.bestExpr,
      size: X.size(run.bestExpr),
      depth: X.depth(run.bestExpr),
      train: ev.train,
      val: ev.val,
      test: ev.test,
      bornGen: run.gen,
      bornOp: run.bestOpId,
      bornDate: opts.date,
      source: run.bestSource,
    };
    const winner = genome.search.operators.find((o) => o.id === run.bestOpId);
    if (winner) winner.bestGain = Math.max(winner.bestGain ?? 0, Math.round(deltas.train * 1e4) / 1e4);
  }

  // Elite cells only store train scores during the run; fill in test lazily for display.
  for (const slot of genome.elites) {
    if (slot.expr && slot.test === undefined) {
      slot.test = evaluateExpr(slot.expr).test.excess;
    } else if (slot.expr && slot.bornGen === run.gen) {
      slot.test = evaluateExpr(slot.expr).test.excess;
    }
  }

  genome.generation = run.gen;
  const adaptation = adapt(genome, run);
  const fresh = checkMilestones(genome, run.gen, opts.date);
  const elapsedMs = Date.now() - run.started;

  genome.stats.generations = run.gen;
  genome.stats.totalEvaluations += run.evaluations;
  genome.stats.totalProposed += run.proposed;
  if (accepted) genome.stats.totalAccepted += 1; else genome.stats.totalRejected += 1;
  genome.stats.totalVetoed = (genome.stats.totalVetoed ?? 0) + run.vetoed;

  genome.lastRun = {
    date: opts.date, generation: run.gen, seed: run.seed,
    evaluations: run.evaluations, proposed: run.proposed,
    accepted, elapsedMs, integrity: run.integrity,
    vetoed: run.vetoed, contenders: run.contenders,
    hitRate: adaptation.rate, cellHits: run.cellHits,
    sigma: adaptation.sigma, budget: adaptation.budget,
    source: run.bestSource, label: opts.label ?? 'daily',
    llm: run.llm,
  };

  const body = composeLog(genome, run, adaptation, accepted, deltas, fresh);
  genome.log.unshift({
    gen: run.gen, date: opts.date, accepted,
    title: accepted
      ? `接受 — 训练集 ${fmt(genome.champion.train.excess)}%`
      : `无改进 — 维持 ${fmt(genome.champion.train.excess)}%`,
    body,
  });
  genome.log = genome.log.slice(0, 40);

  history.push({
    gen: run.gen, date: opts.date, seed: run.seed, label: opts.label ?? 'daily',
    evaluations: run.evaluations, proposed: run.proposed, accepted,
    op: accepted ? run.bestOpId : null,
    opLabel: accepted ? labelOf(genome, run.bestOpId) : null,
    trainBefore: round4(run.before.train), trainAfter: round4(genome.champion.train.excess),
    valAfter: round4(genome.champion.val.excess),
    testBefore: round4(run.before.test), testAfter: round4(genome.champion.test.excess),
    vetoed: run.vetoed, contenders: run.contenders,
    size: genome.champion.size, sigma: adaptation.sigma, budget: adaptation.budget,
    hitRate: adaptation.rate, cellHits: run.cellHits, elapsedMs,
    minted: adaptation.minted ? adaptation.minted.id : null,
    milestones: fresh.map((m) => m.id),
  });

  for (const op of genome.search.operators) { delete op.runAttempts; delete op.runHits; }
  return { accepted, deltas, run, adaptation, fresh };
}

function round4(x) { return Math.round(Number(x) * 1e4) / 1e4; }

function parseArgs(argv) {
  const out = { generations: 1, llm: false, label: 'daily' };
  for (const a of argv.slice(2)) {
    const [k, v] = a.replace(/^--/, '').split('=');
    if (k === 'date') out.date = v;
    else if (k === 'generations') out.generations = Math.max(1, Math.min(50, parseInt(v, 10) || 1));
    else if (k === 'evaluations') out.evaluations = parseInt(v, 10);
    else if (k === 'llm') out.llm = v !== 'false';
    else if (k === 'label') out.label = v;
    else if (k === 'reset') out.reset = true;
    else if (k === 'render-only') out.renderOnly = true;
  }
  out.date ||= new Date().toISOString().slice(0, 10);
  return out;
}

async function main() {
  const opts = parseArgs(process.argv);

  let genome;
  let history;
  if (opts.reset || !fs.existsSync(GENOME)) {
    genome = genesisGenome(opts.date);
    history = [];
    console.log(`[ouroboros] genesis at ${opts.date}: Best Fit, train ${fmt(genome.champion.train.excess)}%`);
  } else {
    genome = JSON.parse(fs.readFileSync(GENOME, 'utf8'));
    history = JSON.parse(fs.readFileSync(HISTORY, 'utf8'));
  }

  // The frozen suite must stay frozen. If it ever moves, every recorded number
  // in history became meaningless, so refuse to add more.
  const fp = suiteFingerprint();
  if (genome.suiteFingerprint && genome.suiteFingerprint !== fp) {
    console.error(`[ouroboros] FATAL: benchmark suite changed (${genome.suiteFingerprint} -> ${fp}).`);
    console.error('The lineage is only meaningful against a frozen suite. Refusing to evolve.');
    process.exit(2);
  }
  genome.suiteFingerprint = fp;
  genome.baselines = computeBaselines();

  if (!opts.renderOnly) {
    if (opts.evaluations) genome.search.budget.evaluations = opts.evaluations;
    for (let n = 0; n < opts.generations; n++) {
      const r = await stepOnce(genome, history, opts);
      const tag = r.accepted ? 'ACCEPT' : 'hold  ';
      console.log(
        `[ouroboros] gen ${String(genome.generation).padStart(3)} ${tag} ` +
        `train ${fmt(genome.champion.train.excess)}%  val ${fmt(genome.champion.val.excess)}%  test ${fmt(genome.champion.test.excess)}%  ` +
        `size ${String(genome.champion.size).padStart(2)}  ` +
        `evals ${r.run.evaluations}  veto ${r.run.vetoed}  via ${r.accepted ? labelOf(genome, r.run.bestOpId) : '-'}`,
      );
    }
  }

  fs.writeFileSync(GENOME, `${JSON.stringify(genome, null, 2)}\n`);
  fs.writeFileSync(HISTORY, `${JSON.stringify(history, null, 2)}\n`);
  fs.writeFileSync(INDEX, renderSite(genome, history));

  const g = genome;
  const delta = g.baselines.bestFit.train.excess - g.champion.train.excess;
  const msg =
    `gen ${g.generation}: train ${fmt(g.champion.train.excess)}% ` +
    `(${delta >= 0 ? '−' : '+'}${Math.abs(delta).toFixed(3)}pp vs Best Fit), ` +
    `test ${fmt(g.champion.test.excess)}%, ${g.lastRun.accepted ? 'accepted' : 'no change'}`;
  fs.writeFileSync(path.join(ROOT, '.commitmsg'), `${msg}\n`);
  console.log(`[ouroboros] ${msg}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
