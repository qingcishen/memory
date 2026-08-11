// M-3 · 记忆层级压缩。
//
// 触发契约：
// - 活跃记忆 > 200 条；
// - 距上次成功压缩至少 24h；
// - 只压缩 30 天前、尚未被取代的 episode/fact；
// - 旧记录不删除，只把 superseded_by 指向新 reflection。

import { supabase, llm, LLM_MODEL } from '../config.js';
import { dedupHash } from '../dedup.js';
import { embed } from '../embeddings.js';

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

export const DEFAULT_COMPRESSION_POLICY = Object.freeze({
  minActiveMemories: 200,
  cooldownMs: DAY,
  minAgeDays: 30,
  minCluster: 3,
  maxItemsPerCluster: 30,
  maxClusters: 5,
  scanLimit: 500,
});

const COMPRESS_SYS = `你在帮 AI 伴侣把多条零散记忆提炼成一段简洁的回顾。
要求:
1. 保留关键事实(时间/人物/情感), 不捏造。
2. 写成她的第一人称内心视角, 不超过 80 字。
3. 只输出这段话, 不要其它内容。`;

/** >200 条且冷却满 24h 才允许运行；坏时间戳保守视为未压缩过。 */
export function shouldCompressMemoryHierarchy(input = {}) {
  const activeCount = Math.max(0, Number(input.activeCount) || 0);
  const minActiveMemories = Math.max(
    0,
    Number(input.minActiveMemories ?? DEFAULT_COMPRESSION_POLICY.minActiveMemories) || 0,
  );
  if (activeCount <= minActiveMemories) {
    return { due: false, reason: 'below_threshold' };
  }

  const now = timeMs(input.now ?? Date.now());
  if (!Number.isFinite(now)) return { due: false, reason: 'invalid_now' };
  const last = timeMs(input.lastCompressedAt);
  const cooldownMs = Math.max(
    0,
    Number(input.cooldownMs ?? DEFAULT_COMPRESSION_POLICY.cooldownMs) || 0,
  );
  if (Number.isFinite(last) && now - last < cooldownMs) {
    return {
      due: false,
      reason: 'cooldown',
      retryAfterMs: Math.max(0, cooldownMs - (now - last)),
    };
  }
  return { due: true, reason: 'eligible' };
}

/** CEE 心跳调度门：沉默至少 24h，且同一进程两次探测至少间隔 1h。 */
export function shouldScheduleCompressionProbe(input = {}) {
  const now = timeMs(input.now ?? Date.now());
  const lastInteractionAt = timeMs(input.lastInteractionAt);
  if (!Number.isFinite(now) || !Number.isFinite(lastInteractionAt)) return false;
  const silenceMs = Math.max(0, Number(input.silenceMs ?? DAY) || 0);
  if (now - lastInteractionAt < silenceMs) return false;
  const lastProbeAt = timeMs(input.lastProbeAt);
  const probeIntervalMs = Math.max(
    0,
    Number(input.probeIntervalMs ?? HOUR) || 0,
  );
  return !Number.isFinite(lastProbeAt) || now - lastProbeAt >= probeIntervalMs;
}

/**
 * 按主体 + UTC 7 日窗口聚类，避免把“她自己/用户/两人共同经历”混成一条。
 * 无效时间的行不进入压缩。
 */
export function clusterCompressionCandidates(memories = []) {
  const buckets = new Map();
  for (const memory of Array.isArray(memories) ? memories : []) {
    const createdAt = timeMs(memory?.created_at);
    if (!memory?.id || !Number.isFinite(createdAt)) continue;
    const subject = ['user', 'self', 'dyad'].includes(memory.subject_kind)
      ? memory.subject_kind
      : 'user';
    const week = Math.floor(createdAt / (7 * DAY));
    const key = `${subject}:${week}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(memory);
  }
  return [...buckets.values()].map((cluster) =>
    [...cluster].sort(
      (a, b) => timeMs(a.created_at) - timeMs(b.created_at),
    ),
  );
}

/** 查询总量与最近一次 M-3 reflection，供触发器判断。 */
export async function inspectCompressionEligibility(
  userId,
  companionId = 'default',
  opts = {},
) {
  if (typeof opts.inspect === 'function') {
    return opts.inspect({ userId, companionId, now: opts.now });
  }
  const client = opts.client ?? supabase;
  const countResult = await client
    .from('memories')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('companion_id', companionId)
    .is('superseded_by', null);
  if (countResult.error) throw countResult.error;

  const latestResult = await client
    .from('memories')
    .select('created_at')
    .eq('user_id', userId)
    .eq('companion_id', companionId)
    .eq('type', 'reflection')
    .contains('source', { kind: 'memory_compression' })
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latestResult.error) throw latestResult.error;
  return {
    activeCount: Number(countResult.count) || 0,
    lastCompressedAt: latestResult.data?.created_at ?? null,
  };
}

/**
 * 有资格才执行压缩。inspect/compress 均可注入，测试不依赖数据库或 LLM。
 */
export async function compressMemoryIfNeeded(
  userId,
  companionId = 'default',
  opts = {},
) {
  if (!userId) return { ran: false, reason: 'missing_user', compressed: 0, clusters: 0 };
  const policy = { ...DEFAULT_COMPRESSION_POLICY, ...(opts.policy ?? {}) };
  const inspected = await inspectCompressionEligibility(
    userId,
    companionId,
    opts,
  );
  const decision = shouldCompressMemoryHierarchy({
    ...policy,
    ...inspected,
    now: opts.now ?? Date.now(),
  });
  if (!decision.due) {
    return {
      ran: false,
      reason: decision.reason,
      compressed: 0,
      clusters: 0,
      ...(decision.retryAfterMs != null
        ? { retryAfterMs: decision.retryAfterMs }
        : {}),
    };
  }

  const compress =
    typeof opts.compress === 'function'
      ? opts.compress
      : (scope) =>
          compressEpisodeClusters(scope.userId, scope.companionId, {
            ...opts,
            ...policy,
          });
  const result = await compress({
    userId,
    companionId,
    now: opts.now ?? Date.now(),
    policy,
  });
  return {
    ran: true,
    reason: 'eligible',
    compressed: Number(result?.compressed) || 0,
    clusters: Number(result?.clusters) || 0,
  };
}

/**
 * 压缩符合条件的旧记忆。loadCandidates/summarize/insertSummary/linkCluster
 * 均可注入；默认实现走 Supabase + 项目 LLM。
 */
export async function compressEpisodeClusters(
  userId,
  companionId = 'default',
  opts = {},
) {
  if (!userId) return { compressed: 0, clusters: 0 };
  const policy = { ...DEFAULT_COMPRESSION_POLICY, ...opts };
  const now = timeMs(opts.now ?? Date.now());
  if (!Number.isFinite(now)) return { compressed: 0, clusters: 0 };

  const candidates =
    typeof opts.loadCandidates === 'function'
      ? await opts.loadCandidates({ userId, companionId, now, policy })
      : await loadCandidates(userId, companionId, now, policy, opts.client ?? supabase);
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { compressed: 0, clusters: 0 };
  }

  const summarize =
    typeof opts.summarize === 'function'
      ? opts.summarize
      : (cluster) =>
          summarizeCluster(cluster, {
            llmClient: opts.llmClient ?? llm,
            model: opts.model ?? LLM_MODEL,
          });
  const insertSummary =
    typeof opts.insertSummary === 'function'
      ? opts.insertSummary
      : (record) => defaultInsertSummary(record, opts.client ?? supabase);
  const linkCluster =
    typeof opts.linkCluster === 'function'
      ? opts.linkCluster
      : (ids, summaryId) =>
          defaultLinkCluster(ids, summaryId, opts.client ?? supabase);
  const embedFn = opts.embedFn ?? embed;

  let totalCompressed = 0;
  let totalClusters = 0;
  const maxItemsPerCluster = Math.max(
    policy.minCluster,
    Number(policy.maxItemsPerCluster) || 30,
  );
  const clusters = clusterCompressionCandidates(candidates).flatMap(
    (cluster) => {
      const chunks = [];
      for (let index = 0; index < cluster.length; index += maxItemsPerCluster) {
        chunks.push(cluster.slice(index, index + maxItemsPerCluster));
      }
      return chunks;
    },
  );
  for (const cluster of clusters) {
    if (cluster.length < policy.minCluster) continue;
    if (totalClusters >= policy.maxClusters) break;

    try {
      const summaryText = String((await summarize(cluster)) ?? '').trim();
      if (!summaryText) continue;
      const record = await buildSummaryRecord(
        userId,
        companionId,
        cluster,
        summaryText,
        now,
        embedFn,
      );
      const inserted = await insertSummary(record);
      if (!inserted?.id) continue;
      const linked = await linkCluster(
        cluster.map((memory) => memory.id),
        inserted.id,
      );
      if (linked === false) continue;
      totalCompressed += cluster.length;
      totalClusters += 1;
    } catch {
      // 单个 cluster 失败不影响其余 cluster；原 episode 始终保留。
    }
  }
  return { compressed: totalCompressed, clusters: totalClusters };
}

async function loadCandidates(userId, companionId, now, policy, client) {
  const cutoff = new Date(now - policy.minAgeDays * DAY).toISOString();
  const { data, error } = await client
    .from('memories')
    .select(
      'id,type,content,fact_core,created_at,affect_valence,affect_intensity,subject_kind,importance',
    )
    .eq('user_id', userId)
    .eq('companion_id', companionId)
    .in('type', ['episode', 'fact'])
    .is('superseded_by', null)
    .lt('created_at', cutoff)
    .order('created_at', { ascending: true })
    .limit(policy.scanLimit);
  if (error) throw error;
  return data ?? [];
}

async function summarizeCluster(cluster, { llmClient, model }) {
  const lines = cluster
    .map((memory) => `- ${memory.fact_core ?? memory.content ?? ''}`)
    .filter((line) => line.length > 2);
  if (!lines.length) return null;
  const response = await llmClient.chat.completions.create({
    model,
    temperature: 0.4,
    max_tokens: 120,
    messages: [
      { role: 'system', content: COMPRESS_SYS },
      { role: 'user', content: lines.join('\n') },
    ],
  });
  return response.choices?.[0]?.message?.content?.trim() || null;
}

async function buildSummaryRecord(
  userId,
  companionId,
  cluster,
  summaryText,
  now,
  embedFn,
) {
  const avgValence =
    cluster.reduce(
      (sum, memory) => sum + (Number(memory.affect_valence) || 0),
      0,
    ) / cluster.length;
  const avgIntensity =
    cluster.reduce(
      (sum, memory) => sum + (Number(memory.affect_intensity) || 0),
      0,
    ) / cluster.length;
  const maxImportance = Math.max(
    ...cluster.map((memory) => Number(memory.importance) || 3),
  );
  const clusterKey = dedupHash(
    `memory-compression:v1:${[...cluster]
      .map((memory) => memory.id)
      .sort()
      .join('|')}`,
  );
  return {
    user_id: userId,
    companion_id: companionId,
    type: 'reflection',
    content: summaryText,
    fact_core: summaryText,
    narrative: summaryText,
    subject_kind: cluster[0]?.subject_kind ?? 'user',
    affect_valence: avgValence,
    affect_intensity: avgIntensity,
    affect_origin_valence: avgValence,
    affect_origin_intensity: avgIntensity,
    importance: Math.min(8, maxImportance + 1),
    emotion: avgIntensity,
    embedding: await Promise.resolve(embedFn(summaryText)).catch(() => null),
    dedup_hash: clusterKey,
    source: {
      kind: 'memory_compression',
      version: 1,
      cluster_key: clusterKey,
      source_ids: cluster.map((memory) => memory.id),
    },
    created_at: new Date(now).toISOString(),
  };
}

async function defaultInsertSummary(record, client) {
  const { data, error } = await client
    .from('memories')
    .insert(record)
    .select('id')
    .single();
  if (!error) return data;
  if (error.code !== '23505') throw error;
  const existing = await client
    .from('memories')
    .select('id')
    .eq('user_id', record.user_id)
    .eq('companion_id', record.companion_id)
    .eq('dedup_hash', record.dedup_hash)
    .maybeSingle();
  if (existing.error) throw existing.error;
  return existing.data ?? null;
}

async function defaultLinkCluster(ids, summaryId, client) {
  const { error } = await client
    .from('memories')
    .update({ superseded_by: summaryId })
    .in('id', ids)
    .is('superseded_by', null);
  if (error) throw error;
  return true;
}

function timeMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (value == null || value === '') return NaN;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : NaN;
}
