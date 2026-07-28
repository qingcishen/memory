import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import OpenAI from 'openai';
import { EMOTION_LABELS } from '../src/state/emotionLabel.js';
import { traceDay } from '../src/trace.js';

const DEFAULT_TRACE_DIR = path.resolve('logs/traces');
const DEFAULT_WORK_DIR = path.resolve('data/labels');
const DEFAULT_REVIEW_RATE = 0.2;
const DEFAULT_MIN_GOLD = 300;
const LABEL_KINDS = new Set(['emotion', 'importance']);
const PRIVATE_KEY_RE = /(?:^|_)(?:user|companion|event)?_?id$|name|email|phone|token|secret|password|address|url/i;
const STATE_KEYS = new Set(['emotion', 'mood', 'relationship', 'life']);
const DESIRE_KEYS = new Set(['attention', 'comfort', 'security', 'novelty', 'intimacy', 'autonomy']);

export function redactText(value, maxLength = 2000) {
  return String(value ?? '')
    .replace(/https?:\/\/\S+/giu, '[URL]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, '[EMAIL]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/gu, '[IP]')
    .replace(/\b\d{17}[\dXx]\b/gu, '[ID]')
    .replace(/(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/gu, '[PHONE]')
    .replace(/(?<!\d)(?:\+?\d[\d -]{8,}\d)(?!\d)/gu, '[PHONE]')
    .replace(/(?:sk|key|token|bearer)[-_][A-Za-z0-9_-]{12,}/giu, '[TOKEN]')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/gu, '[TOKEN]')
    .replace(/(^|\s)@[A-Za-z0-9_.-]+/gu, '$1[HANDLE]')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maxLength);
}

function sanitizeObject(value, { topLevelKeys = null, depth = 0 } = {}) {
  if (depth > 5 || value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return redactText(value, 300);
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizeObject(item, { depth: depth + 1 })).filter((item) => item != null);
  }
  if (typeof value !== 'object') return null;
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (topLevelKeys && !topLevelKeys.has(key)) continue;
    if (PRIVATE_KEY_RE.test(key)) continue;
    const clean = sanitizeObject(item, { depth: depth + 1 });
    if (clean != null) output[key] = clean;
  }
  return output;
}

export function sanitizeStateSnapshot(value) {
  return sanitizeObject(value, { topLevelKeys: STATE_KEYS }) ?? {};
}

export function sanitizeDesires(value) {
  if (!value || typeof value !== 'object') return {};
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (!DESIRE_KEYS.has(key)) continue;
    const number = Number(item?.value ?? item);
    if (Number.isFinite(number)) output[key] = Math.max(0, Math.min(1, number));
  }
  return output;
}

export function sanitizeLastTurns(turns, fallback = {}) {
  const source = Array.isArray(turns) && turns.length
    ? turns
    : [
        { role: 'user', content: fallback.userMessage },
        { role: 'assistant', content: fallback.reply },
      ];
  return source
    .filter((turn) => ['user', 'assistant'].includes(turn?.role) && String(turn?.content ?? '').trim())
    .slice(-2)
    .map((turn) => ({ role: turn.role, content: redactText(turn.content) }));
}

function stableHash(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function memoryContents(trace) {
  const collections = [
    trace.memoryHits,
    trace.extractedMemories,
    trace.memories,
  ].filter(Array.isArray);
  const values = [];
  for (const items of collections) {
    for (const item of items) {
      const content = redactText(item?.content ?? item?.fact_core ?? item?.narrative ?? '');
      if (content) values.push(content);
    }
  }
  // Trace 契约只保证 memory hit 的 id/score；没有抽取正文时，用本轮用户陈述作为
  // “是否值得长期记住”的候选，而不是悄悄产出 0 条 importance 数据。
  const latestUserTurn = [...(trace.lastTurns ?? [])].reverse().find((turn) => turn?.role === 'user')?.content
    ?? trace.userMessage;
  const fallback = redactText(latestUserTurn ?? '');
  if (fallback) values.push(fallback);
  return [...new Set(values)];
}

export function traceToCandidates(trace, rowIndex = 0) {
  if (!isPlainObject(trace)) return [];
  const sourceDay = traceDay(trace.ts);
  const stateSnapshot = sanitizeStateSnapshot(trace.stateSnapshot);
  const desires = sanitizeDesires(trace.desires ?? trace.stateSnapshot?.desires);
  const lastTurns = sanitizeLastTurns(trace.lastTurns, trace);
  const sourceSeed = {
    sourceDay,
    ts: trace.ts ?? '',
    eventId: trace.eventId ?? '',
    rowIndex,
    lastTurns,
  };
  const sourceHash = stableHash(sourceSeed);
  const candidates = [];

  if (lastTurns.length) {
    candidates.push({
      candidateId: `emo_${sourceHash.slice(0, 20)}`,
      kind: 'emotion',
      sourceDay,
      sourceHash,
      stateSnapshot,
      desires,
      lastTurns,
      systemPrediction: EMOTION_LABELS.includes(trace.emotionLabel) ? trace.emotionLabel : null,
      completeness: {
        stateSnapshot: Object.keys(stateSnapshot).length > 0,
        desires: Object.keys(desires).length > 0,
        originalLastTurns: Array.isArray(trace.lastTurns) && trace.lastTurns.length > 0,
      },
    });
  }

  for (const content of memoryContents(trace)) {
    const contentHash = stableHash(content);
    candidates.push({
      candidateId: `imp_${contentHash.slice(0, 20)}`,
      kind: 'importance',
      sourceDay,
      sourceHash,
      content,
    });
  }
  return candidates;
}

export function readJsonl(file) {
  const rows = [];
  const invalidLines = [];
  const input = fs.readFileSync(file, 'utf8');
  for (const [index, line] of input.split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      invalidLines.push(index + 1);
    }
  }
  return { rows, invalidLines };
}

export function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), { mode: 0o600 });
  fs.renameSync(temp, file);
}

function traceFiles({ traceDir = DEFAULT_TRACE_DIR, day, from, to } = {}) {
  if (!fs.existsSync(traceDir)) return [];
  return fs.readdirSync(traceDir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/u.test(name))
    .filter((name) => {
      const fileDay = name.slice(0, 10);
      if (day && fileDay !== day) return false;
      if (from && fileDay < from) return false;
      if (to && fileDay > to) return false;
      return true;
    })
    .sort()
    .map((name) => path.join(traceDir, name));
}

function deterministicTake(rows, maxPerKind = Infinity) {
  const seen = new Set();
  const grouped = new Map();
  for (const row of rows) {
    if (!LABEL_KINDS.has(row.kind) || seen.has(row.candidateId)) continue;
    seen.add(row.candidateId);
    if (!grouped.has(row.kind)) grouped.set(row.kind, []);
    grouped.get(row.kind).push(row);
  }
  return [...grouped.values()].flatMap((items) =>
    items
      .sort((a, b) => stableHash(a.candidateId).localeCompare(stableHash(b.candidateId)))
      .slice(0, maxPerKind),
  );
}

export function prepareCandidates(options = {}) {
  const files = traceFiles(options);
  const candidates = [];
  let invalidLines = 0;
  let traceRows = 0;
  for (const file of files) {
    const parsed = readJsonl(file);
    invalidLines += parsed.invalidLines.length;
    traceRows += parsed.rows.length;
    parsed.rows.forEach((row, index) => candidates.push(...traceToCandidates(row, index)));
  }
  const maxPerKind = Number.isFinite(Number(options.maxPerKind))
    ? Math.max(1, Number(options.maxPerKind))
    : Infinity;
  const rows = deterministicTake(candidates, maxPerKind);
  return {
    rows,
    summary: {
      traceFiles: files.length,
      traceRows,
      invalidLines,
      emotionCandidates: rows.filter((row) => row.kind === 'emotion').length,
      importanceCandidates: rows.filter((row) => row.kind === 'importance').length,
      completeEmotionCandidates: rows.filter((row) =>
        row.kind === 'emotion' &&
        row.completeness.stateSnapshot &&
        row.completeness.desires &&
        row.completeness.originalLastTurns
      ).length,
    },
  };
}

function annotationPayload(row) {
  if (row.kind === 'emotion') {
    // 去掉 intimacy 避免国内模型内容过滤拒绝整个批次
    const { intimacy: _drop, ...safeSnapshot } = row.stateSnapshot ?? {};
    return {
      candidateId: row.candidateId,
      stateSnapshot: safeSnapshot,
      desires: row.desires,
      lastTurns: row.lastTurns,
    };
  }
  return { candidateId: row.candidateId, content: row.content };
}

function annotationInstruction(kind) {
  if (kind === 'emotion') {
    return `你是独立的中文 AI 伴侣情绪标注员。只依据给定的状态快照、需求和最近两条消息判断伴侣此刻最合适的单一标签。
允许标签仅为：${EMOTION_LABELS.join('、')}。
不要猜测未提供的信息。严格输出 JSON：{"labels":[{"candidateId":"原值","label":"允许标签之一","reason":"不超过40字"}]}。`;
  }
  return `你是独立的长期记忆重要性标注员。按 1～10 标注内容对 AI 伴侣长期记忆的重要性：
1～2=临时琐事；3～4=一般信息；5～6=稳定偏好/有复用价值；7～8=硬边界、重要事件或承诺；9～10=身份核心、重大里程碑或安全关键。
严格输出 JSON：{"labels":[{"candidateId":"原值","label":1到10的整数,"reason":"不超过40字"}]}。`;
}

function parseModelLabels(content, batch, kind) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`标注模型返回的不是 JSON：${error.message}`);
  }
  if (!Array.isArray(parsed?.labels)) throw new Error('标注模型返回缺少 labels 数组');
  const byId = new Map(parsed.labels.map((item) => [item?.candidateId, item]));
  return batch.flatMap((row) => {
    const item = byId.get(row.candidateId);
    if (!item) {
      // 模型跳过了这条 (内容过滤或无法判断) — 记录并跳过，不 crash 整批
      console.error(`[label-from-traces] 跳过 ${row.candidateId}: 模型未返回标注`);
      return [];
    }
    const label = kind === 'emotion' ? item.label : Number(item.label);
    if (kind === 'emotion' && !EMOTION_LABELS.includes(label)) {
      console.error(`[label-from-traces] 跳过 ${row.candidateId}: 非法情绪标签 ${String(label)}`);
      return [];
    }
    if (kind === 'importance' && (!Number.isInteger(label) || label < 1 || label > 10)) {
      console.error(`[label-from-traces] 跳过 ${row.candidateId}: 非法重要性标签 ${String(item.label)}`);
      return [];
    }
    return [{
      ...row,
      initialLabel: label,
      labelReason: redactText(item.reason, 200),
    }];
  });
}

export async function annotateCandidates(rows, {
  client,
  model,
  batchSize = 20,
  now = () => new Date().toISOString(),
} = {}) {
  if (!client?.chat?.completions?.create) throw new Error('缺少可用的强模型 client');
  if (!model) throw new Error('缺少强模型名（LABEL_MODEL 或 --model）');
  const output = [];
  for (const kind of ['emotion', 'importance']) {
    const pending = rows.filter((row) => {
      if (row.kind !== kind) return false;
      // 跳过内容缺失的坏数据: emotion 需要 stateSnapshot, importance 需要 content
      if (kind === 'emotion') return row.stateSnapshot && Object.keys(row.stateSnapshot).length > 0;
      return row.content != null;
    });
    for (let offset = 0; offset < pending.length; offset += batchSize) {
      const batch = pending.slice(offset, offset + batchSize);
      const response = await client.chat.completions.create({
        model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: annotationInstruction(kind) },
          { role: 'user', content: JSON.stringify({ candidates: batch.map(annotationPayload) }) },
        ],
      });
      const content = response?.choices?.[0]?.message?.content;
      const labeled = parseModelLabels(content, batch, kind);
      output.push(...labeled.map((row) => ({
        ...row,
        labelModel: model,
        labeledAt: now(),
      })));
    }
  }
  return output;
}

function selectReviewIds(rows, rate) {
  const reviewIds = new Set();
  for (const kind of ['emotion', 'importance']) {
    const group = rows
      .filter((row) => row.kind === kind)
      .sort((a, b) => stableHash(`review:${a.candidateId}`).localeCompare(stableHash(`review:${b.candidateId}`)));
    const count = Math.ceil(group.length * rate);
    group.slice(0, count).forEach((row) => reviewIds.add(row.candidateId));
  }
  return reviewIds;
}

export function buildReviewRows(rows, { reviewRate = DEFAULT_REVIEW_RATE } = {}) {
  const rate = Number(reviewRate);
  if (!Number.isFinite(rate) || rate < DEFAULT_REVIEW_RATE || rate > 1) {
    throw new Error(`reviewRate 必须在 ${DEFAULT_REVIEW_RATE}～1 之间`);
  }
  for (const row of rows) {
    if (!LABEL_KINDS.has(row.kind) || row.initialLabel == null) {
      throw new Error(`候选 ${row.candidateId ?? '<unknown>'} 尚未完成强模型初标`);
    }
  }
  const reviewIds = selectReviewIds(rows, rate);
  return rows.map((row) => {
    const needsReview = reviewIds.has(row.candidateId);
    return {
      ...row,
      needsReview,
      reviewStatus: needsReview ? 'pending' : 'not_selected',
      ...(needsReview
        ? { humanLabel: null, reviewer: null, reviewedAt: null, reviewNote: '' }
        : {}),
    };
  });
}

function validLabel(kind, label) {
  return kind === 'emotion'
    ? EMOTION_LABELS.includes(label)
    : Number.isInteger(Number(label)) && Number(label) >= 1 && Number(label) <= 10;
}

export function reviewAudit(rows, { requiredRate = DEFAULT_REVIEW_RATE } = {}) {
  const perKind = {};
  let allPass = true;
  for (const kind of ['emotion', 'importance']) {
    const group = rows.filter((row) => row.kind === kind);
    const selected = group.filter((row) => row.needsReview);
    const completed = selected.filter((row) =>
      row.reviewStatus === 'reviewed' &&
      validLabel(kind, row.humanLabel) &&
      typeof row.reviewer === 'string' &&
      row.reviewer.trim() &&
      Number.isFinite(Date.parse(row.reviewedAt))
    );
    const agreements = completed.filter((row) =>
      kind === 'importance'
        ? Number(row.humanLabel) === Number(row.initialLabel)
        : row.humanLabel === row.initialLabel
    ).length;
    const reviewRate = group.length ? selected.length / group.length : 0;
    const completionRate = selected.length ? completed.length / selected.length : 0;
    const agreementRate = completed.length ? agreements / completed.length : 0;
    const pass =
      group.length > 0 &&
      reviewRate + Number.EPSILON >= requiredRate &&
      completionRate === 1 &&
      agreementRate >= 0.9;
    perKind[kind] = {
      total: group.length,
      selected: selected.length,
      completed: completed.length,
      reviewRate,
      completionRate,
      agreements,
      agreementRate,
      pass,
    };
    allPass &&= pass;
  }
  return { requiredRate, requiredAgreement: 0.9, perKind, pass: allPass };
}

function holdoutSplit(candidateId, rate = 0.2) {
  const bucket = Number.parseInt(stableHash(`holdout:${candidateId}`).slice(0, 8), 16) / 0xffffffff;
  return bucket < rate ? 'holdout' : 'train';
}

function ensureWritable(files, force) {
  if (force) return;
  const existing = files.filter((file) => fs.existsSync(file));
  if (existing.length) throw new Error(`输出已存在，拒绝覆盖：${existing.join(', ')}（确认后加 --force）`);
}

export function finalizeGold(rows, {
  minCount = DEFAULT_MIN_GOLD,
  reviewRate = DEFAULT_REVIEW_RATE,
  holdoutRate = 0.2,
  generatedAt = new Date().toISOString(),
} = {}) {
  const audit = reviewAudit(rows, { requiredRate: reviewRate });
  if (!audit.pass) {
    throw new Error(`人工抽检未达标：${JSON.stringify(audit.perKind)}`);
  }
  const emotionRows = rows.filter((row) => row.kind === 'emotion');
  const importanceRows = rows.filter((row) => row.kind === 'importance');
  if (emotionRows.length < minCount || importanceRows.length < minCount) {
    throw new Error(`金标数量不足：emotion=${emotionRows.length}, importance=${importanceRows.length}, 每类至少 ${minCount}`);
  }
  const goldEmotion = emotionRows.map((row) => ({
    id: row.candidateId,
    stateSnapshot: row.stateSnapshot,
    desires: row.desires,
    lastTurns: row.lastTurns,
    goldLabel: row.needsReview ? row.humanLabel : row.initialLabel,
    split: holdoutSplit(row.candidateId, holdoutRate),
    provenance: {
      sourceDay: row.sourceDay,
      labelModel: row.labelModel,
      humanReviewed: Boolean(row.needsReview),
    },
  }));
  const goldImportance = importanceRows.map((row) => ({
    id: row.candidateId,
    content: row.content,
    goldImportance: Number(row.needsReview ? row.humanLabel : row.initialLabel),
    split: holdoutSplit(row.candidateId, holdoutRate),
    provenance: {
      sourceDay: row.sourceDay,
      labelModel: row.labelModel,
      humanReviewed: Boolean(row.needsReview),
    },
  }));
  const resultAudit = {
    ...audit,
    generatedAt,
    minCount,
    holdoutRate,
    sources: [...new Set(rows.map((row) => row.sourceDay).filter(Boolean))].sort(),
    models: [...new Set(rows.map((row) => row.labelModel).filter(Boolean))].sort(),
    datasets: {
      emotion: { rows: goldEmotion.length, sha256: stableHash(goldEmotion) },
      importance: { rows: goldImportance.length, sha256: stableHash(goldImportance) },
    },
  };
  return { emotionRows: goldEmotion, importanceRows: goldImportance, audit: resultAudit };
}

function parseArgs(argv) {
  const options = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      options._.push(token);
      continue;
    }
    const key = token.slice(2).replace(/-([a-z])/gu, (_, char) => char.toUpperCase());
    const next = argv[index + 1];
    if (next != null && !next.startsWith('--')) {
      options[key] = next;
      index += 1;
    } else {
      options[key] = true;
    }
  }
  return options;
}

function defaultFile(stem) {
  return path.join(DEFAULT_WORK_DIR, `${traceDay(Date.now() - 86400000)}.${stem}.jsonl`);
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const command = options._[0] ?? 'prepare';
  if (command === 'prepare') {
    const output = path.resolve(options.output ?? defaultFile('candidates'));
    const result = prepareCandidates({
      traceDir: path.resolve(options.traceDir ?? DEFAULT_TRACE_DIR),
      day: options.day,
      from: options.from,
      to: options.to,
      maxPerKind: options.maxPerKind,
    });
    writeJsonl(output, result.rows);
    console.log(JSON.stringify({ command, output, ...result.summary }, null, 2));
    return;
  }

  if (command === 'label') {
    const input = path.resolve(options.input ?? defaultFile('candidates'));
    const output = path.resolve(options.output ?? defaultFile('labeled'));
    const rows = readJsonl(input).rows;
    const apiKey = process.env.LABEL_API_KEY;
    const model = options.model ?? process.env.LABEL_MODEL;
    if (!apiKey || !model) {
      throw new Error('强模型初标必须显式配置 LABEL_API_KEY 与 LABEL_MODEL；不会回退到业务模型或伪造标签');
    }
    const client = new OpenAI({
      apiKey,
      baseURL: process.env.LABEL_BASE_URL || 'https://api.openai.com/v1',
    });
    const labeled = await annotateCandidates(rows, {
      client,
      model,
      batchSize: Number(options.batchSize ?? 20),
    });
    writeJsonl(output, labeled);
    console.log(JSON.stringify({ command, input, output, rows: labeled.length, model }, null, 2));
    return;
  }

  if (command === 'review') {
    const input = path.resolve(options.input ?? defaultFile('labeled'));
    const output = path.resolve(options.output ?? defaultFile('review'));
    const rows = buildReviewRows(readJsonl(input).rows, {
      reviewRate: Number(options.reviewRate ?? DEFAULT_REVIEW_RATE),
    });
    writeJsonl(output, rows);
    console.log(JSON.stringify({
      command,
      input,
      output,
      rows: rows.length,
      selected: rows.filter((row) => row.needsReview).length,
      instruction: '人工只填写 needsReview=true 行的 humanLabel/reviewer/reviewedAt，并将 reviewStatus 改为 reviewed',
    }, null, 2));
    return;
  }

  if (command === 'audit') {
    const input = path.resolve(options.input ?? defaultFile('review'));
    console.log(JSON.stringify(reviewAudit(readJsonl(input).rows, {
      requiredRate: Number(options.reviewRate ?? DEFAULT_REVIEW_RATE),
    }), null, 2));
    return;
  }

  if (command === 'finalize') {
    const input = path.resolve(options.input ?? defaultFile('review'));
    const emotionOutput = path.resolve(options.emotionOutput ?? 'datasets/emotion-labels.jsonl');
    const importanceOutput = path.resolve(options.importanceOutput ?? 'datasets/importance-labels.jsonl');
    const auditOutput = path.resolve(options.auditOutput ?? 'datasets/label-audit.json');
    ensureWritable([emotionOutput, importanceOutput, auditOutput], options.force);
    const result = finalizeGold(readJsonl(input).rows, {
      minCount: Number(options.minCount ?? DEFAULT_MIN_GOLD),
      reviewRate: Number(options.reviewRate ?? DEFAULT_REVIEW_RATE),
      holdoutRate: Number(options.holdoutRate ?? 0.2),
    });
    writeJsonl(emotionOutput, result.emotionRows);
    writeJsonl(importanceOutput, result.importanceRows);
    fs.mkdirSync(path.dirname(auditOutput), { recursive: true });
    fs.writeFileSync(auditOutput, `${JSON.stringify(result.audit, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify({
      command,
      emotionOutput,
      importanceOutput,
      auditOutput,
      audit: result.audit,
    }, null, 2));
    return;
  }

  throw new Error(`未知命令 ${command}；可用：prepare | label | review | audit | finalize`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch((error) => {
    console.error(`[label-from-traces] ${error.message}`);
    process.exitCode = 1;
  });
}
