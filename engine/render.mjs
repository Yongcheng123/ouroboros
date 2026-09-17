// genome.json + history.json  ->  index.html
//
// Deterministic by contract: same inputs, same bytes. tools/selfcheck.mjs
// re-renders and diffs against the committed file, so a renderer that reaches
// for Date.now(), Math.random() or an unordered object fails the build.

import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

import * as X from './expr.mjs';
import { BASELINES, familyMeta } from './benchmark.mjs';
import { FAMILIES, ITEMS_PER_INSTANCE, getSuites } from './problems.mjs';
import { BASE_OPERATORS, operatorLabel, describeOperator } from './operators.mjs';

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const n3 = (x) => Number(x).toFixed(3);
const n2 = (x) => Number(x).toFixed(2);
const int = (x) => Number(x).toLocaleString('en-US');
// Signed difference in excess rate. Negative means fewer bins, i.e. better.
const diff = (x) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(3)}`;
const mag = (x) => Math.abs(x).toFixed(3);

// ============================================================ chart primitives

function axisTicks(lo, hi, count) {
  const span = hi - lo;
  if (!(span > 0)) return [lo];
  const raw = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

function lineChart({
  series, hlines = [], width = 940, height = 330,
  xLabel = '', yLabel = '', yFmt = (v) => n2(v), xFmt = (v) => String(v),
  integerX = false, caption = '',
}) {
  const pad = { l: 62, r: 18, t: 20, b: 46 };
  const iw = width - pad.l - pad.r;
  const ih = height - pad.t - pad.b;
  const pts = series.flatMap((s) => s.points);
  if (pts.length === 0) return '';
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y).concat(hlines.map((h) => h.y));
  let x0 = Math.min(...xs); let x1 = Math.max(...xs);
  let y0 = Math.min(...ys); let y1 = Math.max(...ys);
  if (x1 === x0) { x0 -= 0.5; x1 += 0.5; }
  const span = (y1 - y0) || Math.max(1e-6, Math.abs(y1) * 0.1) || 1;
  y0 -= span * 0.14; y1 += span * 0.14;
  const PX = (v) => pad.l + ((v - x0) / (x1 - x0)) * iw;
  const PY = (v) => pad.t + ih - ((v - y0) / (y1 - y0)) * ih;

  const yt = axisTicks(y0, y1, 5);
  const xtRaw = axisTicks(x0, x1, Math.min(8, Math.max(2, Math.round(x1 - x0))));
  const xt = integerX ? [...new Set(xtRaw.map(Math.round))].filter((v) => v >= x0 && v <= x1) : xtRaw;

  const grid = yt.map((v) => `<line class="grid" x1="${pad.l}" y1="${PY(v).toFixed(1)}" x2="${pad.l + iw}" y2="${PY(v).toFixed(1)}"/>`).join('');
  const ylab = yt.map((v) => `<text class="tick" x="${pad.l - 10}" y="${(PY(v) + 4).toFixed(1)}" text-anchor="end">${esc(yFmt(v))}</text>`).join('');
  const xlab = xt.map((v) => `<text class="tick" x="${PX(v).toFixed(1)}" y="${pad.t + ih + 20}" text-anchor="middle">${esc(xFmt(v))}</text>`).join('');

  const rules = hlines.map((h) => `
    <line class="rule" style="stroke:${h.color}" x1="${pad.l}" y1="${PY(h.y).toFixed(1)}" x2="${pad.l + iw}" y2="${PY(h.y).toFixed(1)}"/>
    <text class="rulelab" style="fill:${h.color}" x="${pad.l + iw - 4}" y="${(PY(h.y) - 6).toFixed(1)}" text-anchor="end">${esc(h.label)}</text>`).join('');

  const paths = series.map((s) => {
    const d = s.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${PX(p.x).toFixed(1)},${PY(p.y).toFixed(1)}`).join('');
    const dots = s.points.length <= 60
      ? s.points.map((p) => `<circle cx="${PX(p.x).toFixed(1)}" cy="${PY(p.y).toFixed(1)}" r="2.6" style="fill:${s.color}"/>`).join('')
      : '';
    return `<path class="series" style="stroke:${s.color}${s.dashed ? ';stroke-dasharray:5 4' : ''}" d="${d}"/>${dots}`;
  }).join('');

  const legend = series.map((s, i) => `
    <g transform="translate(${pad.l + i * 150},${pad.t - 6})">
      <rect width="18" height="3" y="-3" rx="1.5" style="fill:${s.color}"/>
      <text class="legend" x="24" y="1">${esc(s.name)}</text>
    </g>`).join('');

  return `<figure class="chart">
<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(caption || yLabel)}">
  <g>${grid}</g>
  <line class="axis" x1="${pad.l}" y1="${pad.t}" x2="${pad.l}" y2="${pad.t + ih}"/>
  <line class="axis" x1="${pad.l}" y1="${pad.t + ih}" x2="${pad.l + iw}" y2="${pad.t + ih}"/>
  ${ylab}${xlab}${rules}${paths}${legend}
  <text class="axlab" x="${pad.l + iw / 2}" y="${height - 6}" text-anchor="middle">${esc(xLabel)}</text>
  <text class="axlab" transform="rotate(-90 14 ${pad.t + ih / 2})" x="14" y="${pad.t + ih / 2}" text-anchor="middle">${esc(yLabel)}</text>
</svg>${caption ? `<figcaption>${caption}</figcaption>` : ''}</figure>`;
}

function groupedBars({ groups, seriesNames, colors, width = 940, height = 300, yLabel = '', caption = '' }) {
  const pad = { l: 62, r: 18, t: 26, b: 52 };
  const iw = width - pad.l - pad.r;
  const ih = height - pad.t - pad.b;
  const maxV = Math.max(...groups.flatMap((g) => g.values)) * 1.15 || 1;
  const gw = iw / groups.length;
  const bw = Math.min(30, (gw * 0.68) / seriesNames.length);
  const PY = (v) => pad.t + ih - (v / maxV) * ih;

  const yt = axisTicks(0, maxV, 4);
  const grid = yt.map((v) => `<line class="grid" x1="${pad.l}" y1="${PY(v).toFixed(1)}" x2="${pad.l + iw}" y2="${PY(v).toFixed(1)}"/>`).join('');
  const ylab = yt.map((v) => `<text class="tick" x="${pad.l - 10}" y="${(PY(v) + 4).toFixed(1)}" text-anchor="end">${n2(v)}</text>`).join('');

  const bars = groups.map((g, gi) => {
    const cx = pad.l + gw * gi + gw / 2;
    const start = cx - (bw * seriesNames.length) / 2;
    const rects = g.values.map((v, si) => {
      const h = Math.max(1, pad.t + ih - PY(v));
      return `<rect x="${(start + si * bw + 1.5).toFixed(1)}" y="${PY(v).toFixed(1)}" width="${(bw - 3).toFixed(1)}" height="${h.toFixed(1)}" rx="2" style="fill:${colors[si]}"/>`;
    }).join('');
    return `${rects}<text class="tick" x="${cx.toFixed(1)}" y="${pad.t + ih + 20}" text-anchor="middle">${esc(g.label)}</text>
      <text class="ticksub" x="${cx.toFixed(1)}" y="${pad.t + ih + 34}" text-anchor="middle">${esc(g.sub || '')}</text>`;
  }).join('');

  const legend = seriesNames.map((nm, i) => `
    <g transform="translate(${pad.l + i * 170},${pad.t - 10})">
      <rect width="11" height="11" y="-9" rx="2" style="fill:${colors[i]}"/>
      <text class="legend" x="17" y="0">${esc(nm)}</text>
    </g>`).join('');

  return `<figure class="chart">
<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(caption || yLabel)}">
  <g>${grid}</g>
  <line class="axis" x1="${pad.l}" y1="${pad.t}" x2="${pad.l}" y2="${pad.t + ih}"/>
  <line class="axis" x1="${pad.l}" y1="${pad.t + ih}" x2="${pad.l + iw}" y2="${pad.t + ih}"/>
  ${ylab}${bars}${legend}
  <text class="axlab" transform="rotate(-90 14 ${pad.t + ih / 2})" x="14" y="${pad.t + ih / 2}" text-anchor="middle">${esc(yLabel)}</text>
</svg>${caption ? `<figcaption>${caption}</figcaption>` : ''}</figure>`;
}

// ====================================================== domain visualisations

/** Viridis, so the map reads the same in either theme. */
function viridis(t) {
  const stops = [[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]];
  const u = Math.max(0, Math.min(1, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(u));
  const f = u - i;
  const c = stops[i].map((v, j) => Math.round(v + (stops[i + 1][j] - v) * f));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

/**
 * Where the strategy actually lives.
 *
 * Every sane heuristic puts a perfect fit (gap 0) first, so plotting the
 * argmax tells you nothing. What separates Best Fit from an evolved rule is the
 * ORDER of everything below first place. This maps, for each item size, how the
 * rule ranks each achievable gap -- Best Fit's map is a clean gradient because
 * it is monotone in the gap; anything else is a discovered strategy.
 */
function preferenceMap(fn, cols = 47, rows = 30, maxGap = 0.6) {
  const grid = [];
  for (let c = 0; c < cols; c++) {
    const i = (c + 1) / (cols + 1);
    const feasible = [];
    for (let rI = 0; rI < rows; rI++) {
      const gv = (rI / (rows - 1)) * maxGap;
      if (gv > 1 - i + 1e-9) { feasible.push(null); continue; }
      feasible.push({ rI, v: fn(i, i + gv, gv, 0.5) });
    }
    const live = feasible.filter(Boolean).sort((a, b) => a.v - b.v);
    const col = new Array(rows).fill(null);
    live.forEach((e, idx) => { col[e.rI] = live.length > 1 ? idx / (live.length - 1) : 1; });
    grid.push(col);
  }
  return grid;
}

function heatmapPanels(expr) {
  const panels = [
    { title: '当前冠军', fn: X.compile(expr) },
    { title: 'Best Fit（单调，无结构）', fn: (i, r, g) => -g },
  ];
  // Integer cell geometry and colour-grouped paths: one <path> per colour band
  // instead of one <rect> per cell, which is the difference between a 220 KB
  // page and a 40 KB one.
  const cols = 36; const rows = 22; const maxGap = 0.6; const LEVELS = 12;
  const cw = 11; const chh = 10;
  const pw = cols * cw; const ph = rows * chh;
  const top = 34; const left = 58; const gapX = 62;

  const body = panels.map((p, pi) => {
    const ox = left + pi * (pw + gapX);
    const grid = preferenceMap(p.fn, cols, rows, maxGap);
    const buckets = Array.from({ length: LEVELS }, () => []);
    grid.forEach((col, c) => col.forEach((v, r) => {
      if (v === null) return;
      const lvl = Math.min(LEVELS - 1, Math.floor(v * LEVELS));
      buckets[lvl].push(`M${ox + c * cw} ${top + ph - (r + 1) * chh}h${cw}v${chh}h-${cw}z`);
    }));
    const paths = buckets.map((d, lvl) => (d.length
      ? `<path fill="${viridis(lvl / (LEVELS - 1))}" d="${d.join('')}"/>` : '')).join('');
    const yl = [0, 0.2, 0.4, 0.6].map((gv) => {
      const y = top + ph - (gv / maxGap) * ph;
      return `<text class="tick" x="${ox - 8}" y="${(y + 4).toFixed(0)}" text-anchor="end">${gv.toFixed(1)}</text>`;
    }).join('');
    const xl = [0.2, 0.5, 0.8].map((iv) => `<text class="tick" x="${(ox + iv * pw).toFixed(0)}" y="${top + ph + 17}" text-anchor="middle">${iv.toFixed(1)}</text>`).join('');
    return `<text class="ltitle" x="${ox}" y="${top - 12}">${esc(p.title)}</text>
      ${paths}<rect x="${ox}" y="${top}" width="${pw}" height="${ph}" fill="none" class="axis"/>
      ${pi === 0 ? yl : ''}${xl}
      <text class="axlab" x="${(ox + pw / 2).toFixed(0)}" y="${top + ph + 34}" text-anchor="middle">物品尺寸 i</text>`;
  }).join('');

  const ramp = Array.from({ length: LEVELS }, (_, i) => `<rect x="${left + i * 18}" y="${top + ph + 52}" width="18" height="9" fill="${viridis(i / (LEVELS - 1))}"/>`).join('');

  return `<figure class="chart">
<svg viewBox="0 0 940 ${top + ph + 86}" role="img" aria-label="缝隙偏好排序热力图">
  ${body}
  <text class="axlab" transform="rotate(-90 16 ${top + ph / 2})" x="16" y="${top + ph / 2}" text-anchor="middle">放入后的缝隙 g</text>
  ${ramp}
  <text class="tick" x="${left}" y="${top + ph + 76}">最不想要</text>
  <text class="tick" x="${left + LEVELS * 18}" y="${top + ph + 76}" text-anchor="end">最想要</text>
</svg>
<figcaption>每一列是一个物品尺寸，纵轴是放进去之后剩下的缝隙，颜色是这条规则对该缝隙的偏好排名（亮=更想要）。<strong>右边 Best Fit 是一片干净的渐变</strong>，因为它只认"缝隙越小越好"。左边一旦出现横向暗带，就说明进化找到了一类它<strong>宁可不要</strong>的缝隙 —— 通常是小到再也塞不进任何东西、纯属浪费的死区。这张图就是当前策略的全部内容，冠军一换就会重画。</figcaption></figure>`;
}

function packingDiagram() {
  // A small, honest picture of the decision the heuristic faces each step.
  const bins = [
    { fill: 0.82, label: 'r=0.18' },
    { fill: 0.55, label: 'r=0.45' },
    { fill: 0.91, label: 'r=0.09' },
    { fill: 0.30, label: 'r=0.70' },
  ];
  const bw = 78; const bh = 150; const gap = 30; const x0 = 250; const y0 = 56;
  const boxes = bins.map((b, i) => {
    const x = x0 + i * (bw + gap);
    const fh = bh * b.fill;
    const fits = b.fill + 0.24 <= 1;
    return `<g>
      <rect class="bin" x="${x}" y="${y0}" width="${bw}" height="${bh}" rx="4"/>
      <rect class="binfill" x="${x + 3}" y="${y0 + bh - fh + 3 - 3}" width="${bw - 6}" height="${Math.max(0, fh - 3)}" rx="3"/>
      <text class="diaglab" x="${x + bw / 2}" y="${y0 + bh + 18}" text-anchor="middle">${esc(b.label)}</text>
      <text class="diagtag ${fits ? 'ok' : 'no'}" x="${x + bw / 2}" y="${y0 + bh + 34}" text-anchor="middle">${fits ? '装得下' : '装不下'}</text>
    </g>`;
  }).join('');

  return `<figure class="chart">
<svg viewBox="0 0 940 268" role="img" aria-label="在线装箱的每步决策">
  <rect class="item" x="62" y="${y0 + 60}" width="110" height="36" rx="4"/>
  <text class="diaglab" x="117" y="${y0 + 83}" text-anchor="middle">新物品 i=0.24</text>
  <text class="diagnote" x="117" y="${y0 + 128}" text-anchor="middle">必须立刻放好</text>
  <text class="diagnote" x="117" y="${y0 + 146}" text-anchor="middle">不能等，不能反悔</text>
  <path class="arrow" d="M182 ${y0 + 78} L236 ${y0 + 78}" marker-end="url(#ah)"/>
  <defs><marker id="ah" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
    <path d="M0,0 L8,4 L0,8 z" class="arrowhead"/></marker></defs>
  ${boxes}
  <text class="diagnote" x="470" y="26" text-anchor="middle">在所有装得下的箱子里，评分函数 score(i, r, g, k) 最高的那个获胜；全都装不下就开新箱</text>
</svg>
<figcaption>在线装箱：物品逐个到达，必须立即决定去向，没有回溯。进化出来的东西就是上面那个 score。</figcaption></figure>`;
}

function stackDiagram(genome) {
  const rows = [
    { n: 'L0', t: '目标层 · 启发式', d: `score(i, r, g, k) 决定每件物品进哪个箱子`, m: `当前 ${genome.champion.size} 个节点`, c: 'var(--acc)' },
    { n: 'L1', t: '搜索层 · 变异算子', d: '八个算子改写 L0 的表达式树，MAP-Elites 维持多样性', m: `${genome.search.operators.length} 个算子在册`, c: 'var(--acc2)' },
    { n: 'L2', t: '元层 · 信用分配', d: '按实测命中率重新分配算子权重、退火步长与算力预算', m: `σ=${genome.search.sigma}，预算 ${int(genome.search.budget.evaluations)}`, c: 'var(--acc3)' },
    { n: 'L3', t: '叙述层 · 本页', d: '基因组确定性地编译成这张网页，包括你正在读的这段', m: `第 ${genome.generation} 代`, c: 'var(--acc4)' },
  ];
  const H = 78;
  const body = rows.map((r, i) => {
    const y = 18 + i * H;
    return `<g>
      <rect class="layer" x="16" y="${y}" width="908" height="${H - 12}" rx="6" style="stroke:${r.c}"/>
      <text class="lidx" style="fill:${r.c}" x="36" y="${y + 40}">${r.n}</text>
      <text class="ltitle" x="92" y="${y + 28}">${esc(r.t)}</text>
      <text class="ldesc" x="92" y="${y + 50}">${esc(r.d)}</text>
      <text class="lmeta" style="fill:${r.c}" x="908" y="${y + 40}" text-anchor="end">${esc(r.m)}</text>
      ${i < rows.length - 1 ? `<path class="arrow" d="M470 ${y + H - 12} L470 ${y + H + 4}" marker-end="url(#ah2)"/>` : ''}
    </g>`;
  }).join('');
  return `<figure class="chart">
<svg viewBox="0 0 940 ${18 + rows.length * H + 6}" role="img" aria-label="四层递归结构">
  <defs><marker id="ah2" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
    <path d="M0,0 L8,4 L0,8 z" class="arrowhead"/></marker></defs>
  ${body}
</svg>
<figcaption>每一层都在改上一层。L3 改的是你眼前这页的内容，所以这张图本身也是 L3 的产物。</figcaption></figure>`;
}

// ================================================================== the page

export function renderSite(genome, history) {
  const g = genome;
  const ch = g.champion;
  const bf = g.baselines.bestFit;
  const ff = g.baselines.firstFit;
  const bfd = g.baselines.bestFitDecreasing;
  const gainTrain = bf.train.excess - ch.train.excess;
  const gainVal = bf.val.excess - ch.val.excess;
  const gainTest = bf.test.excess - ch.test.excess;
  const simplified = X.simplify(ch.expr);
  const used = X.usedVars(ch.expr);
  const accepted = history.filter((h) => h.accepted).length;
  const has = (n) => g.generation >= n;

  // ---- charts
  const curve = history.length >= 2 ? lineChart({
    series: [
      { name: '训练折 · 用于选择', color: 'var(--acc)', points: history.map((h) => ({ x: h.gen, y: h.trainAfter })) },
      { name: '验证折 · 用于否决', color: 'var(--acc3)', points: history.map((h) => ({ x: h.gen, y: h.valAfter ?? h.testAfter })) },
      { name: '留出集 · 什么都不决定', color: 'var(--acc2)', points: history.map((h) => ({ x: h.gen, y: h.testAfter })), dashed: true },
    ],
    hlines: [
      { y: bf.train.excess, label: `Best Fit ${n3(bf.train.excess)}%`, color: 'var(--dim)' },
      { y: bfd.train.excess, label: `离线 BFD ${n3(bfd.train.excess)}%`, color: 'var(--warn)' },
    ],
    xLabel: '世代', yLabel: '超额率（% over 下界）', integerX: true,
    yFmt: (v) => `${n2(v)}%`,
    caption: '绿线（训练折）负责选择，紫线（验证折）负责否决，蓝虚线（留出集）什么都不负责 —— 它只是被记录下来。绿线和蓝线分开跑的幅度，就是这套搜索在多大程度上只是在背题。',
  }) : '';

  const gapChart = has(6) && history.length >= 3 ? lineChart({
    series: [{
      name: '泛化间隙（留出 − 训练）', color: 'var(--acc3)',
      points: history.map((h) => ({ x: h.gen, y: Math.round((h.testAfter - h.trainAfter) * 1e4) / 1e4 })),
    }],
    hlines: [{ y: bf.test.excess - bf.train.excess, label: '第 0 代的间隙', color: 'var(--dim)' }],
    xLabel: '世代', yLabel: '百分点', integerX: true, yFmt: (v) => n2(v),
    caption: '间隙持续变大，说明搜索在啃训练实例的特异结构；持平则说明学到的是分布本身。',
  }) : '';

  const prefChart = heatmapPanels(ch.expr);

  const famChart = has(3) ? groupedBars({
    groups: FAMILIES.map((f) => ({
      label: f.zh, sub: f.label,
      values: [ch.train.perFamily[f.id] ?? 0, bf.train.perFamily[f.id] ?? 0, bfd.train.perFamily[f.id] ?? 0],
    })),
    seriesNames: ['当前冠军', 'Best Fit', '离线 BFD（参考）'],
    colors: ['var(--acc)', 'var(--dim)', 'var(--warn)'],
    yLabel: '训练集超额率 %',
    caption: '一个平均值会骗人。四种分布分开看，才知道改进是全面的还是只在某一类实例上。',
  }) : '';

  const ops = [...g.search.operators].sort((a, b) => b.weight - a.weight);
  const opChart = has(4) ? `<figure class="chart"><div class="opbars">${ops.map((o) => {
    const rate = o.attempts > 0 ? o.hits / o.attempts : 0;
    const w = Math.max(1.5, o.weight * 100);
    return `<div class="opbar">
      <div class="opname">${esc(operatorLabel(o))}${o.kind === 'composite' ? '<span class="minted">合成</span>' : ''}</div>
      <div class="optrack"><div class="opfill" style="width:${w.toFixed(1)}%"></div></div>
      <div class="opnum mono">${(o.weight * 100).toFixed(1)}%</div>
      <div class="opnum mono dim">命中 ${(rate * 100).toFixed(2)}%</div>
    </div>`;
  }).join('')}</div>
  <figcaption>权重不是我设的常数，是每晚按实测命中率重估的。最低 3% 的地板保证没有算子会被永久饿死 —— 昨天没用的思路，明天分布变了可能就有用。</figcaption></figure>` : '';

  // ---- tables
  const scoreboard = `
<table class="tbl">
  <thead><tr>
    <th>算法</th><th class="num">训练折</th><th class="num">验证折</th><th class="num">留出集</th>
    <th class="num">留出集 − Best Fit</th><th>说明</th>
  </tr></thead>
  <tbody>
    <tr class="champrow">
      <td><strong>当前冠军</strong> <span class="pill">第 ${g.champion.bornGen} 代</span></td>
      <td class="num mono strong">${n3(ch.train.excess)}%</td>
      <td class="num mono">${n3(ch.val.excess)}%</td>
      <td class="num mono strong">${n3(ch.test.excess)}%</td>
      <td class="num mono ${gainTest > 0 ? 'good' : 'bad'}">${diff(-gainTest)} pp</td>
      <td>进化产物，${ch.size} 个节点，读取 ${[...used].join(' ') || '无变量'}</td>
    </tr>
    ${BASELINES.map((b) => {
    const v = g.baselines[b.id];
    const d = v.test.excess - bf.test.excess;
    return `<tr class="${b.kind === 'offline' ? 'offline' : ''}">
        <td>${esc(b.zh)} <span class="mono dim">${esc(b.label)}</span>${b.kind === 'offline' ? '<span class="pill warn">离线</span>' : ''}</td>
        <td class="num mono">${n3(v.train.excess)}%</td>
        <td class="num mono">${n3(v.val.excess)}%</td>
        <td class="num mono">${n3(v.test.excess)}%</td>
        <td class="num mono ${b.id === 'bestFit' ? 'dim' : d < 0 ? 'good' : 'bad'}">${b.id === 'bestFit' ? '—' : diff(d) + ' pp'}</td>
        <td>${esc(b.note)}</td>
      </tr>`;
  }).join('')}
  </tbody>
</table>`;

  const suites = getSuites();
  const foldTable = `
<table class="tbl">
  <thead><tr><th>折</th><th class="num">实例数</th><th>它有什么权力</th><th class="num">冠军得分</th><th class="num">Best Fit</th></tr></thead>
  <tbody>
    <tr><td><strong>训练折</strong> <span class="mono dim">train</span></td><td class="num mono">${suites.train.length}</td>
      <td class="small">驱动搜索。每晚上万个候选都在这里打分，冠军必须在这里严格更优（余量 ${g.search.acceptMargin ?? 0.004} pp）才有资格往下走。</td>
      <td class="num mono strong">${n3(ch.train.excess)}%</td><td class="num mono dim">${n3(bf.train.excess)}%</td></tr>
    <tr><td><strong>验证折</strong> <span class="mono dim">val</span></td><td class="num mono">${suites.val.length}</td>
      <td class="small">只有否决权，没有提名权。在训练折上赢了的候选，在这里<strong>一个箱子都不许多用</strong>，否则当场出局。</td>
      <td class="num mono strong">${n3(ch.val.excess)}%</td><td class="num mono dim">${n3(bf.val.excess)}%</td></tr>
    <tr><td><strong>留出集</strong> <span class="mono dim">test</span></td><td class="num mono">${suites.test.length}</td>
      <td class="small">什么权力都没有。不参与选择，不参与否决，只是被记录。故意做成三折里最大的一折。</td>
      <td class="num mono strong">${n3(ch.test.excess)}%</td><td class="num mono dim">${n3(bf.test.excess)}%</td></tr>
  </tbody>
</table>`;

  const familyTable = `
<table class="tbl">
  <thead><tr><th>分布</th><th>生成方式</th><th class="num">箱容</th><th class="num">冠军（训练折）</th><th class="num">Best Fit</th><th class="num">差值</th></tr></thead>
  <tbody>${FAMILIES.map((f) => {
    const a = ch.train.perFamily[f.id] ?? 0;
    const b = bf.train.perFamily[f.id] ?? 0;
    return `<tr>
      <td><strong>${esc(f.zh)}</strong> <span class="mono dim">${esc(f.label)}</span></td>
      <td class="small">${esc(f.note)}</td>
      <td class="num mono">${f.capacity}</td>
      <td class="num mono">${n3(a)}%</td>
      <td class="num mono dim">${n3(b)}%</td>
      <td class="num mono ${b - a > 0.0005 ? 'good' : b - a < -0.0005 ? 'bad' : 'dim'}">${diff(a - b)}</td>
    </tr>`;
  }).join('')}</tbody>
</table>`;

  const eliteTable = has(3) ? `
<table class="tbl">
  <thead><tr><th class="num">节点数档位</th><th class="num">训练集</th><th class="num">留出集</th><th class="num">出生代</th><th>表达式</th></tr></thead>
  <tbody>${g.elites.map((e) => {
    if (!e.expr) return `<tr class="empty"><td class="num mono">${e.id}</td><td colspan="4" class="dim small">尚未有个体落进这个档位</td></tr>`;
    const isChamp = X.key(e.expr) === X.key(ch.expr);
    return `<tr class="${isChamp ? 'champrow' : ''}">
      <td class="num mono">${e.id}${isChamp ? ' <span class="pill">冠军</span>' : ''}</td>
      <td class="num mono">${n3(e.train)}%</td>
      <td class="num mono dim">${e.test !== undefined ? `${n3(e.test)}%` : '—'}</td>
      <td class="num mono dim">${e.bornGen ?? 0}</td>
      <td class="expr mono">${esc(X.pretty(X.simplify(e.expr)))}</td>
    </tr>`;
  }).join('')}</tbody>
</table>` : '';

  const opTable = has(4) ? `
<table class="tbl">
  <thead><tr><th>算子</th><th class="num">累计尝试</th><th class="num">命中</th><th class="num">命中率</th><th class="num">权重</th><th>它在做什么</th></tr></thead>
  <tbody>${ops.map((o) => `<tr>
    <td><strong>${esc(operatorLabel(o))}</strong>${o.kind === 'composite' ? ' <span class="pill acc">第 ' + o.born + ' 代合成</span>' : ''}</td>
    <td class="num mono">${int(o.attempts)}</td>
    <td class="num mono">${int(o.hits)}</td>
    <td class="num mono">${o.attempts ? (100 * o.hits / o.attempts).toFixed(2) : '0.00'}%</td>
    <td class="num mono strong">${(o.weight * 100).toFixed(1)}%</td>
    <td class="small">${esc(describeOperator(o))}</td>
  </tr>`).join('')}</tbody>
</table>` : '';

  const lineageRows = [...history].reverse().slice(0, 30);
  const lineageTable = history.length ? `
<div class="scroll"><table class="tbl compact">
  <thead><tr>
    <th class="num">代</th><th>日期</th><th class="num">评估</th><th>结果</th>
    <th class="num">训练折</th><th class="num">验证折</th><th class="num">留出集</th>
    <th class="num">被否决</th><th class="num">节点</th>
    <th>产出算子</th><th class="num">σ</th><th class="num">耗时</th><th class="num">种子</th>
  </tr></thead>
  <tbody>${lineageRows.map((h) => `<tr class="${h.accepted ? 'acc' : 'hold'}">
    <td class="num mono">${h.gen}</td>
    <td class="mono small">${esc(h.date)}${h.label && h.label !== 'daily' ? ` <span class="pill">${esc(h.label)}</span>` : ''}</td>
    <td class="num mono">${int(h.evaluations)}</td>
    <td>${h.accepted ? '<span class="tag ok">接受</span>' : '<span class="tag no">维持</span>'}</td>
    <td class="num mono">${n3(h.trainAfter)}%</td>
    <td class="num mono dim">${h.valAfter !== undefined ? `${n3(h.valAfter)}%` : '—'}</td>
    <td class="num mono dim">${n3(h.testAfter)}%</td>
    <td class="num mono ${h.vetoed ? 'warnnum' : 'dim'}">${h.vetoed ?? 0}</td>
    <td class="num mono dim">${h.size}</td>
    <td class="small">${h.opLabel ? esc(h.opLabel) : '<span class="dim">—</span>'}</td>
    <td class="num mono dim">${h.sigma}</td>
    <td class="num mono dim">${(h.elapsedMs / 1000).toFixed(1)}s</td>
    <td class="num mono dim">${h.seed}</td>
  </tr>`).join('')}</tbody>
</table></div>` : '<p class="dim">还没有世代记录。</p>';

  const ladder = [
    { lvl: 'L0', what: '启发式表达式', who: '引擎', open: true,
      why: '受频次最高、后果最小。改错了只是装箱差一点，而且有验收测试挡着。' },
    { lvl: 'L1', what: '算子权重 / 退火步长 / 算力预算', who: '引擎', open: true,
      why: '改的是搜索怎么花钱，不是什么算赢。改坏了下一晚会自己纠回来。' },
    { lvl: 'L1+', what: '合成新的组合算子', who: '引擎', open: true,
      why: '只能由已有算子按顺序拼接，搜索空间真的变大了，但新算子的每个零件都已经审过。最多 4 个。' },
    { lvl: 'L2', what: '验收标准（三折划分、接受阈值、下界计算）', who: '人', open: false,
      why: '让被评的一方去改评分规则，是这类系统最短的一条作弊路径。实例集有指纹，动了就拒绝继续进化。' },
    { lvl: 'L3', what: '引擎自身的源代码', who: '人（走 PR）', open: false,
      why: '不是做不到，是做了就没有一个不被它改写的地方能站着说话。这条线的位置是设计决定，不是能力上限。' },
  ];

  const ladderTable = `
<table class="tbl">
  <thead><tr><th class="num">层级</th><th>可改写的东西</th><th>谁能改</th><th>状态</th><th>为什么划在这里</th></tr></thead>
  <tbody>${ladder.map((l) => `<tr>
    <td class="num mono">${l.lvl}</td>
    <td><strong>${esc(l.what)}</strong></td>
    <td class="mono small">${esc(l.who)}</td>
    <td>${l.open ? '<span class="tag ok">开放</span>' : '<span class="tag no">关闭</span>'}</td>
    <td class="small">${esc(l.why)}</td>
  </tr>`).join('')}</tbody>
</table>`;

  const varTable = `
<table class="tbl">
  <thead><tr><th class="num">符号</th><th>名称</th><th>含义</th><th>冠军是否用到</th></tr></thead>
  <tbody>${Object.entries(X.VARS).map(([k, v]) => `<tr>
    <td class="num mono strong">${k}</td><td>${esc(v.zh)} <span class="dim mono small">${esc(v.en)}</span></td>
    <td class="small">${esc(v.desc)}</td>
    <td>${used.has(k) ? '<span class="tag ok">用到</span>' : '<span class="tag no">未用</span>'}</td>
  </tr>`).join('')}</tbody>
</table>`;

  const logHtml = g.log.length ? g.log.map((l) => `
  <article class="logentry ${l.accepted ? 'acc' : 'hold'}">
    <header><span class="mono gen">第 ${l.gen} 代</span><span class="mono date">${esc(l.date)}</span>
      <span class="logtitle">${esc(l.title)}</span></header>
    ${l.body.map((p) => `<p>${esc(p)}</p>`).join('')}
  </article>`).join('') : '<p class="dim">还没有日志。第一次 cron 运行后这里会出现内容。</p>';

  const milestoneHtml = g.milestones.length ? `<ol class="miles">${[...g.milestones].reverse().map((m) => `
    <li><span class="mono gen">第 ${m.gen} 代</span><strong>${esc(m.title)}</strong><span>${esc(m.body)}</span></li>`).join('')}</ol>`
    : '<p class="dim">还没有里程碑。</p>';

  const { train } = getSuites();
  const totalItems = train.length * ITEMS_PER_INSTANCE * 2;

  const heroStats = [
    { k: '留出集超额率', v: `${n3(ch.test.excess)}%`, s: `训练折 ${n3(ch.train.excess)}%，越低越好` },
    { k: gainTest >= 0 ? '留出集比 Best Fit 低' : '留出集比 Best Fit 高', v: `${mag(gainTest)} pp`, s: `训练折低 ${mag(gainTrain)} pp`, good: gainTest > 0 },
    { k: '累计评估候选', v: int(g.stats.totalEvaluations), s: `接受 ${accepted} 次` },
    { k: '表达式规模', v: `${ch.size} 节点`, s: `深度 ${ch.depth}` },
  ];

  const css = STYLE;
  const title = `第 ${g.generation} 代 · OUROBOROS`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="一个每天重写自己的网站。在线装箱问题上的递归自我改进，第 ${g.generation} 代，训练集超额率 ${n3(ch.train.excess)}%。">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='11' fill='none' stroke='%237cf5a8' stroke-width='3.5' stroke-dasharray='58 12'/%3E%3C/svg%3E">
<style>${css}</style>
</head>
<body>
<div class="wrap">

<header class="top">
  <div class="brand">
    <div class="ring" aria-hidden="true"></div>
    <div>
      <h1>OUROBOROS</h1>
      <p class="tag">一个每天重写自己的网站</p>
    </div>
  </div>
  <div class="genbox">
    <div class="genno mono">GEN ${g.generation}</div>
    <div class="gendate mono">${esc(g.lastRun.date)}</div>
    <div class="genstate">${g.lastRun.accepted ? '<span class="tag ok">昨夜有改进</span>' : '<span class="tag no">昨夜维持原样</span>'}</div>
  </div>
</header>

<section class="hero">
  <p class="lede">这一页不是我写完就定稿的。它每天凌晨自己重跑一遍搜索，如果找到更好的东西，就改写自己，提交到 Git，重新发布。你现在读到的数字、表格、图，还有下面那段实验日志，都是第 ${g.generation} 代的产物。</p>
  <div class="stats">${heroStats.map((s) => `
    <div class="stat"><div class="sk">${esc(s.k)}</div><div class="sv mono ${s.good ? 'good' : ''}">${esc(s.v)}</div><div class="ss">${esc(s.s)}</div></div>`).join('')}
  </div>
</section>

<nav class="toc"><span>目录</span>
  <a href="#what">是什么</a><a href="#problem">目标问题</a><a href="#champion">当前冠军</a>
  <a href="#score">成绩单</a><a href="#eco">进化曲线</a>${has(3) ? '<a href="#elites">精英档案</a>' : ''}
  ${has(4) ? '<a href="#search">搜索层</a>' : ''}<a href="#lineage">世代谱系</a><a href="#log">实验日志</a>
  <a href="#guard">护栏</a><a href="#repro">复现</a>
</nav>

<section id="what">
  <h2><span class="idx mono">01</span>它到底在做什么</h2>
  <p>「递归自我改进」这个词常常被用得很虚。要让它变成可以检验的东西，需要三样：一个<strong>能被客观打分的任务</strong>，一个<strong>不由被评者掌握的验收环节</strong>，以及一份<strong>没人能偷偷改的历史记录</strong>。这个项目把这三样都摆在明面上。</p>
  <p>任务是<strong>在线装箱</strong>。系统要进化的，是一个决定"这件物品该放进哪个箱子"的评分函数。评分函数越好，用掉的箱子越少，超出理论下界的比例越低。这个比例是一个数，没有解释余地。</p>
  ${stackDiagram(g)}
  <p>四层里，每一层改的都是上一层。L3 改的是这张网页 —— 也就是说，你现在读的这段话所在的文件，是被下面那台机器生成出来的。这不是修辞。</p>
</section>

<section id="problem">
  <h2><span class="idx mono">02</span>目标问题：在线装箱</h2>
  <p>给定一串物品和容量固定的箱子，把所有物品装进尽量少的箱子。<strong>在线</strong>的意思是：物品一件一件到达，每件必须在看到下一件之前放好，而且放了不能再动。这让它比离线版本难得多 —— 离线算法可以先把所有物品排序再装，在线算法连下一件是大是小都不知道。</p>
  ${packingDiagram()}
  <p>评价指标是<strong>超额率</strong>：实际用掉的箱子数，比"所有物品体积之和 ÷ 箱容"这个下界多出的百分比。下界通常达不到，所以这个数永远为正，越接近 0 越好。</p>
  <h3>基准实例集：三折划分</h3>
  <p>四种物品尺寸分布，每个实例 ${ITEMS_PER_INSTANCE} 件物品，全部由固定随机种子确定性生成，没有外部数据文件。${totalItems.toLocaleString('en-US')} 件物品被切成三份，<strong>哪个实例落在哪一折，是这个项目里最重要的一个设计决定</strong>：</p>
  ${foldTable}
  <p class="note"><strong>为什么非要分三折。</strong>只有训练折的话，搜索会稳定地学会训练实例的指纹 —— 它会发现"第 3 个实例的第 417 件物品之后总是来一件小的"这种东西，然后在别处一败涂地。验证折是一道否决权：一个候选在训练折上省下的箱子，如果在验证折上又赔了回去，它当场出局，连成为冠军的资格都没有。留出集则从头到尾不参与任何决定 —— 它存在的唯一理由，是让这一页能报出一个<strong>系统无权优化的数字</strong>。</p>
  <p>整套实例集的指纹是 <code class="mono">${esc(g.suiteFingerprint)}</code>。引擎每次启动都会重算这个指纹，一旦对不上就拒绝继续进化 —— 换了考题的成绩单没有意义。</p>
  ${familyTable}
</section>

<section id="champion">
  <h2><span class="idx mono">03</span>当前冠军</h2>
  <p>装箱器在所有装得下的箱子里，选评分最高的那个。这个评分函数是第 ${ch.bornGen} 代由「${esc(labelFor(g, ch.bornOp))}」产出的：</p>
  <div class="formula mono">score = ${esc(X.pretty(simplified))}</div>
  <details class="raw"><summary>原始表达式树（未化简）与 JSON 基因型</summary>
    <div class="formula mono small">${esc(X.pretty(ch.expr))}</div>
    <pre class="mono"><code>${esc(JSON.stringify(ch.expr))}</code></pre>
    <p class="small dim">这就是全部的基因型。整个个体 ${ch.size} 个节点、深度 ${ch.depth}，可以完整塞进一行 git diff。这是刻意的：一个看不懂的进化产物没法讨论。</p>
  </details>
  <h3>它能感知的四个量</h3>
  ${varTable}
  <h3>它到底学到了什么策略</h3>
  <p>光看"它最想要多大的缝隙"是看不出名堂的 —— 任何像样的规则都会把恰好装满排在第一。真正的差别藏在<strong>第一名之后的排序</strong>里。</p>
  ${prefChart}
</section>

<section id="score">
  <h2><span class="idx mono">04</span>成绩单</h2>
  <p>所有在线算法跑的是同一套实例、同一个装箱器，唯一的差别就是那个评分函数。Best Fit 是本项目的第 0 代，也就是进化的起点。最右一列是留出集上的<strong>超额率之差</strong>，负数表示比 Best Fit 用掉更少的箱子。留出集是三折里唯一没被任何决定碰过的那一折。</p>
  ${scoreboard}
  <p class="note">Best Fit Decreasing 那一行是<strong>离线</strong>算法，它可以先看到全部物品再排序。放在这里是为了给出一个"如果允许预知未来能做到多好"的参照，不是进化的目标。在线算法在这套实例上追平它是不该轻易发生的事 —— 真发生了，第一反应应该是怀疑实例集出了问题。</p>
  ${has(3) ? `<h3>按分布分解</h3>${famChart}` : ''}
</section>

<section id="eco">
  <h2><span class="idx mono">05</span>进化曲线</h2>
  ${curve || '<p class="dim">需要至少两代才能画出曲线。第一次 cron 运行后这里会出现图表。</p>'}
  ${gapChart ? `<h3>泛化间隙</h3>${gapChart}` : ''}
</section>

${has(3) ? `<section id="elites">
  <h2><span class="idx mono">06</span>精英档案</h2>
  <p>只保留一个最优个体，搜索很快会收敛到一条越长越臃肿的死路。这里用的是 MAP-Elites：按表达式的<strong>节点数</strong>分档，每档各自保留一个当前最优。小表达式和大表达式互不淘汰，变异可以从任何一档出发。</p>
  <p>这也顺带解释了为什么「化简」算子有意义 —— 它一分适应度都不涨，但个体变短之后会落进更小的档位，在那里可能就是最优。</p>
  ${eliteTable}
</section>` : ''}

${has(4) ? `<section id="search">
  <h2><span class="idx mono">07</span>搜索层与元搜索层</h2>
  <p>八个基础算子负责写出新的表达式。它们的权重不是常数：每晚按实测命中率重估一次，命中率高的下一晚分到更多试验次数。这是 L2 —— 改进搜索本身的那一层。</p>
  ${opChart}
  ${opTable}
  <h3>还在自适应的其它东西</h3>
  <table class="tbl">
    <thead><tr><th>参数</th><th class="num">当前值</th><th>调节规则</th></tr></thead>
    <tbody>
      <tr><td><strong>常数退火步长 σ</strong></td><td class="num mono strong">${g.search.sigma}</td>
        <td class="small">找到新冠军就 ×0.9（在附近精修），一晚没找到就 ×1.35（放大重来）。范围 0.05 – 2。<br>
        <span class="dim">最早的版本是拿命中率和一个固定的 2% 阈值比 —— 听起来合理，实际完全反了：精英档案一旦填满，健康的搜索命中率也远低于 0.1%，于是 σ 每晚都在收缩，搜索恰好在最该放大的时候冷下去，卡在同一个冠军上五代没人发现。现在这条规则只认一个信号：昨晚有没有产出新冠军。</span></td></tr>
      <tr><td><strong>连续无进展</strong></td><td class="num mono strong">${g.search.stagnation ?? 0} 晚</td>
        <td class="small">${(g.search.stagnation ?? 0) >= 2
          ? '已进入<strong>重加热</strong>：18% 的试验不再从冠军出发，而是完全随机重启；算子串联概率从 12% 提到 28%。卡住的搜索反复在同一片邻域里采样，随机重启是最便宜的出路。'
          : '连续两晚没有产出新冠军就进入重加热状态：随机重启 + 更高的算子串联概率。'}</td></tr>
      <tr><td><strong>每晚评估预算</strong></td><td class="num mono strong">${int(g.search.budget.evaluations)}</td>
        <td class="small">一晚没找到东西，下一晚预算 ×1.4；找到了就 ×0.9。范围 ${int(g.search.budget.min)} – ${int(g.search.budget.max)}。搜不出结果时先加算力，而不是先放宽验收标准。</td></tr>
      <tr><td><strong>合成算子</strong></td><td class="num mono strong">${g.search.composites ?? 0} / 4</td>
        <td class="small">串联两个算子的命中率若超过任何单一算子 25%，就把这对组合固化成一个有名字的新算子。搜索空间真的变大了，但新算子的每个零件都是审过的。</td></tr>
      <tr><td><strong>表达式规模上限</strong></td><td class="num mono strong">${g.search.caps.maxSize} 节点 / 深度 ${g.search.caps.maxDepth}</td>
        <td class="small">硬上限，引擎不能改。没有这条，遗传编程会稳定地长成一坨没人读得懂的东西。</td></tr>
    </tbody>
  </table>
</section>` : ''}

<section id="lineage">
  <h2><span class="idx mono">08</span>世代谱系</h2>
  <p>每一行都带着当晚的随机种子。种子由「日期 + 世代号」哈希而来，所以任何一代都可以原样重放：同样的种子、同样的实例集、同样的算子权重，必然得到同样的结果。这份记录只追加，不修改。</p>
  <p class="note small">标着 <span class="pill">genesis</span> 的几行，是项目诞生当天一口气跑完的「创世冲刺」，日期都是 ${esc(g.project.born)}，不是一天一代。照实标出来、而不是把它们摊成好几个日期，是因为这张表一旦可以修饰，它就不再是证据。冲刺之后就是每天凌晨一代。</p>
  ${lineageTable}
  <h3>里程碑</h3>
  ${milestoneHtml}
</section>

<section id="log">
  <h2><span class="idx mono">09</span>实验日志</h2>
  <p>每晚一条，由当次运行的遥测数据生成，包括失败的夜晚和泛化变差的夜晚。</p>
  ${logHtml}
</section>

<section id="guard">
  <h2><span class="idx mono">10</span>护栏：什么能自己改，什么不能</h2>
  <p>一个能改自己的系统，最有意思的问题不是"它能改多少"，而是"哪些地方<strong>故意</strong>不让它改，为什么"。下面这张表是这个项目的实际边界。</p>
  ${ladderTable}
  <h3>每晚实际执行的检查</h3>
  <ol class="checks">
    <li><strong>实例集指纹</strong>：启动时重算 ${totalItems.toLocaleString('en-US')} 件物品的哈希，与基因组里记录的 <code class="mono">${esc(g.suiteFingerprint)}</code> 比对，不符则直接退出，不进化。</li>
    <li><strong>冠军完整性</strong>：重新评测已提交的冠军，得分必须与记录一致到 1e-9。不一致会写进日志并按重算结果修正 —— 这是检测非确定性的哨兵。</li>
    <li><strong>语法白名单</strong>：任何候选，无论来自变异算子还是语言模型，都必须先通过表达式语法校验（只允许 ${Object.keys(X.ARITY).length} 个算子和 ${X.VAR_NAMES.length} 个变量）才会被编译。提议者永远碰不到编译器。</li>
    <li><strong>渲染确定性</strong>：提交前重新渲染整个页面，与即将提交的文件逐字节比对。渲染器里一旦出现时间戳或随机数，构建就会失败。</li>
    <li><strong>双重接受条件</strong>：新冠军必须在训练折上严格更优（余量 ${g.search.acceptMargin ?? 0.004} pp，平手不算赢），<em>并且</em>在验证折上一个箱子都不多用。迄今为止已有 ${int(g.stats.totalVetoed ?? 0)} 个在训练折上确实更优的候选倒在第二条上。</li>
    <li><strong>失败即回滚</strong>：以上任何一条不通过，工作流丢弃改动并以非零码退出，当天不提交、不发布。</li>
  </ol>
  <p class="note">最后一条值得单说。<strong>把验收标准交给被评的一方，是这类系统最短的一条作弊路径</strong> —— 与其让启发式变好，不如让"好"的定义变松。所以实例集、下界计算、接受阈值全部在引擎的可改写范围之外，而且有指纹保护。这不是因为现在的引擎有多危险，而是因为这条边界一旦模糊，后面所有的数字就都不再是证据。</p>
</section>

<section id="repro">
  <h2><span class="idx mono">11</span>怎么自己跑一遍</h2>
  <p>零依赖，Node 20 以上，不需要 API key。</p>
  <pre class="mono"><code>git clone ${esc(g.project.repo || 'https://github.com/&lt;you&gt;/ouroboros')}
cd ouroboros
node engine/evolve.mjs --date=2026-01-01 --generations=5
node tools/selfcheck.mjs
open index.html</code></pre>
  <h3>文件结构</h3>
  <table class="tbl">
    <thead><tr><th>文件</th><th>职责</th></tr></thead>
    <tbody>
      <tr><td class="mono">genome.json</td><td class="small">全部可进化状态：冠军表达式、精英档案、算子权重、σ、预算、里程碑、日志。这是"这个系统学到了什么"的完整快照。</td></tr>
      <tr><td class="mono">history.json</td><td class="small">只追加的世代记录。</td></tr>
      <tr><td class="mono">engine/expr.mjs</td><td class="small">表达式树的语法、校验、编译、化简、渲染。信任边界在这里。</td></tr>
      <tr><td class="mono">engine/problems.mjs</td><td class="small">冻结的基准实例集。改这个文件等于作废全部历史。</td></tr>
      <tr><td class="mono">engine/benchmark.mjs</td><td class="small">装箱器与打分。唯一有裁决权的文件。</td></tr>
      <tr><td class="mono">engine/operators.mjs</td><td class="small">八个变异算子与权重更新规则。</td></tr>
      <tr><td class="mono">engine/evolve.mjs</td><td class="small">每晚的编排：验完整性 → 搜索 → 选择 → 自适应 → 记录 → 渲染。</td></tr>
      <tr><td class="mono">engine/render.mjs</td><td class="small">基因组 → 这张网页。确定性。</td></tr>
      <tr><td class="mono">engine/proposer-llm.mjs</td><td class="small">可选。让语言模型也来提候选，走同一道验收关。没有 API key 时整个文件不参与。</td></tr>
      <tr><td class="mono">tools/selfcheck.mjs</td><td class="small">提交前的六项检查。</td></tr>
    </tbody>
  </table>
  <h3>可选：把语言模型接进提议环节</h3>
  <p>设好 <code class="mono">ANTHROPIC_API_KEY</code> 并 <code class="mono">npm i @anthropic-ai/sdk</code> 之后，加 <code class="mono">--llm</code> 参数，模型会看到当前冠军、精英档案和最近日志，提出若干候选表达式。它们和变异算子产出的候选走完全相同的一道关：语法校验 → 编译 → 同一套实例集 → 同一个阈值。模型不知道验收标准长什么样，也写不进基因组。<strong>提议可以不可信，裁决必须可信</strong> —— 这条分界是这个项目唯一想认真讲清楚的事。</p>
  ${g.stats.llmProposals ? `<p class="small">迄今为止语言模型提出 ${int(g.stats.llmProposals)} 个候选，其中 ${int(g.stats.llmAccepted)} 个通过了验收。</p>` : ''}
</section>

<footer>
  <div class="fgrid">
    <div><span class="fk">第 ${g.generation} 代</span><span class="fv mono">${esc(g.lastRun.date)}</span></div>
    <div><span class="fk">上次运行种子</span><span class="fv mono">${g.lastRun.seed}</span></div>
    <div><span class="fk">实例集指纹</span><span class="fv mono">${esc(g.suiteFingerprint)}</span></div>
    <div><span class="fk">诞生于</span><span class="fv mono">${esc(g.project.born)}</span></div>
  </div>
  <p class="small dim">这个页面由 <code class="mono">engine/render.mjs</code> 从 <code class="mono">genome.json</code> 生成，每天 UTC 20:17（北京时间次日 04:17）由 GitHub Actions 的定时任务重跑一次。没有前端框架，没有外部请求，没有统计脚本，不需要 JavaScript —— 整页就是你下载到的这一个文件，离线也能看。</p>
  <p class="small"><a href="${esc(g.project.repo)}">源码与全部提交</a> · <a href="${esc(g.project.repo)}/commits/main">逐代的 git diff</a> · <a href="${esc(g.project.repo)}/actions">每晚的运行日志</a> · <a href="${esc(g.project.repo)}/blob/main/DESIGN.md">设计说明</a></p>
</footer>

</div>
</body>
</html>
`;
}

function labelFor(genome, opId) {
  if (!opId || opId === 'seed') return '初始播种';
  if (opId === 'llm') return '语言模型提议';
  if (opId.includes('+')) {
    return opId.split('+').map((id) => BASE_OPERATORS.find((b) => b.id === id)?.zh ?? id).join('→');
  }
  const rec = genome.search.operators.find((o) => o.id === opId);
  if (rec) return operatorLabel(rec);
  return BASE_OPERATORS.find((b) => b.id === opId)?.zh ?? opId;
}

// ===================================================================== style

const STYLE = `
:root{
  --bg:#0a0c10; --panel:#11161c; --panel2:#151b23; --line:#222b36;
  --ink:#e7ebf1; --dim:#8a95a4; --faint:#5d6674;
  --acc:#7cf5a8; --acc2:#6cb6ff; --acc3:#c9a2ff; --acc4:#ffd479;
  --warn:#ffb454; --bad:#ff7b72; --good:#7cf5a8;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,sans-serif;
}
@media (prefers-color-scheme: light){
  :root:not([data-theme="dark"]){
    --bg:#fbfbfc; --panel:#ffffff; --panel2:#f4f6f8; --line:#e2e6ec;
    --ink:#121820; --dim:#5f6b7a; --faint:#8b95a3;
    --acc:#10894f; --acc2:#1f6feb; --acc3:#7c4dd6; --acc4:#a8730a;
    --warn:#a8730a; --bad:#c9372c; --good:#10894f;
  }
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);
  font-size:16px;line-height:1.75;letter-spacing:.005em;
  -webkit-font-smoothing:antialiased}
.wrap{max-width:1080px;margin:0 auto;padding:0 16px 96px}
.mono{font-family:var(--mono);font-variant-numeric:tabular-nums}
.small{font-size:13.5px;line-height:1.6}
.dim{color:var(--dim)}
.good{color:var(--good)} .bad{color:var(--bad)}
.warnnum{color:var(--warn)}
.strong{font-weight:650}
code{font-family:var(--mono);font-size:.9em;background:var(--panel2);
  padding:.12em .4em;border-radius:4px;border:1px solid var(--line)}
pre{background:var(--panel);border:1px solid var(--line);border-radius:10px;
  padding:16px 18px;overflow-x:auto;font-size:13.5px;line-height:1.7}
pre code{background:none;border:none;padding:0}
a{color:var(--acc2);text-decoration:none;border-bottom:1px solid transparent}
a:hover{border-bottom-color:currentColor}

/* header */
.top{display:flex;justify-content:space-between;align-items:flex-end;gap:24px;
  flex-wrap:wrap;padding:52px 0 28px;border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:16px}
.ring{width:44px;height:44px;border-radius:50%;flex:0 0 44px;
  border:4px solid var(--acc);
  border-right-color:transparent;transform:rotate(-20deg)}
h1{font-size:30px;margin:0;letter-spacing:.14em;font-weight:600}
.tag{margin:2px 0 0;color:var(--dim);font-size:14px}
.genbox{text-align:right}
.genno{font-size:34px;font-weight:600;letter-spacing:.06em;color:var(--acc);line-height:1.1}
.gendate{color:var(--dim);font-size:13px}
.genstate{margin-top:6px}

/* hero */
.hero{padding:34px 0 10px}
.lede{font-size:19px;line-height:1.85;margin:0 0 28px;max-width:70ch}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.sk{font-size:12.5px;color:var(--dim);letter-spacing:.04em}
.sv{font-size:26px;font-weight:600;line-height:1.3;margin:2px 0}
.ss{font-size:12.5px;color:var(--faint)}

/* toc */
.toc{display:flex;flex-wrap:wrap;gap:6px 14px;align-items:baseline;
  margin:34px 0 8px;padding:12px 0;border-top:1px solid var(--line);
  border-bottom:1px solid var(--line);font-size:13.5px}
.toc span{color:var(--faint);font-size:12px;letter-spacing:.1em;margin-right:4px}
.toc a{color:var(--dim)}
.toc a:hover{color:var(--acc)}

/* sections */
section{padding:44px 0 8px;scroll-margin-top:20px}
h2{font-size:24px;margin:0 0 18px;font-weight:600;display:flex;align-items:baseline;gap:14px}
.idx{color:var(--acc);font-size:13px;letter-spacing:.1em;opacity:.85}
h3{font-size:17px;margin:34px 0 12px;font-weight:600;color:var(--ink)}
p{margin:0 0 16px;max-width:76ch}
.note{background:var(--panel);border-left:3px solid var(--acc);border-radius:0 8px 8px 0;
  padding:14px 18px;font-size:15px;max-width:none}
.formula{background:var(--panel);border:1px solid var(--line);border-radius:10px;
  padding:18px 20px;font-size:16px;overflow-x:auto;margin:8px 0 16px;
  color:var(--acc);line-height:1.9}
.raw{margin:0 0 20px}
.raw summary{cursor:pointer;color:var(--dim);font-size:14px;padding:6px 0}
.raw summary:hover{color:var(--acc)}
.raw[open] summary{margin-bottom:10px}
.raw .formula{color:var(--dim);font-size:14px}

/* tables */
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
.tbl{width:100%;border-collapse:collapse;margin:8px 0 20px;font-size:14.5px}
.tbl th{text-align:left;font-weight:600;font-size:12.5px;letter-spacing:.05em;
  color:var(--dim);border-bottom:1px solid var(--line);padding:9px 12px;white-space:nowrap}
.tbl td{padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:top}
.tbl tbody tr:hover{background:var(--panel)}
.tbl .num{text-align:right}
.tbl th.num{text-align:right}
.tbl.compact td,.tbl.compact th{padding:7px 10px;font-size:13.5px}
.tbl .champrow{background:color-mix(in srgb,var(--acc) 9%,transparent)}
.tbl .champrow:hover{background:color-mix(in srgb,var(--acc) 14%,transparent)}
.tbl .offline{opacity:.7}
.tbl .empty td{color:var(--faint)}
.tbl tr.acc td:first-child{box-shadow:inset 2px 0 0 var(--acc)}
.expr{font-size:13px;color:var(--dim);max-width:380px;word-break:break-word}

.pill{display:inline-block;font-size:11px;letter-spacing:.04em;padding:1px 7px;
  border-radius:99px;border:1px solid var(--line);color:var(--dim);
  background:var(--panel2);vertical-align:middle;margin-left:4px}
.pill.warn{color:var(--warn);border-color:color-mix(in srgb,var(--warn) 40%,transparent)}
.pill.acc{color:var(--acc);border-color:color-mix(in srgb,var(--acc) 40%,transparent)}
.tag{display:inline-block;font-size:11.5px;padding:1px 8px;border-radius:5px;letter-spacing:.03em}
.tag.ok{color:var(--acc);background:color-mix(in srgb,var(--acc) 14%,transparent)}
.tag.no{color:var(--dim);background:var(--panel2)}

/* charts */
.chart{margin:14px 0 24px;padding:0}
.chart svg{width:100%;height:auto;display:block;background:var(--panel);
  border:1px solid var(--line);border-radius:10px}
figcaption{font-size:13px;color:var(--dim);margin-top:9px;line-height:1.6;max-width:76ch}
.grid{stroke:var(--line);stroke-width:1}
.axis{stroke:var(--line);stroke-width:1.2}
.series{fill:none;stroke-width:2.2;stroke-linejoin:round;stroke-linecap:round}
.rule{stroke-width:1.2;stroke-dasharray:3 4;opacity:.75}
.rulelab{font-family:var(--mono);font-size:10.5px;opacity:.85}
.tick{fill:var(--dim);font-size:11px;font-family:var(--mono)}
.ticksub{fill:var(--faint);font-size:9.5px;font-family:var(--mono)}
.axlab{fill:var(--faint);font-size:11.5px}
.legend{fill:var(--dim);font-size:11.5px}
.bin{fill:none;stroke:var(--line);stroke-width:1.6}
.binfill{fill:color-mix(in srgb,var(--acc2) 40%,transparent)}
.item{fill:color-mix(in srgb,var(--acc) 35%,transparent);stroke:var(--acc);stroke-width:1.4}
.diaglab{fill:var(--ink);font-size:11.5px;font-family:var(--mono)}
.diagnote{fill:var(--dim);font-size:11.5px}
.diagtag{font-size:10.5px}
.diagtag.ok{fill:var(--acc)} .diagtag.no{fill:var(--faint)}
.arrow{stroke:var(--faint);stroke-width:1.4;fill:none}
.arrowhead{fill:var(--faint)}
.layer{fill:var(--panel2);stroke-width:1.4;opacity:.95}
.lidx{font-family:var(--mono);font-size:15px;font-weight:600}
.ltitle{fill:var(--ink);font-size:14px;font-weight:600}
.ldesc{fill:var(--dim);font-size:12px}
.lmeta{font-family:var(--mono);font-size:11.5px;opacity:.9}

/* operator bars */
.opbars{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px 18px}
.opbar{display:grid;grid-template-columns:130px 1fr 54px 92px;gap:12px;align-items:center;
  padding:5px 0;font-size:13.5px}
.opname{color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.minted{font-size:10px;color:var(--acc);margin-left:5px}
.optrack{height:8px;background:var(--panel2);border-radius:4px;overflow:hidden}
.opfill{height:100%;background:linear-gradient(90deg,var(--acc2),var(--acc));border-radius:4px}
.opnum{font-size:12.5px;text-align:right}

/* log */
.logentry{background:var(--panel);border:1px solid var(--line);border-left-width:3px;
  border-radius:0 10px 10px 0;padding:14px 18px;margin:0 0 12px}
.logentry.acc{border-left-color:var(--acc)}
.logentry.hold{border-left-color:var(--line)}
.logentry header{display:flex;gap:12px;align-items:baseline;flex-wrap:wrap;margin-bottom:8px}
.logentry .gen{color:var(--acc);font-size:13px;font-weight:600}
.logentry .date{color:var(--faint);font-size:12px}
.logentry .logtitle{color:var(--dim);font-size:13px}
.logentry p{margin:0 0 8px;font-size:14.5px;line-height:1.72;max-width:78ch}
.logentry p:last-child{margin-bottom:0}

.miles{list-style:none;padding:0;margin:0 0 20px;counter-reset:m}
.miles li{display:grid;grid-template-columns:82px 1fr;gap:4px 14px;padding:10px 0;
  border-bottom:1px solid var(--line);font-size:14.5px}
.miles li .gen{color:var(--acc);font-size:12.5px}
.miles li strong{grid-column:2}
.miles li span:last-child{grid-column:2;color:var(--dim);font-size:13.5px}

.checks{padding-left:22px;margin:0 0 18px}
.checks li{margin-bottom:10px;font-size:14.5px;line-height:1.7;max-width:76ch}

/* footer */
footer{margin-top:64px;padding-top:26px;border-top:1px solid var(--line)}
.fgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:14px;margin-bottom:20px}
.fgrid div{display:flex;flex-direction:column}
footer .note{margin-top:10px}
.fk{font-size:12px;color:var(--faint)}
.fv{font-size:14px;color:var(--dim)}

@media (max-width:720px){
  .wrap{padding:0 16px 64px}
  h1{font-size:24px} .genno{font-size:26px}
  .lede{font-size:17px}
  h2{font-size:20px;gap:10px}
  .opbar{grid-template-columns:100px 1fr 48px;row-gap:2px}
  .opbar .opnum:last-child{grid-column:2/4;text-align:left}
  .top{padding:34px 0 22px}
  .miles li{grid-template-columns:1fr}
  .miles li strong,.miles li span:last-child{grid-column:1}
}
`;

// allow `node engine/render.mjs` to re-render from committed state
if (import.meta.url === `file://${process.argv[1]}`) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const genome = JSON.parse(fs.readFileSync(path.join(root, 'genome.json'), 'utf8'));
  const history = JSON.parse(fs.readFileSync(path.join(root, 'history.json'), 'utf8'));
  fs.writeFileSync(path.join(root, 'index.html'), renderSite(genome, history));
  console.log(`[ouroboros] rendered gen ${genome.generation}`);
}
