/**
 * 身体/经期/熬夜 → 可观察语气与门控（纯逻辑）。
 * 与 life.toPrompt 互补：这里给「用户能感觉到」的行为差异与亲密门控。
 */

/**
 * @param life state.life
 * @param profileMenstrual CompanionConfig.profile.menstrual
 * @param intimacy state.intimacy
 */
export function inferBodySituation(life = {}, profileMenstrual = null, now = Date.now()) {
  const sick = Boolean(life?.sick_until && new Date(life.sick_until).getTime() > now);
  const lowEnergy = Number(life?.energy) < 0.3;
  const lowHealth = Number(life?.health) < 0.55;
  const lateNightStreak = Math.max(0, Number(life?.late_night_streak) || 0);
  const period = isLikelyPeriod(profileMenstrual, now);
  return {
    sick,
    lowEnergy,
    lowHealth,
    lateNightStreak,
    period,
    activity: life?.current_activity || null,
  };
}

export function isLikelyPeriod(menstrual, now = Date.now()) {
  if (!menstrual?.enabled || !menstrual.lastPeriodStart) return false;
  const start = new Date(menstrual.lastPeriodStart).getTime();
  if (Number.isNaN(start)) return false;
  const cycle = Math.max(21, Number(menstrual.cycleLengthDays) || 28);
  const periodLen = Math.max(3, Number(menstrual.periodLengthDays) || 5);
  const days = Math.floor((now - start) / (24 * 60 * 60 * 1000));
  if (days < 0) return false;
  const dayInCycle = days % cycle;
  return dayInCycle < periodLen;
}

/**
 * Prompt 注入：可观察差异，禁止自我播报数值。
 */
export function bodyStateToPrompt(situation = {}, intimacy = null) {
  if (!situation) return '';
  const lines = [];
  if (situation.sick) {
    lines.push('【身体·病中】难受、话少、想被轻轻照顾；拒绝剧烈/高热亲密很自然；别反复说「我病了」。');
  } else if (situation.period) {
    lines.push('【身体·经期】可能腰腹不适、易累、兴致偏低；亲密可软拒或只要拥抱；别主动暴露隐私细节。');
  } else if (situation.lowEnergy || situation.lowHealth) {
    lines.push('【身体·疲惫】话量偏短、反应慢半拍；别突然兴致勃勃约通宵。');
  }
  if (situation.lateNightStreak >= 2) {
    lines.push('【身体·连续熬夜】有点虚、容易烦；可自然提早点睡，别说教。');
  }
  if (situation.activity && /开会|加班/.test(String(situation.activity))) {
    lines.push(`【当下活动】你大概在${situation.activity}；相关时顺口带一句累/忙，别每轮硬报。`);
  }
  // aftercare 跨会话余韵
  if (intimacy && Number(intimacy.aftercare_need) >= 0.4) {
    lines.push('【亲密余韵】事后还想被抱着/确认；语气软一点黏一点，别突然公事公办。');
  }
  if (!lines.length) return '';
  return lines.join('\n');
}

/**
 * 亲密门控：病中/经期/极低精力时收紧主动亲密。
 * @returns {{ allowIntimateInit: boolean, reason: string }}
 */
export function bodyIntimacyGate(situation = {}) {
  if (situation.sick) return { allowIntimateInit: false, reason: 'sick' };
  if (situation.period) return { allowIntimateInit: false, reason: 'period' };
  if (situation.lowEnergy && situation.lowHealth) return { allowIntimateInit: false, reason: 'exhausted' };
  return { allowIntimateInit: true, reason: 'ok' };
}

/**
 * 行为修正：病中/经期 → 更短、更慢、更少主动。
 */
export function applyBodyToBehavior(policy = {}, situation = {}) {
  if (!policy) return policy;
  let [d0, d1] = Array.isArray(policy.replyDelayMs) ? policy.replyDelayMs : [0, 0];
  let parts = policy.partsBudget ?? 2;
  let lengthHint = policy.lengthHint;
  let proactiveBias = Number(policy.proactiveBias) || 0;

  if (situation.sick || situation.period) {
    lengthHint = 'terse';
    parts = Math.min(parts, 1);
    d0 = Math.max(d0, 800);
    d1 = Math.max(d1, 5000);
    proactiveBias -= 0.25;
  } else if (situation.lowEnergy) {
    if (lengthHint === 'chatty') lengthHint = 'normal';
    parts = Math.min(parts, 2);
    proactiveBias -= 0.1;
  }
  if (situation.lateNightStreak >= 3) proactiveBias -= 0.1;

  return {
    ...policy,
    replyDelayMs: [d0, d1],
    partsBudget: Math.max(1, parts),
    lengthHint,
    proactiveBias: Math.max(-1, Math.min(1, proactiveBias)),
    bodyGate: bodyIntimacyGate(situation),
  };
}
