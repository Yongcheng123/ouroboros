#!/usr/bin/env node
// Replay the most recent generation from its recorded seed and check that it
// lands on exactly the champion that was committed.
//
// The previous genome is not stored anywhere special -- it is simply the
// previous commit. Git is the append-only log, so `git show HEAD~1:genome.json`
// is the state the last night started from. If the replay diverges, the
// lineage on the site stopped being evidence and started being a story.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import * as X from '../engine/expr.mjs';
import { stepOnce } from '../engine/evolve.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skip = (why) => { console.log(`[replay] 跳过：${why}`); process.exit(0); };

const current = JSON.parse(fs.readFileSync(path.join(ROOT, 'genome.json'), 'utf8'));
if (current.generation === 0) skip('还没有任何世代');

let prevGenome; let prevHistory;
try {
  const show = (rev) => execFileSync('git', ['show', rev], { cwd: ROOT, encoding: 'utf8' });
  prevGenome = JSON.parse(show('HEAD~1:genome.json'));
  prevHistory = JSON.parse(show('HEAD~1:history.json'));
} catch {
  skip('上一个提交里没有基因组（可能是创世提交，或者 checkout 深度不够）');
}

if (prevGenome.generation !== current.generation - 1) {
  skip(`上一个提交是第 ${prevGenome.generation} 代，当前是第 ${current.generation} 代 —— 不是单代推进，无法逐代重放`);
}

const record = current.lastRun;
if (record.llm && record.llm.parsed > 0) {
  skip('这一代用到了语言模型提议，重放需要相同的模型输出，不在确定性保证范围内');
}

console.log(`[replay] 重放第 ${current.generation} 代（日期 ${record.date}，种子 ${record.seed}）…`);
const started = Date.now();
const result = await stepOnce(prevGenome, prevHistory, { date: record.date, label: record.label ?? 'daily' });
const elapsed = ((Date.now() - started) / 1000).toFixed(1);

const got = prevGenome.champion;
const want = current.champion;
const problems = [];

if (X.key(got.expr) !== X.key(want.expr)) {
  problems.push(`冠军表达式不同\n    重放得到：${X.pretty(got.expr)}\n    提交记录：${X.pretty(want.expr)}`);
}
if (Math.abs(got.train.excess - want.train.excess) > 1e-9) {
  problems.push(`训练折得分不同：重放 ${got.train.excess}，记录 ${want.train.excess}`);
}
if (Math.abs(got.val.excess - want.val.excess) > 1e-9) {
  problems.push(`验证折得分不同：重放 ${got.val.excess}，记录 ${want.val.excess}`);
}
if (prevGenome.lastRun.seed !== record.seed) {
  problems.push(`种子不同：重放 ${prevGenome.lastRun.seed}，记录 ${record.seed}`);
}
if (result.accepted !== record.accepted) {
  problems.push(`接受与否不同：重放 ${result.accepted}，记录 ${record.accepted}`);
}

if (problems.length) {
  console.error(`\n[replay] \x1b[31m不可复现\x1b[0m（${elapsed}s）`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error('\n引擎里出现了非确定性。世代谱系上的种子列不再有意义，先查这个再谈别的。\n');
  process.exit(1);
}

console.log(`[replay] \x1b[32m一致\x1b[0m（${elapsed}s）— 第 ${current.generation} 代可以从种子原样重放。`);
