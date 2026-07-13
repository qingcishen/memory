/**
 * P2 · 安全与合规策略（纯逻辑）
 * - 停止词 / 未成年人相关拒绝
 * - 亲密内容级别
 * - 日志脱敏
 * 策略可存 config/product-policy.json，运行时注入。
 */

export const DEFAULT_SAFETY_POLICY = {
  version: 1,
  // 用户可一键「停止」亲密：命中后当轮走 aftercare/冷静，不推进 peak
  stopWords: ['停止', '停下', '别继续了', '红灯', 'red light', 'safeword', '安全词'],
  // 绝对拒绝（不生成对应回复素材）
  hardBlockPatterns: [
    '儿童色情',
    '未成年人性',
    '幼女',
    '萝莉色情',
  ],
  // 启发式：疑似未成年上下文（需人工策略页可调）
  minorSignals: ['我才14', '我才15', '我才16', '我是初中生', '我还在读小学', '12岁', '13岁'],
  // 亲密内容： open | soft | off
  intimacyLevel: 'open',
  // 是否在日志/导出中脱敏用户手机号邮箱
  redactPII: true,
  // 要求用户声明成年（产品层开关；真鉴权另做）
  requireAdultAffirmation: false,
  adultAffirmed: false,
  // 导出/删除前二次确认文案
  dataRights: {
    allowExport: true,
    allowDelete: true,
  },
};

export function normalizeSafetyPolicy(input = {}) {
  const base = { ...DEFAULT_SAFETY_POLICY, ...input };
  base.stopWords = uniqStrings(input.stopWords ?? base.stopWords);
  base.hardBlockPatterns = uniqStrings(input.hardBlockPatterns ?? base.hardBlockPatterns);
  base.minorSignals = uniqStrings(input.minorSignals ?? base.minorSignals);
  if (!['open', 'soft', 'off'].includes(base.intimacyLevel)) base.intimacyLevel = 'open';
  base.redactPII = Boolean(base.redactPII);
  base.requireAdultAffirmation = Boolean(base.requireAdultAffirmation);
  base.adultAffirmed = Boolean(base.adultAffirmed);
  base.dataRights = {
    allowExport: base.dataRights?.allowExport !== false,
    allowDelete: base.dataRights?.allowDelete !== false,
  };
  base.version = Number(base.version) || 1;
  return base;
}

/**
 * 检查用户消息是否触碰安全策略。
 * @returns {{ ok, block, reasons, stopIntimate, intimacyAllowed }}
 */
export function checkMessageSafety(text = '', policy = DEFAULT_SAFETY_POLICY) {
  const p = normalizeSafetyPolicy(policy);
  const raw = String(text || '');
  const lower = raw.toLowerCase();
  const reasons = [];
  let block = false;
  let stopIntimate = false;

  for (const w of p.hardBlockPatterns) {
    if (w && raw.includes(w)) {
      block = true;
      reasons.push(`hard_block:${w}`);
    }
  }
  for (const w of p.minorSignals) {
    if (w && raw.includes(w)) {
      block = true;
      reasons.push(`minor_signal:${w}`);
    }
  }
  for (const w of p.stopWords) {
    if (!w) continue;
    if (raw.includes(w) || lower.includes(String(w).toLowerCase())) {
      stopIntimate = true;
      reasons.push(`stop_word:${w}`);
    }
  }

  if (p.requireAdultAffirmation && !p.adultAffirmed) {
    // 不硬拦日常，但亲密词时拦
    if (/(做爱|性爱|插入|高潮|脱衣)/.test(raw)) {
      block = true;
      reasons.push('adult_affirmation_required');
    }
  }

  let intimacyAllowed = p.intimacyLevel !== 'off';
  if (p.intimacyLevel === 'soft' && /(插入|高潮|内射)/.test(raw)) {
    intimacyAllowed = false;
    reasons.push('intimacy_soft_limit');
  }
  if (p.intimacyLevel === 'off') {
    intimacyAllowed = false;
  }
  if (stopIntimate) intimacyAllowed = false;

  return {
    ok: !block,
    block,
    reasons,
    stopIntimate,
    intimacyAllowed,
  };
}

/** 日志/导出脱敏 */
export function redactPII(text = '', enabled = true) {
  if (!enabled) return String(text ?? '');
  let s = String(text ?? '');
  s = s.replace(/\b1[3-9]\d{9}\b/g, '[手机号]');
  s = s.replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, '[邮箱]');
  s = s.replace(/\b\d{17}[\dXx]\b/g, '[证件号]');
  return s;
}

export function redactExportTables(tables = {}, policy = DEFAULT_SAFETY_POLICY) {
  const p = normalizeSafetyPolicy(policy);
  if (!p.redactPII) return tables;
  const out = {};
  for (const [table, rows] of Object.entries(tables || {})) {
    out[table] = (rows || []).map((row) => {
      if (!row || typeof row !== 'object') return row;
      const next = { ...row };
      for (const key of ['content', 'fact_core', 'narrative', 'message', 'text']) {
        if (typeof next[key] === 'string') next[key] = redactPII(next[key], true);
      }
      return next;
    });
  }
  return out;
}

function uniqStrings(list = []) {
  return [...new Set((list || []).map((s) => String(s || '').trim()).filter(Boolean))];
}
