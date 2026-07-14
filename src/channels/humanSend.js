/**
 * 渠道共用：像真人连发的气泡拆分 + 打字延迟
 * Telegram / 飞书 / Discord 共用，避免各写一套。
 */

import { chunkText } from './memory-channel.js';

/**
 * 按中文/英文句号、换行、破折号等拆成最多 max 条。
 * 像微信：短句也尽量拆成 2 条连发，而不是永远「你一句我一整段」。
 */
export function splitDialogueBubbles(text = '', max = 3, minSplitLen = 12) {
  const s = String(text || '').trim();
  if (!s) return [];
  if (max <= 1) return [s];

  let pieces = s.split(/\n+/).map((x) => x.trim()).filter(Boolean);

  if (pieces.length === 1) {
    pieces = s
      .split(/(?<=[。！？!?…～—])\s*/u)
      .map((x) => x.trim())
      .filter(Boolean);
  }

  // 仍是一条：用省略号/破折号/分号再拆（「嗯……再深一点」）
  if (pieces.length === 1) {
    const soft = s
      .split(/(?<=[…‥]{1,3}|——|；|;)\s*/u)
      .map((x) => x.trim())
      .filter(Boolean);
    if (soft.length > 1) pieces = soft;
  }

  // 仍是一条：在逗号处拆成两半（「过来，今天你别动」），短句也拆
  if (pieces.length === 1 && s.length >= 6) {
    const m = s.match(/^(.{1,}?[，,])\s*(.{2,})$/u);
    if (m && m[1].replace(/[，,\s]/gu, '').length >= 1 && m[2].trim().length >= 2) {
      pieces = [m[1].replace(/[，,]\s*$/u, '').trim(), m[2].trim()].filter(Boolean);
    }
  }

  // 极短且拆不开：保持 1 条（「嗯。」）
  if (pieces.length <= 1) return [s];
  if (pieces.length <= max) return pieces;

  const out = [];
  const bucket = Math.ceil(pieces.length / max);
  for (let i = 0; i < pieces.length; i += bucket) {
    out.push(pieces.slice(i, i + bucket).join(''));
  }
  return out.slice(0, max);
}

/**
 * parts → 多条气泡（旁白单独、台词可拆）
 * @param merge 若 true 退回整段合并（旧行为）
 */
export function buildHumanOutgoingMessages(
  parts = [],
  { maxDialogueBubbles = 3, minSplitLen = 12, chunkLimit = 1900, merge = false } = {},
) {
  if (merge) {
    const text = (parts ?? []).map((p) => String(p?.text || '').trim()).filter(Boolean).join('\n\n');
    return chunkText(text, chunkLimit).map((t) => ({ type: 'merged', text: t }));
  }
  const out = [];
  let dialogueBudget = Math.max(1, Number(maxDialogueBubbles) || 3);
  for (const p of parts || []) {
    const text = String(p?.text || '').trim();
    if (!text) continue;
    if (p.type === 'narration') {
      out.push({ type: 'narration', text });
      continue;
    }
    if (dialogueBudget <= 0) continue;
    const bubbles = splitDialogueBubbles(text, dialogueBudget, minSplitLen);
    for (const b of bubbles) {
      if (dialogueBudget <= 0) break;
      out.push({ type: 'dialogue', text: b });
      dialogueBudget -= 1;
    }
  }
  if (!out.length) {
    return chunkText('...', chunkLimit).map((t) => ({ type: 'dialogue', text: t }));
  }
  return out.flatMap((msg) =>
    chunkText(msg.text, chunkLimit)
      .filter(Boolean)
      .map((text) => ({ type: msg.type, text })),
  );
}

/** 打字延迟（ms） */
export function typingDelayMs(text = '', { min = 400, max = 1400, perChar = 12 } = {}) {
  return Math.min(max, Math.max(min, String(text ?? '').length * perChar));
}

/** 两条消息之间的额外停顿 */
export function interBubbleDelayMs(index = 0, rng = Math.random) {
  if (index <= 0) return 0;
  return 280 + Math.floor((Number(rng()) || 0) * 420);
}

/**
 * 从 behaviorPolicy.replyDelayMs 取首条消息前的「情绪节奏」延迟。
 * @param policy {{ replyDelayMs?: [number, number] }}
 * @param opts {{ cap?: number, rng?: () => number }} cap 默认 60000；试聊可传 5000
 */
export function policyFirstDelayMs(policy = {}, { cap = 60000, rng = Math.random } = {}) {
  const [rawMin, rawMax] = Array.isArray(policy?.replyDelayMs) ? policy.replyDelayMs : [0, 0];
  let min = Math.max(0, Number(rawMin) || 0);
  let max = Math.max(min, Number(rawMax) || 0);
  const capN = Math.max(0, Number(cap) || 0);
  if (capN > 0) {
    min = Math.min(min, capN);
    max = Math.min(max, capN);
  }
  const r = Math.min(1, Math.max(0, Number(rng()) || 0));
  return Math.round(min + (max - min) * r);
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 通用：按气泡顺序发送
 * @param sendFn async (text, meta) => void
 * @param opts.behaviorPolicy 情绪行为策略 → 首条前 policyFirstDelay
 * @param opts.firstDelayMs 覆盖首条延迟；opts.policyCapMs 限制 policy 延迟上限
 */
export async function deliverHumanBubbles(parts, sendFn, opts = {}) {
  const merge =
    opts.merge === true ||
    process.env.CHANNEL_MERGE_MESSAGES === '1' ||
    process.env.CHANNEL_MERGE_MESSAGES === 'true';
  const bubbles = buildHumanOutgoingMessages(parts, {
    maxDialogueBubbles: opts.maxDialogueBubbles ?? 3,
    minSplitLen: opts.minSplitLen ?? 12,
    chunkLimit: opts.chunkLimit ?? 1900,
    merge,
  });
  const rng = opts.rng || Math.random;
  const sleepFn = opts.sleep || sleep;

  // 首条前：情绪节奏延迟（委屈/生气更慢）
  if (!opts.skipDelay) {
    const first =
      opts.firstDelayMs != null
        ? Math.max(0, Number(opts.firstDelayMs) || 0)
        : policyFirstDelayMs(opts.behaviorPolicy || {}, {
            cap: opts.policyCapMs ?? 60000,
            rng,
          });
    if (first > 0) {
      if (typeof opts.onTyping === 'function') await Promise.resolve(opts.onTyping({ text: '', phase: 'policy' })).catch(() => {});
      await sleepFn(first);
    }
  }

  for (let i = 0; i < bubbles.length; i++) {
    const msg = bubbles[i];
    if (typeof opts.onTyping === 'function') await Promise.resolve(opts.onTyping(msg)).catch(() => {});
    const delay = typingDelayMs(msg.text, opts.typing) + interBubbleDelayMs(i, rng);
    if (opts.skipDelay) {
      /* 测试用 */
    } else {
      await sleepFn(delay);
    }
    await sendFn(msg.text, msg);
  }
  return bubbles;
}
