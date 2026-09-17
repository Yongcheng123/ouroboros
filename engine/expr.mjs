// The genotype: a small arithmetic expression tree that scores candidate bins.
//
// Encoding is plain JSON so a whole heuristic fits in a git diff:
//   constant   ["c", 0.5]
//   variable   ["v", "g"]
//   unary      ["neg", X]
//   binary     ["sub", X, Y]
//
// Nothing outside this file is allowed to invent node types; tools/selfcheck.mjs
// re-validates every committed tree against ARITY and VARS, which is what keeps
// an untrusted proposer (an LLM, a future operator) from smuggling code in.

export const ARITY = {
  add: 2, sub: 2, mul: 2, div: 2, min: 2, max: 2,
  neg: 1, inv: 1, sq: 1, sqrt: 1, log: 1,
};

export const VARS = {
  i: { zh: '件尺寸', en: 'item size', desc: '当前物品尺寸，已按箱容归一到 (0,1]' },
  r: { zh: '剩余容量', en: 'remaining', desc: '候选箱的剩余容量，归一到 [0,1]' },
  g: { zh: '放入后缝隙', en: 'gap', desc: 'r − i，放进去之后剩下的空隙' },
  k: { zh: '箱龄', en: 'bin age', desc: '候选箱在已开箱序列中的归一位置，0 最老' },
};

export const VAR_NAMES = Object.keys(VARS);
export const OP_NAMES = Object.keys(ARITY);
const UNARY = OP_NAMES.filter((o) => ARITY[o] === 1);
const BINARY = OP_NAMES.filter((o) => ARITY[o] === 2);

export const SEED_EXPR = ['neg', ['v', 'g']]; // Best Fit, the starting organism

// ---------------------------------------------------------------- structure

export function isConst(n) { return Array.isArray(n) && n[0] === 'c'; }
export function isVar(n) { return Array.isArray(n) && n[0] === 'v'; }
export function isOp(n) { return Array.isArray(n) && ARITY[n[0]] !== undefined; }

export function valid(n) {
  if (!Array.isArray(n) || n.length < 2) return false;
  if (n[0] === 'c') return n.length === 2 && typeof n[1] === 'number' && Number.isFinite(n[1]);
  if (n[0] === 'v') return n.length === 2 && VAR_NAMES.includes(n[1]);
  const a = ARITY[n[0]];
  if (a === undefined) return false;
  if (n.length !== a + 1) return false;
  for (let c = 1; c <= a; c++) if (!valid(n[c])) return false;
  return true;
}

export function size(n) {
  if (!isOp(n)) return 1;
  let s = 1;
  for (let c = 1; c < n.length; c++) s += size(n[c]);
  return s;
}

export function depth(n) {
  if (!isOp(n)) return 1;
  let d = 0;
  for (let c = 1; c < n.length; c++) d = Math.max(d, depth(n[c]));
  return d + 1;
}

export function clone(n) { return JSON.parse(JSON.stringify(n)); }
export function key(n) { return JSON.stringify(n); }

/** Every node as a [path] address, so mutation can address any point uniformly. */
export function paths(n, prefix = [], out = []) {
  out.push(prefix);
  if (isOp(n)) for (let c = 1; c < n.length; c++) paths(n[c], [...prefix, c], out);
  return out;
}

export function at(root, path) {
  let n = root;
  for (const step of path) n = n[step];
  return n;
}

export function replaceAt(root, path, node) {
  if (path.length === 0) return clone(node);
  const copy = clone(root);
  let parent = copy;
  for (let i = 0; i < path.length - 1; i++) parent = parent[path[i]];
  parent[path[path.length - 1]] = clone(node);
  return copy;
}

// ---------------------------------------------------------------- generation

export function randomConst(rng) {
  const roll = rng.float();
  if (roll < 0.25) return rng.pick([0, 1, 2, 0.5, -1]);
  if (roll < 0.8) return round6(rng.range(-2, 2));
  return round6(rng.range(-12, 12));
}

export function randomLeaf(rng) {
  return rng.chance(0.65) ? ['v', rng.pick(VAR_NAMES)] : ['c', randomConst(rng)];
}

export function randomTree(rng, maxDepth = 3) {
  if (maxDepth <= 1 || rng.chance(0.3)) return randomLeaf(rng);
  const op = rng.chance(0.3) ? rng.pick(UNARY) : rng.pick(BINARY);
  const kids = [];
  for (let c = 0; c < ARITY[op]; c++) kids.push(randomTree(rng, maxDepth - 1));
  return [op, ...kids];
}

export function randomOpOfArity(rng, a) {
  return rng.pick(a === 1 ? UNARY : BINARY);
}

function round6(x) { return Math.round(x * 1e6) / 1e6; }

// ---------------------------------------------------------------- simplify

const CLAMP = 1e6;

export function simplify(n) {
  if (!isOp(n)) {
    if (isConst(n)) return ['c', clampConst(n[1])];
    return n;
  }
  const op = n[0];
  const kids = [];
  for (let c = 1; c < n.length; c++) kids.push(simplify(n[c]));

  // constant folding
  if (kids.every(isConst)) {
    const v = foldConst(op, kids.map((k) => k[1]));
    if (v !== null) return ['c', clampConst(v)];
  }

  const [a, b] = kids;
  const ck = (x) => (isConst(x) ? x[1] : NaN);

  if (op === 'add') {
    if (ck(a) === 0) return b;
    if (ck(b) === 0) return a;
  } else if (op === 'sub') {
    if (ck(b) === 0) return a;
    if (key(a) === key(b)) return ['c', 0];
  } else if (op === 'mul') {
    if (ck(a) === 1) return b;
    if (ck(b) === 1) return a;
    if (ck(a) === 0 || ck(b) === 0) return ['c', 0];
    if (ck(a) === -1) return ['neg', b];
    if (ck(b) === -1) return ['neg', a];
  } else if (op === 'div') {
    if (ck(b) === 1) return a;
    if (ck(a) === 0) return ['c', 0];
  } else if (op === 'min' || op === 'max') {
    if (key(a) === key(b)) return a;
  } else if (op === 'neg') {
    if (a[0] === 'neg') return a[1];
  } else if (op === 'sq') {
    if (a[0] === 'neg') return ['sq', a[1]];
  }
  return [op, ...kids];
}

function clampConst(v) {
  if (!Number.isFinite(v)) return 0;
  return round6(Math.max(-CLAMP, Math.min(CLAMP, v)));
}

function foldConst(op, vals) {
  const [a, b] = vals;
  let v;
  switch (op) {
    case 'add': v = a + b; break;
    case 'sub': v = a - b; break;
    case 'mul': v = a * b; break;
    case 'div': v = a / (b < 0 ? Math.min(b, -1e-9) : Math.max(b, 1e-9)); break;
    case 'min': v = Math.min(a, b); break;
    case 'max': v = Math.max(a, b); break;
    case 'neg': v = -a; break;
    case 'inv': v = 1 / (a < 0 ? Math.min(a, -1e-9) : Math.max(a, 1e-9)); break;
    case 'sq': v = a * a; break;
    case 'sqrt': v = Math.sqrt(Math.abs(a)); break;
    case 'log': v = Math.log(Math.abs(a) + 1e-9); break;
    default: return null;
  }
  return Number.isFinite(v) ? v : null;
}

// ---------------------------------------------------------------- compile

const PRELUDE = [
  'const PD=(a,b)=>a/(b<0?Math.min(b,-1e-9):Math.max(b,1e-9));',
  'const IV=(a)=>PD(1,a);',
  'const SQ=(a)=>a*a;',
  'const SR=(a)=>Math.sqrt(Math.abs(a));',
  'const LG=(a)=>Math.log(Math.abs(a)+1e-9);',
].join('');

export function toJS(n) {
  if (isConst(n)) return fmtNum(n[1]);
  if (isVar(n)) return n[1];
  const op = n[0];
  const a = toJS(n[1]);
  const b = n.length > 2 ? toJS(n[2]) : null;
  switch (op) {
    case 'add': return `(${a}+${b})`;
    case 'sub': return `(${a}-${b})`;
    case 'mul': return `(${a}*${b})`;
    case 'div': return `PD(${a},${b})`;
    case 'min': return `Math.min(${a},${b})`;
    case 'max': return `Math.max(${a},${b})`;
    case 'neg': return `(-(${a}))`;
    case 'inv': return `IV(${a})`;
    case 'sq': return `SQ(${a})`;
    case 'sqrt': return `SR(${a})`;
    case 'log': return `LG(${a})`;
    default: throw new Error(`unknown op ${op}`);
  }
}

/** Compile to a plain JS scoring function. Non-finite scores collapse to -1e18,
 *  which makes the packer fall back to the lowest-index fitting bin. */
export function compile(n) {
  if (!valid(n)) throw new Error('invalid expression');
  const body = `${PRELUDE}const s=${toJS(n)};return s===s&&s!==Infinity&&s!==-Infinity?s:-1e18;`;
  // eslint-disable-next-line no-new-func
  return new Function('i', 'r', 'g', 'k', body);
}

function fmtNum(v) {
  if (Number.isInteger(v)) return v < 0 ? `(${v})` : String(v);
  const s = round6(v);
  return s < 0 ? `(${s})` : String(s);
}

// ---------------------------------------------------------------- pretty

const PREC = { add: 1, sub: 1, mul: 2, div: 2, neg: 3 };

/** Human-facing infix rendering with minimal parentheses. */
export function pretty(n, parentPrec = 0) {
  if (isConst(n)) return fmtPretty(n[1]);
  if (isVar(n)) return n[1];
  const op = n[0];
  const p = PREC[op] ?? 4;
  let s;
  switch (op) {
    case 'add': s = `${pretty(n[1], p)} + ${pretty(n[2], p)}`; break;
    case 'sub': s = `${pretty(n[1], p)} − ${pretty(n[2], p + 1)}`; break;
    case 'mul': s = `${pretty(n[1], p)}·${pretty(n[2], p)}`; break;
    case 'div': s = `${pretty(n[1], p)}/${pretty(n[2], p + 1)}`; break;
    case 'min': return `min(${pretty(n[1], 0)}, ${pretty(n[2], 0)})`;
    case 'max': return `max(${pretty(n[1], 0)}, ${pretty(n[2], 0)})`;
    case 'neg': s = `−${pretty(n[1], p)}`; break;
    case 'inv': return `1/(${pretty(n[1], 0)})`;
    case 'sq': return `(${pretty(n[1], 0)})²`;
    case 'sqrt': return `√|${pretty(n[1], 0)}|`;
    case 'log': return `ln|${pretty(n[1], 0)}|`;
    default: throw new Error(`unknown op ${op}`);
  }
  return p < parentPrec ? `(${s})` : s;
}

function fmtPretty(v) {
  if (Number.isInteger(v)) return String(v);
  const a = Math.abs(v);
  if (a >= 100) return v.toFixed(1);
  if (a >= 1) return v.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  return v.toPrecision(3).replace(/0+$/, '').replace(/\.$/, '');
}

/** Which variables the tree actually reads -- shown on the page as "感官". */
export function usedVars(n, acc = new Set()) {
  if (isVar(n)) acc.add(n[1]);
  else if (isOp(n)) for (let c = 1; c < n.length; c++) usedVars(n[c], acc);
  return acc;
}
