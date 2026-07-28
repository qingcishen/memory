export const TURN_PIPELINE_VERSION = 1;

export const TURN_STAGES = Object.freeze([
  'perceive',
  'interpret',
  'retrieve',
  'deliberate',
  'compose',
  'validate',
  'commit',
]);

const WRITE_STAGE = 'commit';

/**
 * 创建一次 turn 的不可歧义上下文。阶段通过 patch 返回新字段，不原地修改调用方输入。
 */
export function createTurnContext(input = {}) {
  const now = Number(input.now ?? Date.now());
  const eventId = String(input.eventId || input.turnId || makeTurnId(now));
  return {
    version: TURN_PIPELINE_VERSION,
    turnId: String(input.turnId || eventId),
    eventId,
    userId: String(input.userId || ''),
    companionId: String(input.companionId || 'default'),
    userMessage: String(input.userMessage ?? ''),
    historyUserMessage: String(input.historyUserMessage ?? input.userMessage ?? ''),
    startedAt: Number(input.startedAt ?? now),
    now,
    options: { ...(input.options ?? {}) },
    perception: input.perception ?? null,
    interpretation: input.interpretation ?? null,
    evidence: input.evidence ?? null,
    decision: input.decision ?? null,
    composition: input.composition ?? null,
    validation: input.validation ?? null,
    commit: input.commit ?? null,
    stageResults: { ...(input.stageResults ?? {}) },
    diagnostics: {
      warnings: [...(input.diagnostics?.warnings ?? [])],
      errors: [...(input.diagnostics?.errors ?? [])],
    },
  };
}

/**
 * 七阶段通用运行器。handler(ctx, tools) 返回 patch 或 { patch, warnings }。
 * 默认按契约降级；compose/perceive 失败会终止。
 */
export async function runTurnPipeline(input, handlers, opts = {}) {
  let context = createTurnContext(input);
  const onStage = typeof opts.onStage === 'function' ? opts.onStage : null;

  for (const stage of TURN_STAGES) {
    const handler = handlers?.[stage];
    if (typeof handler !== 'function') {
      const result = stageResult(stage, 'skipped', Date.now(), Date.now(), {}, [], null);
      context = applyStageResult(context, result);
      onStage?.(result, context);
      continue;
    }

    const startedAt = Date.now();
    try {
      const raw = await handler(context, stageTools(stage));
      const normalized = normalizeHandlerResult(raw);
      const result = stageResult(
        stage,
        normalized.status,
        startedAt,
        Date.now(),
        normalized.patch,
        normalized.warnings,
        null,
      );
      context = applyStageResult(context, result);
      onStage?.(result, context);
    } catch (error) {
      const safeError = serializeStageError(error);
      const canDegrade = opts.degradable?.[stage] ?? defaultDegradable(stage);
      const result = stageResult(
        stage,
        canDegrade ? 'degraded' : 'failed',
        startedAt,
        Date.now(),
        {},
        [],
        safeError,
      );
      context = applyStageResult(context, result);
      onStage?.(result, context);
      if (!canDegrade) {
        const pipelineError = new Error(`${stage} stage failed: ${safeError.message}`);
        pipelineError.name = 'TurnPipelineError';
        pipelineError.stage = stage;
        pipelineError.cause = error;
        pipelineError.context = context;
        throw pipelineError;
      }
    }
  }

  return context;
}

/** 渐进迁移入口：在现有 Orchestrator 中一次迁入一个阶段，同时复用完整错误语义。 */
export async function runTurnStage(input, stage, handler, opts = {}) {
  if (!TURN_STAGES.includes(stage)) throw new Error(`Unknown turn stage: ${stage}`);
  let output = null;
  const handlers = { [stage]: handler };
  const context = createTurnContext(input);
  const startedAt = Date.now();
  try {
    const raw = await handlers[stage](context, stageTools(stage));
    const normalized = normalizeHandlerResult(raw);
    output = stageResult(
      stage,
      normalized.status,
      startedAt,
      Date.now(),
      normalized.patch,
      normalized.warnings,
      null,
    );
  } catch (error) {
    const safeError = serializeStageError(error);
    const canDegrade = opts.degradable ?? defaultDegradable(stage);
    output = stageResult(
      stage,
      canDegrade ? 'degraded' : 'failed',
      startedAt,
      Date.now(),
      {},
      [],
      safeError,
    );
    const degraded = applyStageResult(context, output);
    opts.onStage?.(output, degraded);
    if (!canDegrade) {
      const pipelineError = new Error(`${stage} stage failed: ${safeError.message}`);
      pipelineError.name = 'TurnPipelineError';
      pipelineError.stage = stage;
      pipelineError.cause = error;
      pipelineError.context = degraded;
      throw pipelineError;
    }
    return degraded;
  }
  const next = applyStageResult(context, output);
  opts.onStage?.(output, next);
  return next;
}

export function summarizePipeline(context) {
  return {
    pipelineVersion: context?.version ?? TURN_PIPELINE_VERSION,
    turnId: context?.turnId ?? null,
    eventId: context?.eventId ?? null,
    stages: TURN_STAGES.map((stage) => {
      const result = context?.stageResults?.[stage];
      return {
        stage,
        status: result?.status ?? 'skipped',
        latencyMs: result?.latencyMs ?? 0,
        warningCodes: (result?.warnings ?? []).map((item) => item?.code).filter(Boolean),
        errorCode: result?.error?.code ?? null,
      };
    }),
    commitStatus: context?.stageResults?.commit?.status ?? 'skipped',
  };
}

export function isWriteStage(stage) {
  return stage === WRITE_STAGE;
}

function applyStageResult(context, result) {
  const diagnostics = {
    warnings: [...context.diagnostics.warnings],
    errors: [...context.diagnostics.errors],
  };
  diagnostics.warnings.push(
    ...result.warnings.map((warning) => ({ stage: result.stage, ...warning })),
  );
  if (result.error) diagnostics.errors.push({ stage: result.stage, ...result.error });
  return {
    ...context,
    ...result.patch,
    stageResults: { ...context.stageResults, [result.stage]: result },
    diagnostics,
  };
}

function normalizeHandlerResult(raw) {
  if (raw == null) return { status: 'ok', patch: {}, warnings: [] };
  if (raw.patch || raw.status || raw.warnings) {
    return {
      status: ['ok', 'degraded', 'skipped'].includes(raw.status) ? raw.status : 'ok',
      patch: plainObject(raw.patch),
      warnings: Array.isArray(raw.warnings) ? raw.warnings.map(normalizeWarning) : [],
    };
  }
  return { status: 'ok', patch: plainObject(raw), warnings: [] };
}

function stageResult(stage, status, startedAt, endedAt, patch, warnings, error) {
  return {
    stage,
    status,
    startedAt,
    endedAt,
    latencyMs: Math.max(0, endedAt - startedAt),
    patch,
    warnings,
    error,
  };
}

function stageTools(stage) {
  return Object.freeze({
    stage,
    canWrite: isWriteStage(stage),
    assertCanWrite() {
      if (!isWriteStage(stage)) {
        const error = new Error(`Long-term writes are only allowed in ${WRITE_STAGE}`);
        error.code = 'PIPELINE_WRITE_BOUNDARY';
        throw error;
      }
      return true;
    },
  });
}

function defaultDegradable(stage) {
  return !['perceive', 'compose'].includes(stage);
}

function serializeStageError(error) {
  return {
    name: String(error?.name || 'Error'),
    message: String(error?.message || 'unknown stage error').slice(0, 500),
    ...(error?.code ? { code: String(error.code) } : {}),
  };
}

function normalizeWarning(value) {
  if (typeof value === 'string') return { message: value };
  return {
    ...(value?.code ? { code: String(value.code) } : {}),
    message: String(value?.message || 'stage warning').slice(0, 500),
  };
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function makeTurnId(now) {
  return `turn_${now}_${Math.random().toString(36).slice(2, 10)}`;
}
