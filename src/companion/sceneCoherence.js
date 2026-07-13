/**
 * 场景连贯 · 硬守卫
 * - 从近期对话锁定当前场景（亲密 / 车 / 病中 / 工作…）
 * - 生成禁止跳戏 + 禁止库存结尾的 prompt 段
 * - 检测回复是否前言不搭后语（可单测；可选后处理提示）
 */

/** 库存万能结尾：任何场景都不该当「糊弄收尾」用 */
export const STOCK_ENDINGS = /(明天上课|记得吃早饭|写作业|考试加油|好好休息哦$|早点睡哈$|我先睡了哈|拜啦$|88+$|加油哦(?!.*折腾))/;

export const SCENE_LOCKS = {
  intimate: {
    id: 'intimate',
    label: '亲密/身体',
    detect: /(想要|做|插|亲|吻|抱紧|里面|高潮|床|脱|湿|硬|顶|弄我|想你了.*身体|性爱|做爱)/,
    forbidJump: /(明天上课|记得吃早饭|作业|考试|公司开会|我先睡了哈|拜拜)/,
    continuity:
      '【场景锁定·亲密】你们正在谈身体/亲密/欲望。整轮只顺着这件事：身体、节奏、感受、要不要停。禁止用上课/早饭/工作/学生设定当万能收尾；要关心也只能自然接在亲密语境里（例如「折腾完能睡着吗」）。',
  },
  car: {
    id: 'car',
    label: '车内',
    detect: /(车里|车上|副驾|后座|停车|方向盘|安全带)/,
    forbidJump: /(回家再说|回房|到家再|换床)/,
    continuity:
      '【场景锁定·车内】人还在车里。动作与空间只能是车内（座椅、空间窄、窗外、停车状态）。禁止突然写回了家/上了床，除非对方明确说到家了。',
  },
  sick: {
    id: 'sick',
    label: '病中/不适',
    detect: /(发烧|感冒|不舒服|头疼|痛经|好难受|生病|药)/,
    forbidJump: /(出去浪|通宵蹦|剧烈运动|喝酒狂欢|来做一次)/,
    continuity:
      '【场景锁定·不适】她身体不舒服。语气放软、动作轻；禁止突然兴致勃勃约剧烈活动或大段撒欢；亲密邀请应婉拒或延后。',
  },
  work: {
    id: 'work',
    label: '工作/公司',
    detect: /(开会|公司|工位|老板|客户|加班|汇报|deadline|项目)/,
    forbidJump: null,
    continuity:
      '【场景锁定·工作】语境在工作/公司。可吐槽、可累、可想他；别突然变成完全无关的校园日常设定。',
  },
  travel: {
    id: 'travel',
    label: '出行/出差',
    detect: /(出差|高铁|飞机|酒店|外地|杭州|上海|北京|在路上)/,
    forbidJump: null,
    continuity:
      '【场景锁定·出行】语境在出差/路上/外地。可想家、可累、可报行程碎片；别假装人还在家里日常同居。',
  },
  conflict: {
    id: 'conflict',
    label: '冷战/争执',
    detect: /(生气|吵架|不理我|你怎么这样|分手|冷战|算了吧)/,
    forbidJump: /(嘿嘿想你了.*做|来做一次|想要你)/,
    continuity:
      '【场景锁定·情绪对峙】对方在闹/你们不对劲。先处理情绪与关系，不要突然跳到高热亲密索取。永远留一点可恢复的缝（冷可以，别判死刑）。',
  },
};

/**
 * 从最近几轮 + 当前用户句推断主场景锁（可叠加 car+intimate）
 */
export function detectSceneLocks(userMessage = '', history = [], intimacyPhase = null) {
  const blob = [
    ...history.slice(-6).map((m) => m.content || ''),
    userMessage,
  ].join('\n');
  const locks = [];
  for (const lock of Object.values(SCENE_LOCKS)) {
    if (lock.detect.test(blob)) locks.push(lock);
  }
  if (['foreplay', 'peak', 'aftercare', 'flirting'].includes(intimacyPhase) && !locks.some((l) => l.id === 'intimate')) {
    locks.push(SCENE_LOCKS.intimate);
  }
  return locks;
}

/**
 * @param locks
 * @param opts {{ intimacyPhase?, topGoalText? }}
 */
export function sceneCoherenceToPrompt(locks = [], { intimacyPhase = null, topGoalText = null } = {}) {
  if (!locks.length && !intimacyPhase && !topGoalText) return '';
  const lines = ['【连贯性·硬规则·本轮最高优先级】'];
  for (const lock of locks) {
    lines.push(lock.continuity);
  }
  lines.push(
    '回复内部：第一句必须接住对方最后一句的意思；后面句子只能推进同一条线，禁止像粘了另一条无关短信。',
    '若场景不方便做完某事，就明确说场景限制并提议之后/换地方，不要跳到完全无关的生活设定。',
    '【禁止库存结尾】不要用「明天上课 / 记得吃早饭 / 好好休息哦 / 我先睡了哈 / 加油哦」这类万能收尾糊弄；收尾必须接住本轮正在说的事。',
  );
  if (topGoalText) {
    lines.push(`【结尾服务意图】若本轮心里有一件事（${topGoalText.slice(0, 48)}），只能在话题自然落点轻点一下，禁止硬拐、禁止任务腔。`);
  }
  return lines.join('\n');
}

/**
 * 粗检 assistant 回复是否与当前锁冲突（启发式，给测试与可选后处理）
 */
export function detectNonSequitur(replyText = '', locks = []) {
  const text = String(replyText || '');
  if (!text.trim()) return { bad: false, reasons: [] };
  const reasons = [];

  // 库存结尾：亲密/车/冲突必查；其它场景也软查「纯万能收尾」
  if (STOCK_ENDINGS.test(text)) {
    if (locks.some((l) => l.id === 'intimate' || l.id === 'car' || l.id === 'conflict')) {
      reasons.push('stock: 库存万能结尾');
    } else if (/(明天上课|记得吃早饭|写作业)[.。!！]?$/.test(text.trim())) {
      reasons.push('stock: 句末库存收尾');
    }
  }

  for (const lock of locks) {
    if (lock.forbidJump && lock.forbidJump.test(text) && lock.detect.test(text) === false) {
      reasons.push(`${lock.id}: 疑似跳戏`);
    }
    if (lock.id === 'intimate' && /(明天上课|记得吃早饭|写作业|考试加油)/.test(text) && !/(折腾|睡|累|回家)/.test(text)) {
      reasons.push('intimate: 亲密话题中硬插日程收尾');
    }
    if (lock.id === 'car' && /(回了家|上了床|到卧室)/.test(text) && !/(到家|回家了)/.test(text)) {
      reasons.push('car: 车内突然回家上床');
    }
    if (lock.id === 'conflict' && /(想要你|来做|脱掉)/.test(text)) {
      reasons.push('conflict: 对峙中硬推亲密');
    }
    if (lock.id === 'sick' && /(通宵|出去浪|剧烈)/.test(text)) {
      reasons.push('sick: 病中约剧烈活动');
    }
  }
  if (/(想要|插|高潮|湿)/.test(text) && /(明天上课|第一节课|交作业)/.test(text)) {
    reasons.push('mixed: 亲密与上课硬拼');
  }
  // 电报体三连硬切
  if (/^[^。！？]{1,8}。[。\s]*[^。！？]{1,8}。[。\s]*[^。！？]{1,8}。/.test(text.replace(/\s/g, ''))) {
    reasons.push('style: 疑似电报体三连');
  }
  return { bad: reasons.length > 0, reasons };
}

/**
 * 后处理建议：坏回复时给调用方一句「软修复」提示（不自动改写 LLM 输出，避免乱改）。
 * 返回 { needsRetry, hint }；编排器可选用。
 */
export function nonSequiturRepairHint(replyText = '', locks = []) {
  const check = detectNonSequitur(replyText, locks);
  if (!check.bad) return { needsRetry: false, hint: '', reasons: [] };
  return {
    needsRetry: true,
    reasons: check.reasons,
    hint: '上一稿疑似跳戏或库存结尾。请只顺着对方最后一句和当前场景重写，删掉无关日程/校园/万能收尾，第一句必须接住对方。',
  };
}

/**
 * 从 history 提取「未聊完的钩子」供本轮意图/主动用
 */
export function extractUnfinishedHooks(history = [], limit = 2) {
  const hooks = [];
  const recent = history.slice(-12);
  for (let i = recent.length - 1; i >= 0 && hooks.length < limit; i--) {
    const m = recent[i];
    if (m.role !== 'user') continue;
    const c = String(m.content || '').trim();
    if (c.length < 4 || c.length > 80) continue;
    if (/[?？]$|怎么样了|后来呢|你记得|帮我|等下|明天|周末|答应/.test(c)) {
      hooks.push({ kind: 'unfinished', text: c.slice(0, 60) });
    }
  }
  return hooks;
}
