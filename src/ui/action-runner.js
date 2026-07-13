// 控制台业务动作 runner。
// 每次操作单独启动，确保 .env 与 config/params.json 的最新值被重新加载；stdout 只输出一行协议 JSON。

import dotenv from 'dotenv';
dotenv.config();

console.log = (...args) => console.error(...args);

import { Memory } from '../memory.js';
import { Orchestrator } from '../orchestrator/orchestrator.js';
import { scheduleProspective } from '../memory/prospective.js';
import { loadPersonaConfig } from '../companion.js';
import { makeScheduleActivityFn } from '../state/activity.js';

function safeResult(value) {
  return JSON.parse(JSON.stringify(value, (key, item) => {
    if (key === 'embedding' || key === 'media_embedding' || key === 'cue_embedding') return undefined;
    if (Array.isArray(item) && item.length > 300) return `[${item.length} items]`;
    return item;
  }));
}

async function run(req) {
  const userId = String(req.userId || '').trim();
  const companionId = String(req.companionId || 'default').trim() || 'default';
  if (!userId) throw new Error('缺少 userId');
  if (!/^[\w-]{1,64}$/.test(companionId) || companionId.startsWith('.')) throw new Error('角色 ID 不合法');
  const memory = new Memory({ userId, companionId, subjectName: req.subjectName || '对方', companionName: req.companionName || '她' });

  switch (req.action) {
    case 'schedule-prospective':
      return scheduleProspective(userId, companionId, {
        content: String(req.content || '').trim(),
        trigger_kind: req.triggerKind === 'cue' ? 'cue' : 'time',
        trigger_at: req.triggerAt || null,
        cueText: String(req.cueText || '').trim(),
      });
    case 'settle':
      return memory.settle();
    case 'reconsolidate':
      return memory.reconsolidate({ useLLM: Boolean(req.useLLM) });
    case 'reflect':
      return memory.reflect();
    case 'story':
      return memory.story();
    case 'dedupe':
      return memory.dedupe();
    case 'forgettable':
      return memory.forgettable(Number(req.threshold) || 0.05, { purge: Boolean(req.purge) });
    case 'forget':
      return memory.forget(String(req.query || '').trim(), { includeLocked: Boolean(req.includeLocked) });
    case 'company-tick': {
      const persona = loadPersonaConfig(`companions/${companionId}.json`);
      const orchestrator = new Orchestrator({
        userId,
        companionId,
        config: persona?.config ?? null,
        options: persona?.options ?? {},
        activityFn: persona?.life ? makeScheduleActivityFn(persona.life) : null,
        lifeConfig: persona?.life ?? null,
      });
      await orchestrator.init();
      if (!orchestrator.story) throw new Error('这个角色还没有配置公司故事线');
      const state = await orchestrator.stateLayer.snapshot().catch(() => null);
      const storylineIds = (persona?.config?.company?.projects || []).map((project) => project.id).filter(Boolean);
      if (!storylineIds.length) throw new Error('公司档案里还没有登记经营项目');
      return orchestrator.story.tick({ now: Date.now(), state, storylineIds });
    }
    case 'nightly':
    case 'train': {
      const persona = loadPersonaConfig(`companions/${companionId}.json`);
      const orchestrator = new Orchestrator({
        userId,
        companionId,
        config: persona?.config ?? null,
        options: persona?.options ?? {},
        activityFn: persona?.life ? makeScheduleActivityFn(persona.life) : null,
        lifeConfig: persona?.life ?? null,
      });
      return req.action === 'train' ? orchestrator.trainNightly() : orchestrator.maintain({ nightly: true });
    }
    default:
      throw new Error(`未知动作 ${req.action}`);
  }
}

const req = JSON.parse(process.argv[2] || '{}');
run(req)
  .then((result) => process.stdout.write(`${JSON.stringify({ ok: true, action: req.action, result: safeResult(result) })}\n`))
  .catch((error) => {
    process.stdout.write(`${JSON.stringify({ ok: false, action: req.action, message: error?.message || String(error) })}\n`);
    process.exitCode = 1;
  });
