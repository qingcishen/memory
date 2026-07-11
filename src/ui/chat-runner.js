// 编排器试聊 runner: 控制台「试聊」页每条消息 spawn 一次本脚本。
//
// 为什么开子进程而不是在 ui server 里直接 import Orchestrator:
// src/config.js 在 import 时就固化 .env 凭证, 长驻的 ui server 会一直用旧配置;
// 子进程每次冷启动, 保证试聊永远用你刚保存的密钥。
//
// 组装方式与 src/telegram/bot.js 的 botForChat 保持一致 (人设/历史/天气/世界观/旁白),
// 所以这里聊出来的行为 = Telegram 上聊出来的行为, 可以放心当调试场用。
// 注意: 这是真实调用 —— 会调 LLM、写记忆库和状态表。
//
// 调试模式 (req.debug): 利用 Orchestrator 的依赖注入, 给各子系统包一层"探针"代理,
// 把召回记忆/状态快照/Prompt 分段/最终 messages/采样参数/内心独白原样截获,
// 不改任何核心代码; 探针只读不改, 行为与非调试模式完全一致 (recall 走的
// MemoryAdapter debug 分支返回 {block, hits}, block 与正常路径产物相同)。

import dotenv from 'dotenv';
dotenv.config();

// stdout 是和 ui server 的协议通道 (一行 JSON), 业务模块的 console.log (如 historyStore
// 的启动日志) 全部改道 stderr, 否则会污染协议、把好好的回复变成"runner 输出异常"。
console.log = (...args) => console.error(...args);

import { Orchestrator } from '../../index.js';
import { MemoryAdapter, StateLayerAdapter, RelationshipAdapter, PersonaAdapter } from '../orchestrator/adapters.js';
import { DefaultLLM } from '../orchestrator/llm.js';
import { loadPersonaConfig } from '../companion.js';
import { makeScheduleActivityFn } from '../state/activity.js';
import { inferEmotionLabel } from '../state/emotionLabel.js';
import { behaviorPolicy } from '../state/behavior.js';
import { WeatherProvider } from '../world/weather.js';
import { WorldDimension } from '../world/index.js';
import { SceneClassifier, buildNarrationPrompt } from '../narration.js';
import { createHistoryStore } from '../telegram/bot.js';
import { metricsSnapshot } from '../metrics.js';

/** 探针: 原样代理 target, 仅指定方法被替换 (替换实现里自己调用原方法)。 */
function tap(target, overrides) {
  return new Proxy(target, {
    get(t, prop) {
      if (prop in overrides) return overrides[prop];
      const v = Reflect.get(t, prop, t);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}

/** 去掉向量等大字段, 防止调试 payload 膨胀到没法看。 */
function slim(value) {
  return JSON.parse(
    JSON.stringify(value ?? null, (key, item) => {
      if (key === 'embedding' || key === 'media_embedding' || key === 'cue_embedding') return undefined;
      if (Array.isArray(item) && item.length > 200 && item.every((x) => typeof x === 'number')) return `[${item.length} 维向量]`;
      return item;
    }),
  );
}

async function main() {
  const req = JSON.parse(process.argv[2] ?? '{}');
  const userId = req.userId || 'ui:playground';
  const companionId = req.companionId || process.env.TELEGRAM_COMPANION_ID || 'default';
  const companionName = process.env.TELEGRAM_COMPANION_NAME || '小忆';
  const subjectName = process.env.TELEGRAM_SUBJECT_NAME || '你';
  const persona = loadPersonaConfig(`companions/${companionId}.json`);
  const debugMode = Boolean(req.debug);
  const trace = { promptParts: {} };

  const weather = new WeatherProvider({
    place: process.env.WEATHER_PLACE || '武汉',
    ...(process.env.WEATHER_LAT ? { lat: Number(process.env.WEATHER_LAT) } : {}),
    ...(process.env.WEATHER_LON ? { lon: Number(process.env.WEATHER_LON) } : {}),
  });
  const world = new WorldDimension({ userId, companionId });
  const narration = new SceneClassifier();

  let deps = { historyStore: createHistoryStore(), weather, world, narration };

  if (debugMode) {
    // 与 Orchestrator 构造器内部完全一致的组装顺序 (共享 LifeDimension), 只是外面包了探针。
    const stateLayer = new StateLayerAdapter(userId, companionId, null, {
      activityFn: persona?.life ? makeScheduleActivityFn(persona.life) : null,
      lifeConfig: persona?.life ?? null,
    });
    const memory = new MemoryAdapter({
      userId, companionId, subjectName, companionName,
      life: stateLayer.stateLayer?.life ?? null,
      desire: stateLayer.stateLayer?.desire ?? null,
    });
    const relationship = new RelationshipAdapter(userId, companionId);
    const personaAdapter = new PersonaAdapter({ userId, companionId, subjectName: companionName });
    const llm = new DefaultLLM();

    deps = {
      ...deps,
      stateLayer: tap(stateLayer, {
        snapshot: async () => {
          const s = await stateLayer.snapshot();
          if (!trace.stateSnapshot) trace.stateSnapshot = slim(s);
          return s;
        },
        toPrompt: (s) => {
          const p = stateLayer.toPrompt(s);
          trace.promptParts.state = p;
          return p;
        },
      }),
      memory: tap(memory, {
        recall: async (query, opts = {}) => {
          const r = await memory.recall(query, { ...opts, debug: true });
          trace.memoryHits = slim(r.hits ?? []).map((h) => ({
            id: h.id, type: h.type, subject_kind: h.subject_kind, content: h.content,
            similarity: h.similarity, activation: h.activation, score: h.score ?? h._score,
            importance: h.importance, lowConfidence: Boolean(h._lowConfidence), created_at: h.created_at,
          }));
          trace.promptParts.memoryBlock = r.block;
          if (r.knowledge) trace.promptParts.knowledge = r.knowledge;
          return r.block;
        },
      }),
      relationship: tap(relationship, {
        current: async () => {
          const s = await relationship.current();
          trace.relationshipState = slim(s);
          trace.emotionLabel = inferEmotionLabel(
            { ...(trace.stateSnapshot ?? {}), relationship: s?.relationship ?? s ?? {} },
            trace.stateSnapshot?.desires,
            [{ role: 'user', content: String(req.message ?? '') }]
          );
          trace.behaviorPolicy = behaviorPolicy(trace.emotionLabel, { relationship: s?.relationship ?? s ?? {} });
          return s;
        },
        toPrompt: (s) => {
          const p = relationship.toPrompt(s);
          trace.promptParts.relationship = p;
          return p;
        },
      }),
      persona: tap(personaAdapter, {
        toPrompt: () => {
          const p = personaAdapter.toPrompt();
          trace.promptParts.persona = p;
          return p;
        },
      }),
      world: tap(world, {
        current: async () => {
          const s = await world.current();
          trace.worldSnapshot = slim(s);
          return s;
        },
        toPrompt: (s) => {
          const p = world.toPrompt(s);
          trace.promptParts.world = p;
          return p;
        },
      }),
      narration: tap(narration, {
        classify: async (ctx) => {
          const sceneType = await narration.classify(ctx);
          trace.sceneType = sceneType;
          trace.promptParts.narration = buildNarrationPrompt(sceneType, persona?.config?.narrationDirectives);
          return sceneType;
        },
      }),
      weather: tap(weather, {
        current: async () => {
          const w = await weather.current();
          trace.promptParts.weather = w;
          return w;
        },
      }),
      llm: tap(llm, {
        think: async (ctx, opts) => {
          trace.monologueContext = ctx;
          const m = await llm.think(ctx, opts);
          trace.monologue = m;
          return m;
        },
        generateReply: async (messages, opts) => {
          trace.messages = messages;
          trace.samplingHints = opts ?? {};
          return llm.generateReply(messages, opts);
        },
      }),
    };
  }

  const bot = new Orchestrator({
    userId,
    companionId,
    companionName,
    subjectName,
    config: persona?.config ?? null,
    options: persona?.options ?? {},
    activityFn: persona?.life ? makeScheduleActivityFn(persona.life) : null,
    lifeConfig: persona?.life ?? null,
    deps,
  });

  const { text, parts } = await bot.reply(String(req.message ?? ''));
  if (debugMode) trace.metrics = metricsSnapshot(); // 本轮到回复为止的 LLM 调用/token (子进程独占, 就是这一轮的账)
  // 先把回复吐给 ui server (它只等第一行), 再留在后台把记忆提取/状态演变跑完
  const payload = { ok: true, text, parts, persona: persona?.config?.name ?? null, ...(debugMode ? { debug: trace } : {}) };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  await bot._lastAfterReply?.catch(() => {});
  await bot._lastHistoryPersist?.catch(() => {});
  process.exit(0);
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({ ok: false, message: error?.message || String(error) })}\n`);
  process.exit(1);
});
