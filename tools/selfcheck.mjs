#!/usr/bin/env node
// The gate. Runs after every evolution step and before anything is committed
// or published. If any check fails the workflow discards the working tree and
// exits non-zero, so a bad night produces no commit rather than a bad site.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as X from '../engine/expr.mjs';
import { evaluateExpr } from '../engine/benchmark.mjs';
import { suiteFingerprint } from '../engine/problems.mjs';
import { renderSite } from '../engine/render.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const passes = [];

const check = (name, fn) => {
  try {
    const detail = fn();
    passes.push(`${name}${detail ? ` — ${detail}` : ''}`);
  } catch (e) {
    fails.push(`${name} — ${e.message}`);
  }
};

const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

const genome = JSON.parse(fs.readFileSync(path.join(ROOT, 'genome.json'), 'utf8'));
const history = JSON.parse(fs.readFileSync(path.join(ROOT, 'history.json'), 'utf8'));

check('基因组结构', () => {
  for (const k of ['schema', 'generation', 'champion', 'elites', 'search', 'baselines', 'stats']) {
    assert(genome[k] !== undefined, `缺少字段 ${k}`);
  }
  assert(Number.isInteger(genome.generation) && genome.generation >= 0, 'generation 不是非负整数');
  return `第 ${genome.generation} 代`;
});

check('基准实例集指纹', () => {
  const fp = suiteFingerprint();
  assert(genome.suiteFingerprint === fp, `记录 ${genome.suiteFingerprint}，实测 ${fp} — 考题被改过`);
  return fp;
});

check('表达式语法白名单', () => {
  assert(X.valid(genome.champion.expr), '冠军表达式不合法');
  const caps = genome.search.caps;
  assert(X.size(genome.champion.expr) <= caps.maxSize, `冠军超过节点上限 ${caps.maxSize}`);
  assert(X.depth(genome.champion.expr) <= caps.maxDepth, `冠军超过深度上限 ${caps.maxDepth}`);
  let n = 0;
  for (const e of genome.elites) {
    if (!e.expr) continue;
    assert(X.valid(e.expr), `精英 ${e.id} 表达式不合法`);
    assert(X.size(e.expr) <= caps.maxSize, `精英 ${e.id} 超过节点上限`);
    n++;
  }
  return `冠军 + ${n} 个精英全部通过`;
});

check('冠军完整性（重新评测）', () => {
  const ev = evaluateExpr(genome.champion.expr);
  for (const fold of ['train', 'val', 'test']) {
    const d = Math.abs(ev[fold].excess - genome.champion[fold].excess);
    assert(d < 1e-9, `${fold} 记录 ${genome.champion[fold].excess}，重算 ${ev[fold].excess}`);
  }
  assert(X.size(genome.champion.expr) === genome.champion.size, '记录的节点数不符');
  return `训练 ${ev.train.excess}% / 验证 ${ev.val.excess}% / 留出 ${ev.test.excess}%`;
});

check('冠军确实优于起点', () => {
  const bf = genome.baselines.bestFit.train.excess;
  assert(genome.champion.train.excess <= bf + 1e-9,
    `冠军 ${genome.champion.train.excess}% 竟然差于第 0 代的 Best Fit ${bf}%`);
  return `领先 Best Fit ${(bf - genome.champion.train.excess).toFixed(4)} pp`;
});

check('世代记录只追加', () => {
  assert(Array.isArray(history), 'history 不是数组');
  assert(history.length === genome.generation, `谱系 ${history.length} 条，基因组说第 ${genome.generation} 代`);
  let prevDate = '';
  history.forEach((h, i) => {
    assert(h.gen === i + 1, `第 ${i} 行世代号应为 ${i + 1}，实际 ${h.gen}`);
    assert(typeof h.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(h.date), `第 ${h.gen} 代日期格式错误`);
    assert(h.date >= prevDate, `第 ${h.gen} 代日期回退`);
    assert(Number.isFinite(h.trainAfter) && Number.isFinite(h.testAfter), `第 ${h.gen} 代缺少成绩`);
    prevDate = h.date;
  });
  return `${history.length} 代连续无缺口`;
});

check('训练折单调不升', () => {
  let prev = Infinity;
  for (const h of history) {
    assert(h.trainAfter <= prev + 1e-9, `第 ${h.gen} 代训练折从 ${prev} 上升到 ${h.trainAfter}`);
    prev = h.trainAfter;
  }
  return '选择压力从未放松';
});

check('验证折单调不升', () => {
  let prev = Infinity;
  for (const h of history) {
    if (h.valAfter === undefined) continue;
    assert(h.valAfter <= prev + 1e-9,
      `第 ${h.gen} 代验证折从 ${prev} 上升到 ${h.valAfter} — 否决门失效了`);
    prev = h.valAfter;
  }
  return '否决门每一代都生效';
});

check('算子权重', () => {
  const ops = genome.search.operators;
  assert(ops.length >= 8, `只剩 ${ops.length} 个算子`);
  const sum = ops.reduce((a, o) => a + o.weight, 0);
  assert(Math.abs(sum - 1) < 1e-3, `权重和为 ${sum.toFixed(6)}，应为 1`);
  const min = Math.min(...ops.map((o) => o.weight));
  assert(min >= 0.029, `最小权重 ${min} 低于 3% 地板 — 有算子被饿死了`);
  return `${ops.length} 个算子，最小权重 ${(min * 100).toFixed(1)}%`;
});

check('渲染确定性', () => {
  const onDisk = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const a = renderSite(genome, history);
  const b = renderSite(genome, history);
  assert(a === b, '同样的输入渲染出了不同的字节 — 渲染器里有时间戳或随机数');
  assert(a === onDisk, 'index.html 与基因组不同步（重新运行 node engine/render.mjs）');
  return `${(onDisk.length / 1024).toFixed(0)} KB，逐字节一致`;
});

check('页面自包含', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const grab = (re) => [...html.matchAll(re)].map((m) => m[1]);
  const isRemote = (u) => /^(https?:)?\/\//i.test(u);

  // Anything the browser would have to FETCH must be inline. Plain links out
  // to the repository are fine -- they cost nothing until someone clicks.
  const fetched = [
    ...grab(/\ssrc\s*=\s*["']([^"']+)["']/gi),
    ...grab(/<link\b[^>]*\shref\s*=\s*["']([^"']+)["']/gi),
  ].filter(isRemote);
  assert(fetched.length === 0, `发现 ${fetched.length} 个外部资源：${fetched.slice(0, 3).join(', ')}`);

  const links = grab(/<a\b[^>]*\shref\s*=\s*["']([^"']+)["']/gi)
    .filter(isRemote)
    .filter((u) => !u.startsWith('https://github.com/'));
  assert(links.length === 0, `出现了指向 GitHub 之外的链接：${links.slice(0, 3).join(', ')}`);

  assert(!/<script\b/i.test(html), '页面里出现了 <script>，这一页不需要 JavaScript');
  return '零外部请求，零脚本，仅链接回仓库';
});

const w = (s) => process.stdout.write(`${s}\n`);
w('');
w(`  OUROBOROS selfcheck — 第 ${genome.generation} 代`);
w('  ' + '─'.repeat(64));
for (const p of passes) w(`  \x1b[32mPASS\x1b[0m  ${p}`);
for (const f of fails) w(`  \x1b[31mFAIL\x1b[0m  ${f}`);
w('  ' + '─'.repeat(64));
w(`  ${passes.length} 通过，${fails.length} 失败`);
w('');

process.exit(fails.length ? 1 : 0);
