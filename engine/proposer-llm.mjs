// OPTIONAL layer. Everything above runs with zero dependencies and no API key;
// this file only activates when both `--llm` and ANTHROPIC_API_KEY are present
// and `@anthropic-ai/sdk` is installed.
//
// The point of the module is the asymmetry it demonstrates: the model is a
// *proposer*. It never sees the acceptance test, never writes to the genome,
// and its output is parsed into the same JSON expression grammar every mutation
// operator must produce. A malformed, dishonest or adversarial suggestion is
// indistinguishable from a bad mutation -- it loses on the benchmark and is
// dropped. That is the only property that makes an untrusted proposer safe to
// put inside a loop that commits to a repository unattended.

import * as X from './expr.mjs';

const MODEL = 'claude-opus-5';

const EXPR_SCHEMA_DOC = `
表达式是嵌套 JSON 数组：
  常数   ["c", 0.5]
  变量   ["v", "g"]          变量只能是 i / r / g / k
  一元   ["neg", X]          neg inv sq sqrt log
  二元   ["sub", X, Y]       add sub mul div min max
变量含义：
  i = 当前物品尺寸（按箱容归一，(0,1]）
  r = 候选箱剩余容量（归一，[0,1]）
  g = r − i，放进去之后剩下的缝隙
  k = 候选箱在已开箱序列中的归一位置，0 最老
装箱器在所有装得下的箱子里取分数最高的一个，并列时取更老的箱子。
Best Fit 就是 ["neg", ["v","g"]]；First Fit 是 ["neg", ["v","k"]]。
`.trim();

export async function proposeFromLLM(genome, opts) {
  const key = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN;
  if (!key) return { error: 'no ANTHROPIC_API_KEY in environment', requested: 0, candidates: [] };

  let Anthropic;
  try {
    ({ default: Anthropic } = await import('@anthropic-ai/sdk'));
  } catch {
    return { error: '@anthropic-ai/sdk not installed', requested: 0, candidates: [] };
  }

  const n = opts.llmCandidates ?? 8;
  const recent = (genome.log ?? []).slice(0, 3).map((l) => `第 ${l.gen} 代：${l.body[0]}`).join('\n');
  const elites = genome.elites
    .filter((e) => e.expr)
    .map((e) => `  ${e.id} 节点：${X.pretty(e.expr)}  训练集 ${e.train}%`)
    .join('\n');

  const prompt = `你在为一个在线装箱问题（online bin packing）搜索更好的启发式评分函数。

${EXPR_SCHEMA_DOC}

当前冠军（训练集超额率 ${genome.champion.train.excess}%，留出集 ${genome.champion.test.excess}%）：
  ${X.pretty(genome.champion.expr)}
  JSON: ${JSON.stringify(genome.champion.expr)}

各尺寸档位的精英：
${elites || '  （暂无）'}

基线：Best Fit ${genome.baselines.bestFit.train.excess}%，First Fit ${genome.baselines.firstFit.train.excess}%，离线 BFD ${genome.baselines.bestFitDecreasing.train.excess}%。

最近的进化日志：
${recent || '（暂无）'}

请提出 ${n} 个互不相同的候选表达式。要求：
- 每个候选都要有一句话说明它在赌什么样的结构性直觉（例如"惩罚那种小到再也塞不进任何东西的缝隙"）。
- 至少三个是对当前冠军的小幅改写，至少两个是结构上完全不同的思路。
- 节点数不超过 ${genome.search.caps.maxSize}，深度不超过 ${genome.search.caps.maxDepth}。
- 只输出符合上面语法的 JSON，不要写 JavaScript。`;

  const tool = {
    name: 'submit_candidates',
    description: '提交候选评分表达式。每个 expr 必须是上述 JSON 语法的合法表达式。',
    strict: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['candidates'],
      properties: {
        candidates: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['expr_json', 'idea'],
            properties: {
              expr_json: { type: 'string', description: '表达式的 JSON 字符串，例如 ["neg",["v","g"]]' },
              idea: { type: 'string', description: '一句话说明这个候选在赌什么' },
            },
          },
        },
      },
    },
  };

  const client = new Anthropic();
  let message;
  try {
    message = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      tools: [tool],
      messages: [{ role: 'user', content: `${prompt}\n\n把结果通过 submit_candidates 工具提交。` }],
    });
  } catch (e) {
    return { error: `api call failed: ${e?.message ?? e}`, requested: n, candidates: [] };
  }

  if (message.stop_reason === 'refusal') {
    return { error: `refused: ${message.stop_details?.category ?? 'unknown'}`, requested: n, candidates: [] };
  }

  const out = [];
  const ideas = [];
  for (const block of message.content ?? []) {
    if (block.type !== 'tool_use' || block.name !== 'submit_candidates') continue;
    for (const c of block.input?.candidates ?? []) {
      let expr;
      try { expr = JSON.parse(c.expr_json); } catch { continue; }
      // The only trust boundary that matters: grammar validation before compile.
      if (!X.valid(expr)) continue;
      if (X.size(expr) > genome.search.caps.maxSize) continue;
      if (X.depth(expr) > genome.search.caps.maxDepth) continue;
      out.push(expr);
      ideas.push(String(c.idea ?? '').slice(0, 200));
    }
  }

  return { model: MODEL, requested: n, candidates: out, ideas, error: null };
}
