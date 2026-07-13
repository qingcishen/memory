/**
 * 场景连贯 · 硬守卫
 * - 从近期对话锁定当前场景（亲密 / 车 / 病中 / 工作…）
 * - 生成禁止跳戏的 prompt 段
 * - 检测回复是否前言不搭后语（可单测）
 */

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
    forbidJump: /(出去浪|通宵蹦|剧烈运动|喝酒狂欢)/,
    continuity:
      '【场景锁定·不适】她身体不舒服。语气放软、动作轻；禁止突然兴致勃勃约剧烈活动或大段撒欢。',
  },
  work: {
    id: 'work',
    label: '工作/公司',
    detect: /(开会|公司|工位|老板|客户|加班|汇报|deadline|项目)/,
    forbidJump: null,
    continuity:
      '【场景锁定·工作】语境在工作/公司。可吐槽、可累、可想他；别突然变成完全无关的校园日常设定。',
  },
  conflict: {
    id: 'conflict',
    label: '冷战/争执',
    detect: /(生气|吵架|不理我|你怎么这样|分手|冷战|算了吧)/,
    forbidJump: /(嘿嘿想你了.*做|来做一次)/,
    continuity:
      '【场景锁定·情绪对峙】对方在闹/你们不对劲。先处理情绪与关系，不要突然跳到高热亲密索取。',
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
  // 车+亲密：两条都保留
  return locks;
}

export function sceneCoherenceToPrompt(locks = [], { intimacyPhase = null } = {}) {
  if (!locks.length && !intimacyPhase) return '';
  const lines = ['【连贯性·硬规则·本轮最高优先级】'];
  for (const lock of locks) {
    lines.push(lock.continuity);
  }
  lines.push(
    '回复内部：第一句必须接住对方最后一句的意思；后面句子只能推进同一条线，禁止像粘了另一条无关短信。',
    '若场景不方便做完某事，就明确说场景限制并提议之后/换地方，不要跳到完全无关的生活设定。',
  );
  return lines.join('\n');
}

/**
 * 粗检 assistant 回复是否与当前锁冲突（启发式，给测试与可选后处理）
 */
export function detectNonSequitur(replyText = '', locks = []) {
  const text = String(replyText || '');
  if (!text.trim() || !locks.length) return { bad: false, reasons: [] };
  const reasons = [];
  for (const lock of locks) {
    if (lock.forbidJump && lock.forbidJump.test(text) && lock.detect.test(text) === false) {
      // 有禁止跳转模式且回复里出现禁止内容
      reasons.push(`${lock.id}: 疑似跳戏（出现 ${lock.forbidJump}）`);
    }
    // 亲密锁下突然上课
    if (lock.id === 'intimate' && /(明天上课|记得吃早饭|写作业|考试加油)/.test(text) && !/(折腾|睡|累|回家)/.test(text)) {
      reasons.push('intimate: 亲密话题中硬插日程收尾');
    }
  }
  // 通用：同一条里「亲密词」和「纯学生日程」硬拼
  if (/(想要|插|高潮|湿)/.test(text) && /(明天上课|第一节课|交作业)/.test(text)) {
    reasons.push('mixed: 亲密与上课硬拼');
  }
  return { bad: reasons.length > 0, reasons };
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
    // 问句 / 待办 / 情绪悬而未决
    if (/[?？]$|怎么样了|后来呢|你记得|帮我|等下|明天|周末|答应/.test(c)) {
      hooks.push({ kind: 'unfinished', text: c.slice(0, 60) });
    }
  }
  return hooks;
}
