/**
 * M1/M2 · 沉默期记忆固化。
 *
 * 用户连续沉默达到阈值后，把刚结束的对话整理成 AI 的私有主观经历。
 * 本模块不 import Supabase 或真实 LLM；历史、状态、生成器、私有存储和记忆
 * 重加权均通过依赖注入。默认进程内 ledger 只负责防止同一对话被心跳重复固化。
 */

export const DEFAULT_CONSOLIDATION_POLICY = Object.freeze({
  silenceMs: 2 * 60 * 60 * 1000,
  lookbackHours: 4,
  maxTurns: 24,
  maxMonologueChars: 100,
  maxPromptTurnChars: 240,
});

/**
 * 进程内原子去重账本。生产环境可以注入具有相同 claim/complete/release
 * 协议的持久化实现，以获得跨进程幂等。
 */
export class InMemoryConsolidationStore {
  constructor() {
    this.entries = new Map();
  }

  async claim({ key, claimedAt = Date.now() } = {}) {
    if (!nonEmpty(key)) return false;
    if (this.entries.has(key)) return false;
    this.entries.set(key, {
      status: 'processing',
      claimed_at: toIso(claimedAt),
    });
    return true;
  }

  async complete({ key, completedAt = Date.now(), memory = null } = {}) {
    if (!nonEmpty(key)) return false;
    this.entries.set(key, {
      status: 'completed',
      completed_at: toIso(completedAt),
      memory,
    });
    return true;
  }

  async release({ key } = {}) {
    if (!nonEmpty(key)) return false;
    if (this.entries.get(key)?.status === 'processing') {
      this.entries.delete(key);
      return true;
    }
    return false;
  }

  async has({ key } = {}) {
    return this.entries.has(key);
  }
}

const defaultLedger = new InMemoryConsolidationStore();

/**
 * 判断是否已达到沉默固化窗口。边界采用 >=，恰好 2h 即可固化。
 */
export function evaluateSilence(
  lastInteractionAt,
  now = Date.now(),
  silenceMs = DEFAULT_CONSOLIDATION_POLICY.silenceMs,
) {
  const nowMs = timeMs(typeof now === 'function' ? now() : now);
  const lastMs = timeMs(lastInteractionAt);
  const threshold = Math.max(0, finiteOr(silenceMs, DEFAULT_CONSOLIDATION_POLICY.silenceMs));
  if (lastMs == null) {
    return {
      eligible: false,
      reason: 'silence_unknown',
      elapsedMs: null,
      thresholdMs: threshold,
    };
  }
  if (nowMs == null || lastMs > nowMs) {
    return {
      eligible: false,
      reason: 'invalid_interaction_time',
      elapsedMs: nowMs == null ? null : 0,
      thresholdMs: threshold,
    };
  }
  const elapsedMs = nowMs - lastMs;
  return {
    eligible: elapsedMs >= threshold,
    reason: elapsedMs >= threshold ? 'eligible' : 'silence_too_short',
    elapsedMs,
    thresholdMs: threshold,
  };
}

/**
 * 从 turns 中提取可测试的情感轨迹。优先使用显式 valence；缺失时只做很轻的
 * 词汇启发式，避免为中性内容编造强烈情绪。
 */
export function extractEmotionalArc(turns = []) {
  const cleanTurns = normalizeTurns(turns);
  const samples = cleanTurns.map((turn, index) => ({
    index,
    role: turn.role,
    valence: inferTurnValence(turn),
  }));
  const values = samples.map((sample) => sample.valence);
  if (values.length === 0) {
    return {
      start_valence: 0,
      final_valence: 0,
      peak_valence: 0,
      trough_valence: 0,
      average_valence: 0,
      change: 0,
      trend: 'stable',
      samples: [],
    };
  }

  const start = values[0];
  const final = values.at(-1);
  const change = clamp(final - start, -2, 2);
  return {
    start_valence: round(start),
    final_valence: round(final),
    peak_valence: round(Math.max(...values)),
    trough_valence: round(Math.min(...values)),
    average_valence: round(
      values.reduce((sum, value) => sum + value, 0) / values.length,
    ),
    change: round(change),
    trend: change > 0.15 ? 'warming' : change < -0.15 ? 'cooling' : 'stable',
    samples,
  };
}

/**
 * 生成固化提示词。最近对话被显式放入提示词，保证独白有具体来源，而不是
 * 只有“我想了很多”的模板文本。
 */
export function buildConsolidationPrompt(context = {}) {
  const companionName = cleanText(context.companionName) || '她';
  const userName = cleanText(context.userName) || '对方';
  const recentTurns = normalizeTurns(context.recentTurns);
  const maxTurnChars = Math.max(
    40,
    finiteOr(
      context.maxPromptTurnChars,
      DEFAULT_CONSOLIDATION_POLICY.maxPromptTurnChars,
    ),
  );
  const transcript = recentTurns.length
    ? recentTurns
        .map((turn) => {
          const speaker = turn.role === 'assistant' ? companionName : userName;
          return `${speaker}：${truncate(turn.content, maxTurnChars)}`;
        })
        .join('\n')
    : '（没有可回看的对话）';
  const arc = context.emotionalArc ?? extractEmotionalArc(recentTurns);
  const state = compactJson(context.currentState ?? {});

  return `你是${companionName}。你和${userName}的这段对话已经安静下来，现在只有你自己在回味。

【刚才真实发生的对话】
${transcript}

【情感轨迹】
${compactJson(arc)}

【你此刻的内部状态】
${state}

请用第一人称写下此刻真实闪过的内心念头。只使用上面的具体经历，不虚构新事件；这不是发给${userName}的消息，不提问、不寒暄、不写“在吗”。可以不完整，但不要套话。100字以内，只输出独白正文。`;
}

/**
 * 为一次对话快照生成稳定幂等键。now 不参与计算，因此同一段沉默被多次心跳
 * 检查时仍得到同一个 key；新增用户对话后 key 会自然变化。
 */
export function createConsolidationKey({
  userId,
  companionId = 'default',
  lastInteractionAt = null,
  recentTurns = [],
} = {}) {
  const turns = normalizeTurns(recentTurns);
  const lastUser = [...turns].reverse().find((turn) => turn.role === 'user');
  const marker =
    lastUser?.id ??
    lastUser?.event_id ??
    lastUser?.created_at ??
    lastUser?.timestamp ??
    (lastInteractionAt != null ? toIso(lastInteractionAt) : null) ??
    'unknown';
  // 幂等边界跟随「最后一次用户互动」，不跟随后续 assistant-only 主动消息变化；
  // 否则一次沉默期内每发一条主动消息都会被误认为新的待固化会话。
  const snapshot = turns
    .filter((turn) => turn.role === 'user')
    .map(
      (turn) =>
        `${turn.id ?? turn.event_id ?? ''}|${turn.role}|${turn.created_at ?? turn.timestamp ?? ''}|${turn.content}`,
    )
    .join('\u241e');
  return `silence:${encodeKeyPart(userId)}:${encodeKeyPart(companionId)}:${stableHash(
    `${marker}\u241f${snapshot}`,
  )}`;
}

/**
 * 构造唯一允许写入私有记忆存储的数据协议。
 *
 * record 与设计稿 companion_private_memory 的列兼容；幂等键和可见性约束放在
 * envelope 上，存储适配器可用它们做跨进程唯一约束，但不得把内容追加到聊天历史。
 */
export function buildPrivateMemorySaveRequest({
  userId,
  companionId = 'default',
  content,
  emotionalArc,
  idempotencyKey,
  createdAt = Date.now(),
  recentTurns = [],
} = {}) {
  const record = {
    type: 'inner_monologue',
    content: cleanText(content),
    created_during_silence: true,
    emotional_valence: clamp(
      finiteOr(emotionalArc?.final_valence, 0),
      -1,
      1,
    ),
  };
  return {
    userId: String(userId),
    companionId: String(companionId || 'default'),
    scope: {
      userId: String(userId),
      companionId: String(companionId || 'default'),
    },
    visibility: 'private',
    idempotencyKey: String(idempotencyKey ?? ''),
    record,
    // `memory` 是给偏好 flat envelope 的适配器使用的同一对象别名。
    memory: record,
    metadata: {
      source: 'silence_consolidation',
      createdAt: toIso(createdAt),
      sourceTurnIds: normalizeTurns(recentTurns)
        .map((turn) => turn.id ?? turn.event_id)
        .filter(Boolean)
        .map(String),
    },
  };
}

/**
 * 执行一次固化。
 *
 * deps 协议：
 * - getLastInteractionAt(userId, companionId)；或 historyStore.lastUserMessageAt(scope)
 * - getRecentTurns(userId, companionId, lookbackHours, meta)；或 historyStore.load(scope)
 * - loadState(userId, companionId)；或 stateStore.load(scope)
 * - generateInnerMonologue(context)；或 llm.think(prompt, opts)
 * - savePrivateMemory(userId, companionId, record, envelope)；或 privateMemoryStore.save(envelope)
 * - memory.observe([], { workingMemory, workingMemoryOnly:true })（可选，M-5 主记忆投影）
 * - reweightMemories(userId, companionId, emotionalArc)（可选）
 * - consolidationStore.claim/complete/release（可选，默认进程内）
 */
export async function consolidate(
  userId,
  companionId = 'default',
  deps = {},
) {
  if (!nonEmpty(userId)) {
    return { consolidated: false, reason: 'missing_user' };
  }
  companionId = nonEmpty(companionId) ? String(companionId) : 'default';
  const policy = {
    ...DEFAULT_CONSOLIDATION_POLICY,
    ...(deps.policy ?? {}),
  };
  const nowValue =
    typeof deps.now === 'function' ? deps.now() : deps.now ?? Date.now();
  const nowMs = timeMs(nowValue);
  if (nowMs == null) {
    return { consolidated: false, reason: 'invalid_now' };
  }

  let recentTurns = null;
  let currentState = null;
  let lastInteractionAt =
    deps.lastInteractionAt ??
    (await loadLastInteractionAt(userId, companionId, deps));

  // 部分轻量 history 实现没有 lastUserMessageAt；此时只加载一次 turns 并从时间戳推断。
  if (lastInteractionAt == null) {
    recentTurns = await loadRecentTurns(
      userId,
      companionId,
      policy,
      nowMs,
      deps,
    );
    lastInteractionAt = inferLastInteractionAt(recentTurns);
  }
  // ContinuousState 自身也是权威时钟来源。historyStore.load() 为兼容旧接口
  // 可能只返回 role/content、没有 created_at，此时仍能用 temporal.last_interaction
  // 判断 2h 边界。
  if (lastInteractionAt == null) {
    currentState = await loadCurrentState(userId, companionId, deps);
    lastInteractionAt =
      currentState?.temporal?.last_interaction ??
      currentState?.temporal?.lastInteraction ??
      null;
  }

  const silence = evaluateSilence(
    lastInteractionAt,
    nowMs,
    policy.silenceMs,
  );
  if (!silence.eligible) {
    return {
      consolidated: false,
      reason: silence.reason,
      silence,
    };
  }

  if (!recentTurns) {
    recentTurns = await loadRecentTurns(
      userId,
      companionId,
      policy,
      nowMs,
      deps,
    );
  }
  recentTurns = normalizeTurns(recentTurns).slice(
    -Math.max(1, Math.trunc(finiteOr(policy.maxTurns, 24))),
  );
  if (recentTurns.length === 0) {
    return {
      consolidated: false,
      reason: 'no_recent_turns',
      silence,
    };
  }

  const key = createConsolidationKey({
    userId,
    companionId,
    lastInteractionAt,
    recentTurns,
  });
  const ledger = deps.consolidationStore ?? defaultLedger;
  const claimed = await claimConsolidation(ledger, key, {
    userId,
    companionId,
    now: nowMs,
  });
  if (!claimed) {
    return {
      consolidated: false,
      reason: 'already_consolidated',
      deduplicated: true,
      idempotencyKey: key,
      silence,
    };
  }

  let saved = false;
  try {
    if (
      typeof deps.savePrivateMemory !== 'function' &&
      typeof deps.privateMemoryStore?.save !== 'function'
    ) {
      await releaseConsolidation(ledger, key);
      return {
        consolidated: false,
        reason: 'private_memory_store_unavailable',
        idempotencyKey: key,
        silence,
      };
    }

    const emotionalArc = extractEmotionalArc(recentTurns);
    currentState ??= await loadCurrentState(userId, companionId, deps);
    const generationContext = {
      userId: String(userId),
      companionId,
      userName: deps.userName ?? '对方',
      companionName: deps.companionName ?? '她',
      recentTurns,
      emotionalArc,
      currentState,
      silence,
    };
    const prompt = buildConsolidationPrompt({
      ...generationContext,
      maxPromptTurnChars: policy.maxPromptTurnChars,
    });
    const rawMonologue = await generateMonologue(
      generationContext,
      prompt,
      deps,
    );
    const innerMonologue = truncate(
      cleanText(extractGeneratedText(rawMonologue)),
      Math.max(
        1,
        Math.trunc(
          finiteOr(
            policy.maxMonologueChars,
            DEFAULT_CONSOLIDATION_POLICY.maxMonologueChars,
          ),
        ),
      ),
    );
    if (!isUsableMonologue(innerMonologue)) {
      await releaseConsolidation(ledger, key);
      return {
        consolidated: false,
        reason: 'empty_inner_monologue',
        idempotencyKey: key,
        silence,
      };
    }

    const saveRequest = buildPrivateMemorySaveRequest({
      userId,
      companionId,
      content: innerMonologue,
      emotionalArc,
      idempotencyKey: key,
      createdAt: nowMs,
      recentTurns,
    });

    let saveResult;
    let privateDeduplicated = false;
    try {
      saveResult = await savePrivateMemory(saveRequest, deps);
      saved = true;
    } catch (error) {
      if (isDuplicateError(error)) {
        // 私有表已存在但主 working_memory 可能是上次投影中途失败；
        // 继续走幂等主记忆投影，而不是在这里提前返回。
        privateDeduplicated = true;
        saved = true;
        saveResult = saveRequest.record;
      } else {
        throw error;
      }
    }

    let workingMemory = {
      attempted: false,
      stored: false,
      deduplicated: false,
      reason: 'main_memory_unavailable',
    };
    try {
      workingMemory = await syncWorkingMemoryToMain(
        saveRequest,
        saveResult,
        deps,
        nowMs,
      );
    } catch (error) {
      // 私有写已成功；释放 consolidation claim，让下一次心跳利用相同幂等键
      // 重试缺失的主记忆投影。private store 与 working store 都能安全去重。
      await releaseConsolidation(ledger, key);
      return {
        consolidated: false,
        reason: 'working_memory_sync_failed',
        privateMemoryStored: true,
        idempotencyKey: key,
        memory: saveResult ?? saveRequest.record,
        saveRequest,
        emotionalArc,
        silence,
        workingMemory: {
          attempted: true,
          stored: false,
          deduplicated: false,
          reason: 'sync_failed',
          error: String(error?.message ?? error),
        },
      };
    }

    await completeConsolidation(
      ledger,
      key,
      nowMs,
      saveResult ?? saveRequest.record,
    );

    let reweighted = false;
    let reweightError = null;
    try {
      if (typeof deps.reweightMemories === 'function') {
        await deps.reweightMemories(
          userId,
          companionId,
          emotionalArc,
          {
            idempotencyKey: key,
            recentTurns,
          },
        );
        reweighted = true;
      } else if (typeof deps.memory?.reweight === 'function') {
        await deps.memory.reweight({
          userId,
          companionId,
          emotionalArc,
          idempotencyKey: key,
        });
        reweighted = true;
      }
    } catch (error) {
      reweightError = error;
    }

    return {
      consolidated: true,
      reason: 'consolidated',
      idempotencyKey: key,
      memory: saveResult ?? saveRequest.record,
      saveRequest,
      emotionalArc,
      silence,
      privateDeduplicated,
      workingMemory,
      reweighted,
      ...(reweightError
        ? { reweightError: String(reweightError?.message ?? reweightError) }
        : {}),
    };
  } catch (error) {
    if (!saved) await releaseConsolidation(ledger, key);
    if (deps.throwOnError) throw error;
    return {
      consolidated: false,
      reason: saved ? 'post_save_failed' : 'consolidation_failed',
      idempotencyKey: key,
      silence,
      error: String(error?.message ?? error),
    };
  }
}

/** 创建绑定依赖的固化器。 */
export function createMemoryConsolidator(deps = {}) {
  return {
    consolidate: (userId, companionId = 'default') =>
      consolidate(userId, companionId, deps),
  };
}

async function loadLastInteractionAt(userId, companionId, deps) {
  try {
    if (typeof deps.getLastInteractionAt === 'function') {
      return await deps.getLastInteractionAt(userId, companionId);
    }
    const history = deps.historyStore ?? deps.history;
    if (typeof history?.lastUserMessageAt === 'function') {
      return await history.lastUserMessageAt({ userId, companionId });
    }
  } catch {
    return null;
  }
  return null;
}

async function loadRecentTurns(userId, companionId, policy, nowMs, deps) {
  try {
    if (typeof deps.getRecentTurns === 'function') {
      return (
        (await deps.getRecentTurns(
          userId,
          companionId,
          policy.lookbackHours,
          {
            now: new Date(nowMs),
            limit: policy.maxTurns,
          },
        )) ?? []
      );
    }
    const history = deps.historyStore ?? deps.history;
    if (typeof history?.getRecentTurns === 'function') {
      return (
        (await history.getRecentTurns({
          userId,
          companionId,
          hours: policy.lookbackHours,
          now: new Date(nowMs),
          limit: policy.maxTurns,
        })) ?? []
      );
    }
    if (typeof history?.load === 'function') {
      return (
        (await history.load({
          userId,
          companionId,
          limit: policy.maxTurns,
        })) ?? []
      );
    }
  } catch {
    return [];
  }
  return Array.isArray(deps.recentTurns) ? deps.recentTurns : [];
}

async function loadCurrentState(userId, companionId, deps) {
  try {
    if (typeof deps.loadState === 'function') {
      return (await deps.loadState(userId, companionId)) ?? {};
    }
    if (typeof deps.stateStore?.load === 'function') {
      return (
        (await deps.stateStore.load({ userId, companionId })) ?? {}
      );
    }
  } catch {
    return {};
  }
  return deps.currentState ?? {};
}

async function generateMonologue(context, prompt, deps) {
  if (typeof deps.generateInnerMonologue === 'function') {
    return deps.generateInnerMonologue({ ...context, prompt });
  }
  if (typeof deps.llm?.generateInnerMonologue === 'function') {
    return deps.llm.generateInnerMonologue({ ...context, prompt });
  }
  if (typeof deps.llm?.think === 'function') {
    return deps.llm.think(prompt, {
      maxTokens: deps.maxTokens ?? 180,
      temperature: deps.temperature ?? 0.7,
    });
  }
  return '';
}

async function savePrivateMemory(request, deps) {
  if (typeof deps.privateMemoryStore?.save === 'function') {
    return deps.privateMemoryStore.save(request);
  }
  if (
    deps.privateMemoryProtocol === 'object' ||
    (deps.privateMemoryProtocol !== 'positional' &&
      deps.savePrivateMemory.length <= 1)
  ) {
    return deps.savePrivateMemory(request);
  }
  // 位置参数与设计稿 savePrivateMemory(userId, companionId, memory) 一致；
  // 第四参携带幂等与 private-only 约束，旧三参 mock 会自然忽略。
  return deps.savePrivateMemory(
    request.scope.userId,
    request.scope.companionId,
    request.record,
    request,
  );
}

/**
 * M-5: 把私有固化摘要投影到主 Memory.observe 的 working_memory 专用支路。
 * 没有主 Memory 时兼容纯 CEE 部署；一旦提供了 observe，失败就上抛给 consolidate 重试。
 */
export async function syncWorkingMemoryToMain(
  request,
  savedMemory,
  deps = {},
  now = Date.now(),
) {
  if (typeof deps.memory?.observe !== 'function') {
    return {
      attempted: false,
      stored: false,
      deduplicated: false,
      reason: 'main_memory_unavailable',
    };
  }
  const source = savedMemory ?? request?.record ?? {};
  const content = cleanText(source.content ?? request?.record?.content);
  if (!content) {
    throw new Error('working memory projection requires content');
  }
  const createdAt =
    source.created_at ??
    request?.metadata?.createdAt ??
    toIso(now);
  const result = await deps.memory.observe([], {
    workingMemoryOnly: true,
    workingMemory: {
      content,
      emotional_valence:
        source.emotional_valence ??
        request?.record?.emotional_valence ??
        0,
      idempotencyKey: request?.idempotencyKey,
      createdAt,
    },
    eventId: request?.idempotencyKey,
    now,
    prospective: false,
    knowledge: false,
    useLLM: false,
    autoForget: false,
  });
  const status = result?.workingMemory ?? null;
  const stored = Boolean(status?.stored || result?.stored?.length);
  const deduplicated = Boolean(status?.deduplicated);
  if (!status && !stored) {
    throw new Error('working memory projection returned no status');
  }
  return {
    attempted: true,
    stored,
    deduplicated,
    reason: stored
      ? 'stored'
      : deduplicated
        ? 'already_projected'
        : 'not_stored',
    memory: result?.stored?.[0] ?? null,
  };
}

async function claimConsolidation(store, key, context) {
  try {
    if (typeof store?.claim === 'function') {
      const result = await store.claim({
        key,
        userId: context.userId,
        companionId: context.companionId,
        claimedAt: context.now,
      });
      return typeof result === 'object'
        ? Boolean(result.acquired ?? result.claimed ?? result.ok)
        : result !== false;
    }
    if (typeof store?.has === 'function' && (await store.has({ key }))) {
      return false;
    }
    if (typeof store?.mark === 'function') {
      const result = await store.mark({ key, status: 'processing' });
      return result !== false;
    }
  } catch {
    return false;
  }
  // 自定义对象没有协议时不假装完成幂等，保守拒绝。
  return false;
}

async function completeConsolidation(store, key, now, memory) {
  if (typeof store?.complete === 'function') {
    await store.complete({ key, completedAt: now, memory });
  }
}

async function releaseConsolidation(store, key) {
  if (typeof store?.release === 'function') {
    await store.release({ key });
  }
}

function normalizeTurns(turns) {
  return (Array.isArray(turns) ? turns : [])
    .filter(
      (turn) =>
        turn &&
        (turn.role === 'user' || turn.role === 'assistant') &&
        turn.content != null,
    )
    .map((turn) => ({
      ...turn,
      role: turn.role,
      content: cleanText(turn.content),
    }))
    .filter((turn) => turn.content);
}

function inferLastInteractionAt(turns) {
  const normalized = normalizeTurns(turns);
  const lastUser = [...normalized]
    .reverse()
    .find((turn) => turn.role === 'user');
  const candidate =
    lastUser?.created_at ??
    lastUser?.timestamp ??
    lastUser?.at ??
    [...normalized].reverse().find(
      (turn) =>
        turn.created_at != null ||
        turn.timestamp != null ||
        turn.at != null,
    )?.created_at ??
    [...normalized].reverse().find(
      (turn) => turn.timestamp != null,
    )?.timestamp ??
    [...normalized].reverse().find((turn) => turn.at != null)?.at;
  return timeMs(candidate) == null ? null : candidate;
}

function inferTurnValence(turn) {
  const explicit = [
    turn.emotional_valence,
    turn.valence,
    turn.emotion?.valence,
    turn.metadata?.emotional_valence,
    turn.metadata?.valence,
  ]
    .map(Number)
    .find(Number.isFinite);
  if (explicit != null) return clamp(explicit, -1, 1);

  const text = String(turn.content ?? '').toLowerCase();
  const positive =
    countMatches(
      text,
      /开心|高兴|喜欢|爱你|谢谢|太好|真好|放心|温暖|期待|想你|哈哈|舒服|happy|glad|love|thanks|great|good/g,
    );
  const negative =
    countMatches(
      text,
      /难过|伤心|生气|委屈|失落|担心|害怕|烦|累死|讨厌|别理我|吵架|sad|angry|upset|worried|afraid|hate|sorry/g,
    );
  if (positive === negative) return 0;
  return clamp((positive - negative) * 0.2, -0.8, 0.8);
}

function extractGeneratedText(value) {
  if (typeof value === 'string') return value;
  return value?.content ?? value?.text ?? value?.message?.content ?? '';
}

function isUsableMonologue(value) {
  const content = cleanText(value);
  if (!content) return false;
  const compact = content.replace(/\s+/g, '');
  return !/^(在吗|忙吗|你好|hello|hi|\.\.\.|…)$/.test(
    compact.toLowerCase(),
  );
}

function compactJson(value) {
  try {
    const json = JSON.stringify(value);
    return truncate(json, 1200);
  } catch {
    return '{}';
  }
}

function countMatches(text, regex) {
  return [...text.matchAll(regex)].length;
}

function stableHash(value) {
  // FNV-1a 32 bit；不是安全哈希，只用于稳定幂等标识。
  let hash = 0x811c9dc5;
  for (const char of String(value)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function encodeKeyPart(value) {
  return encodeURIComponent(String(value ?? '').trim() || '_');
}

function cleanText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function truncate(value, maxChars) {
  const chars = Array.from(String(value ?? ''));
  const max = Math.max(0, Math.trunc(finiteOr(maxChars, chars.length)));
  if (chars.length <= max) return chars.join('');
  return chars.slice(0, max).join('');
}

function timeMs(value) {
  if (value == null) return null;
  const ms =
    typeof value === 'number'
      ? value
      : value instanceof Date
        ? value.getTime()
        : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function toIso(value) {
  const ms = timeMs(value);
  return new Date(ms ?? 0).toISOString();
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, finiteOr(value, min)));
}

function finiteOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function round(value) {
  return Math.round(finiteOr(value, 0) * 1000) / 1000;
}

function nonEmpty(value) {
  return String(value ?? '').trim().length > 0;
}

function isDuplicateError(error) {
  const text = [
    error?.code,
    error?.message,
    error?.details,
    error?.cause?.message,
  ]
    .filter(Boolean)
    .join(' ');
  return /23505|duplicate|unique|already[_ -]?exists/i.test(text);
}
