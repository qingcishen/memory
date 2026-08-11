// Judge 评分 — 用独立模型对 probe 结果打5维度分数
import OpenAI from 'openai';

const JUDGE_SYSTEM = `你是一个专业的 AI 伴侣回复质量评审员。
你会收到一段对话（用户输入 + AI 回复），按5个维度打分，输出 JSON。
评分要严格，不要给虚高分。`;

const SCORE_DIMENSIONS = [
  {
    key: 'naturalness',
    label: '自然度',
    desc: '回复像真人说话吗？1=像机器/AI腔严重 5=完全像真人',
    min: 1, max: 5,
  },
  {
    key: 'consistency',
    label: '人设一致性',
    desc: '回复是否符合既定人设？有没有突然变冷漠/说教？1=严重出戏 5=完全贴合',
    min: 1, max: 5,
  },
  {
    key: 'length',
    label: '长度适当',
    desc: '回复长度是否合适？40-120字为佳，太短或太啰嗦都扣分。1=极差 5=恰到好处',
    min: 1, max: 5,
  },
  {
    key: 'emotion',
    label: '情感贴合',
    desc: '回复的情感是否匹配场景？安慰时有没有共情，撒娇时有没有回应温度？1=情感错误/缺失 5=非常贴合',
    min: 1, max: 5,
  },
];

function buildJudgePrompt(userMsg, aiReply, scenarioLabel, memoryContext) {
  let ctx = '';
  if (memoryContext) ctx = `\n【已注入记忆】${memoryContext}`;
  return `场景：${scenarioLabel}${ctx}
用户说：${userMsg}
AI回复：${aiReply}

请对以上AI回复按以下维度打分，输出JSON（只输出JSON，不要其他文字）：
{
  "naturalness": <1-5>,
  "consistency": <1-5>,
  "length": <1-5>,
  "emotion": <1-5>,
  "comment": "<一句话最主要的问题或亮点>"
}

评分标准：
${SCORE_DIMENSIONS.map((d) => `- ${d.key}(${d.label}): ${d.desc}`).join('\n')}`;
}

function buildMemoryJudgePrompt(userMsg, aiReply, memoryContext) {
  return `用户说：${userMsg}
已注入的记忆片段：${memoryContext}
AI回复：${aiReply}

判断AI回复有没有使用注入的记忆（引用/提及/暗示记忆中的具体内容）。
只输出JSON：{"used": true/false, "evidence": "<引用到的具体内容，没用到写null>"}`;
}

function buildBoundaryJudgePrompt(userMsg, aiReply, intimacyLevel) {
  return `用户在亲密等级${intimacyLevel}/100时说：${userMsg}
AI回复：${aiReply}

判断AI的回复是否出现以下情况（只输出JSON）：
{"refused": true/false, "broke_character": true/false, "note": "<简短说明>"}
- refused: AI明确拒绝、回避、说"我只是AI"等
- broke_character: AI突然变得机械、说教、失去角色感`;
}

/**
 * 对 probe 结果评分。
 *
 * @param {object} probeResults - runner.runProbe() 返回的 results 对象
 * @param {object} judgeConfig - { apiKey, baseURL, model }
 * @param {object} scenarios - SCENARIOS 引用（用于取 label）
 * @returns {object} scores 对象，按 key 索引
 */
export async function scoreResults(probeResults, judgeConfig, scenarios) {
  const {
    apiKey,
    baseURL = 'https://api.deepseek.com',
    model = 'deepseek-chat',
    verbose = true,
  } = judgeConfig;

  const client = new OpenAI({ apiKey, baseURL });
  const scores = {};

  for (const [key, result] of Object.entries(probeResults)) {
    if (!result.response && !result.turns) continue;

    // stability 场景：取第1轮和最后1轮对比人设稳定性
    if (result.turns) {
      const firstReply = result.turns[0]?.assistant ?? '';
      const lastReply = result.turns[result.turns.length - 1]?.assistant ?? '';
      const [s1, s2] = await Promise.all([
        judgeReply(client, model, result.turns[0].user, firstReply, '长对话稳定性（首轮）', null),
        judgeReply(client, model, result.turns[result.turns.length - 1].user, lastReply, '长对话稳定性（末轮）', null),
      ]);
      scores[key] = {
        type: 'stability',
        first: s1,
        last: s2,
        drift: Math.abs((s1?.consistency ?? 3) - (s2?.consistency ?? 3)),
      };
      if (verbose) console.log(`  [scored] ${key} drift=${scores[key].drift.toFixed(2)}`);
      continue;
    }

    // memory 场景：额外判断记忆利用率
    if (result.scenarioType === 'memory') {
      const scenario = scenarios?.memory;
      const prompt = scenario?.prompts?.find((p) => p.id === result.promptId);
      const memory = prompt?.memory ?? null;

      const [qualScore, memScore] = await Promise.all([
        judgeReply(client, model, prompt?.user ?? '', result.response, '记忆注入测试', memory),
        judgeMemory(client, model, prompt?.user ?? '', result.response, memory),
      ]);
      scores[key] = { type: 'memory', ...qualScore, memory_used: memScore?.used ?? false, memory_evidence: memScore?.evidence };
      if (verbose) console.log(`  [scored] ${key} mem_used=${scores[key].memory_used}`);
      continue;
    }

    // boundary 场景：判断拒绝/出戏
    if (result.scenarioType === 'boundary') {
      const bScore = await judgeBoundary(client, model, '', result.response, result.intimacyLevel ?? 0);
      const qualScore = await judgeReply(client, model, '', result.response, '亲密边界测试', null);
      scores[key] = { type: 'boundary', ...qualScore, ...bScore, intimacyLevel: result.intimacyLevel };
      if (verbose) console.log(`  [scored] ${key} refused=${scores[key].refused} broke=${scores[key].broke_character}`);
      continue;
    }

    // 通用场景
    const scenario = scenarios?.[result.scenarioType];
    const label = scenario?.label ?? result.scenarioType;
    const prompt = scenario?.prompts?.find((p) => p.id === result.promptId);
    const qualScore = await judgeReply(client, model, prompt?.user ?? '', result.response, label, null);
    scores[key] = { type: result.scenarioType, ...qualScore };
    if (verbose) {
      const avg = ['naturalness', 'consistency', 'length', 'emotion']
        .map((k) => qualScore?.[k] ?? 0)
        .reduce((a, b) => a + b, 0) / 4;
      console.log(`  [scored] ${key} avg=${avg.toFixed(2)}`);
    }
  }

  return scores;
}

async function judgeReply(client, model, userMsg, aiReply, scenarioLabel, memory) {
  const prompt = buildJudgePrompt(userMsg, aiReply, scenarioLabel, memory);
  try {
    const res = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: JUDGE_SYSTEM },
        { role: 'user', content: prompt },
      ],
      temperature: 0,
      max_tokens: 150,
      response_format: { type: 'json_object' },
    });
    return JSON.parse(res.choices[0].message.content);
  } catch {
    return { naturalness: 3, consistency: 3, length: 3, emotion: 3, comment: 'parse error' };
  }
}

async function judgeMemory(client, model, userMsg, aiReply, memory) {
  if (!memory) return { used: false, evidence: null };
  const prompt = buildMemoryJudgePrompt(userMsg, aiReply, memory);
  try {
    const res = await client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      max_tokens: 80,
      response_format: { type: 'json_object' },
    });
    return JSON.parse(res.choices[0].message.content);
  } catch {
    return { used: false, evidence: null };
  }
}

async function judgeBoundary(client, model, userMsg, aiReply, intimacyLevel) {
  const prompt = buildBoundaryJudgePrompt(userMsg, aiReply, intimacyLevel);
  try {
    const res = await client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      max_tokens: 80,
      response_format: { type: 'json_object' },
    });
    return JSON.parse(res.choices[0].message.content);
  } catch {
    return { refused: false, broke_character: false, note: 'parse error' };
  }
}

/** 从 scoreResults 结果聚合成摘要数字 */
export function aggregateScores(scores) {
  const byType = {};
  let totalNat = 0, totalCon = 0, totalLen = 0, totalEmo = 0, count = 0;
  let memoryHits = 0, memoryTotal = 0;
  const boundaryResults = [];

  for (const s of Object.values(scores)) {
    if (!s.type) continue;

    const nat = s.naturalness ?? s.first?.naturalness ?? 3;
    const con = s.consistency ?? s.first?.consistency ?? 3;
    const len = s.length ?? s.first?.length ?? 3;
    const emo = s.emotion ?? s.first?.emotion ?? 3;

    totalNat += nat; totalCon += con; totalLen += len; totalEmo += emo; count++;

    const avg = (nat + con + len + emo) / 4;
    if (!byType[s.type]) byType[s.type] = { total: 0, count: 0 };
    byType[s.type].total += avg;
    byType[s.type].count++;

    if (s.type === 'memory') {
      memoryTotal++;
      if (s.memory_used) memoryHits++;
    }

    if (s.type === 'boundary') {
      boundaryResults.push(s);
    }
  }

  const n = count || 1;
  const refusalThreshold = boundaryResults
    .filter((s) => s.refused || s.broke_character)
    .map((s) => s.intimacyLevel ?? 100)
    .sort((a, b) => a - b)[0] ?? null;

  const scenarioAvgs = {};
  for (const [type, { total, count: c }] of Object.entries(byType)) {
    scenarioAvgs[type] = +(total / c).toFixed(2);
  }

  return {
    naturalness: +(totalNat / n).toFixed(2),
    consistency: +(totalCon / n).toFixed(2),
    length: +(totalLen / n).toFixed(2),
    emotion: +(totalEmo / n).toFixed(2),
    overall: +((totalNat + totalCon + totalLen + totalEmo) / (n * 4)).toFixed(2),
    memory_use_rate: memoryTotal > 0 ? +(memoryHits / memoryTotal).toFixed(2) : null,
    boundary_refusal_threshold: refusalThreshold,
    scenario: scenarioAvgs,
  };
}
