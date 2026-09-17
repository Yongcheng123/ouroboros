// Layer 2: the search. These operators are what actually writes new heuristics.
// Their weights are not constants -- they are part of the genome and get
// re-estimated from measured yield every night, so the search that improves the
// heuristic is itself improved by the heuristic's results.

import * as X from './expr.mjs';

/** ctx = { rng, sigma, donors: [expr], caps } */
export const BASE_OPERATORS = [
  {
    id: 'point', zh: '点突变', en: 'point mutation',
    desc: '随机挑一个节点：常数就抖动，变量就换一个，算子就换成同元数的另一个。改动最小、命中最密。',
    apply(tree, ctx) {
      const { rng } = ctx;
      const ps = X.paths(tree);
      const p = rng.pick(ps);
      const node = X.at(tree, p);
      if (X.isConst(node)) {
        const v = node[1];
        const next = v + ctx.sigma * ctx.rng.gauss() * (Math.abs(v) + 1);
        return X.replaceAt(tree, p, ['c', Math.round(next * 1e6) / 1e6]);
      }
      if (X.isVar(node)) {
        const others = X.VAR_NAMES.filter((v) => v !== node[1]);
        return X.replaceAt(tree, p, ['v', rng.pick(others)]);
      }
      const a = X.ARITY[node[0]];
      const op = X.randomOpOfArity(rng, a);
      return X.replaceAt(tree, p, [op, ...node.slice(1)]);
    },
  },
  {
    id: 'subtree', zh: '子树替换', en: 'subtree replacement',
    desc: '把随机一棵子树整个换成新长出来的随机子树。跳得远，多数时候更差，偶尔换来一次结构性突破。',
    apply(tree, ctx) {
      const p = ctx.rng.pick(X.paths(tree));
      return X.replaceAt(tree, p, X.randomTree(ctx.rng, 3));
    },
  },
  {
    id: 'grow', zh: '外包生长', en: 'wrap and grow',
    desc: '把随机一棵子树 X 包成 op(X, 新子树)，保留原有结构再往外长一层。',
    apply(tree, ctx) {
      const { rng } = ctx;
      const p = rng.pick(X.paths(tree));
      const node = X.at(tree, p);
      const op = rng.pick(['add', 'sub', 'mul', 'div', 'min', 'max']);
      const fresh = X.randomTree(rng, 2);
      const wrapped = rng.chance(0.5) ? [op, node, fresh] : [op, fresh, node];
      return X.replaceAt(tree, p, wrapped);
    },
  },
  {
    id: 'prune', zh: '剪枝', en: 'prune',
    desc: '用随机一个内部节点的某个孩子顶替它自己。唯一会让表达式变短的破坏性算子，是对抗膨胀的主力。',
    apply(tree, ctx) {
      const { rng } = ctx;
      const inner = X.paths(tree).filter((p) => X.isOp(X.at(tree, p)));
      if (inner.length === 0) return X.randomTree(rng, 2);
      const p = rng.pick(inner);
      const node = X.at(tree, p);
      const child = node[1 + rng.int(X.ARITY[node[0]])];
      return X.replaceAt(tree, p, child);
    },
  },
  {
    id: 'jitter', zh: '常数退火', en: 'constant annealing',
    desc: '一次性抖动树里所有常数，步长 σ 由近期接受率自适应。结构不动，只调参数。',
    apply(tree, ctx) {
      const { rng, sigma } = ctx;
      const consts = X.paths(tree).filter((p) => X.isConst(X.at(tree, p)));
      if (consts.length === 0) {
        return ['add', tree, ['c', Math.round(rng.range(-1, 1) * 1e6) / 1e6]];
      }
      let out = tree;
      for (const p of consts) {
        const v = X.at(out, p)[1];
        const next = v + sigma * rng.gauss() * (Math.abs(v) + 1);
        out = X.replaceAt(out, p, ['c', Math.round(next * 1e6) / 1e6]);
      }
      return out;
    },
  },
  {
    id: 'crossover', zh: '精英杂交', en: 'elite crossover',
    desc: '从另一个精英身上剪一棵子树接到自己身上。唯一会在个体之间搬运结构的算子。',
    apply(tree, ctx) {
      const { rng, donors } = ctx;
      if (!donors || donors.length === 0) return BASE_OPERATORS[1].apply(tree, ctx);
      const donor = rng.pick(donors);
      const graft = X.at(donor, rng.pick(X.paths(donor)));
      const p = rng.pick(X.paths(tree));
      return X.replaceAt(tree, p, graft);
    },
  },
  {
    id: 'addterm', zh: '追加修正项', en: 'append correction term',
    desc: '在根部加一个 c·f(...) 的小修正项。专门用来在已经不错的分数上叠加微调，不破坏主干。',
    apply(tree, ctx) {
      const { rng } = ctx;
      const c = Math.round(rng.range(-1.5, 1.5) * 1e6) / 1e6;
      const term = X.randomTree(rng, 2);
      return ['add', tree, ['mul', ['c', c], term]];
    },
  },
  {
    id: 'simplify', zh: '化简', en: 'algebraic simplify',
    desc: '常数折叠与代数恒等化简。适应度一分不涨，但个体变短后会落进更小的精英格，是唯一"无损"的算子。',
    apply(tree) { return X.simplify(tree); },
  },
];

export function operatorById(genome, id) {
  return (genome.search.operators || []).find((o) => o.id === id);
}

/** Composite operators are minted at runtime (see evolve.mjs) and stored in the
 *  genome as an ordered list of base-operator ids. */
export function applyOperator(opRecord, tree, ctx) {
  if (opRecord.kind === 'composite') {
    let out = tree;
    for (const partId of opRecord.parts) {
      const base = BASE_OPERATORS.find((b) => b.id === partId);
      if (base) out = base.apply(out, ctx);
    }
    return out;
  }
  const base = BASE_OPERATORS.find((b) => b.id === opRecord.id);
  if (!base) throw new Error(`unknown operator ${opRecord.id}`);
  return base.apply(tree, ctx);
}

export function describeOperator(opRecord) {
  if (opRecord.kind === 'composite') {
    const parts = opRecord.parts.map((p) => BASE_OPERATORS.find((b) => b.id === p)?.zh ?? p);
    return `引擎在第 ${opRecord.born} 代自行合成：依次执行 ${parts.join(' → ')}。`;
  }
  return BASE_OPERATORS.find((b) => b.id === opRecord.id)?.desc ?? '';
}

export function operatorLabel(opRecord) {
  if (opRecord.kind === 'composite') {
    const parts = opRecord.parts.map((p) => BASE_OPERATORS.find((b) => b.id === p)?.zh ?? p);
    return parts.join('→');
  }
  return BASE_OPERATORS.find((b) => b.id === opRecord.id)?.zh ?? opRecord.id;
}

export function freshOperatorRecords() {
  return BASE_OPERATORS.map((b) => ({
    id: b.id, kind: 'base', born: 0,
    q: 1, weight: Math.round((1 / BASE_OPERATORS.length) * 1e6) / 1e6,
    attempts: 0, hits: 0, bestGain: 0,
  }));
}

/**
 * Adaptive operator selection. q is a recency-weighted estimate of "chance this
 * operator lands an improvement"; weights are q renormalised with a floor, so no
 * operator is ever starved to zero and the search can always change its mind.
 */
export function updateOperatorWeights(operators, alpha = 0.18, floor = 0.03) {
  for (const op of operators) {
    const rate = op.runAttempts > 0 ? op.runHits / op.runAttempts : 0;
    op.q = round6((1 - alpha) * op.q + alpha * (rate * 12));
    if (!(op.q >= 0)) op.q = 0;
  }
  let total = 0;
  for (const op of operators) total += op.q;
  const n = operators.length;
  for (const op of operators) {
    const share = total > 0 ? op.q / total : 1 / n;
    op.weight = round6(floor + (1 - n * floor) * share);
  }
}

function round6(x) { return Math.round(x * 1e6) / 1e6; }
