/**
 * 回复「像真人」硬后处理 + 历史消毒。
 * 提示词 alone 挡不住：模型会抄短期历史里的网文腔（姓名开场、睡衣头发清单、复读收尾）。
 * 这里用确定性规则压掉最差模式，保证发出去的内容短、碎、有因果。
 */

const NAME_OPEN =
  /^(沈清词|清词)(听|被|把|抬|撑|侧身|猛地|身子|听见|听清|抬眼|没|把手机|将|伸手)[^。！？\n]{0,100}[。！？\n]?\s*/u;

const INVENTORY_PATTERNS = [
  /散着的头发[^，。！？\n]{0,24}[，。！？]?/gu,
  /发丝散着[^，。！？\n]{0,20}[，。！？]?/gu,
  /深色丝质睡衣[^，。！？\n]{0,36}[，。！？]?/gu,
  /半敞的丝质睡衣[^，。！？\n]{0,36}[，。！？]?/gu,
  /丝质睡衣[^，。！？\n]{0,28}[，。！？]?/gu,
  /领口松松敞着[^，。！？\n]{0,12}[，。！？]?/gu,
  /往怀里又嵌了嵌[^，。！？\n]{0,12}[，。！？]?/gu,
  /整个人往怀里嵌了嵌[^，。！？\n]{0,12}[，。！？]?/gu,
  /往他怀里又嵌了嵌[^，。！？\n]{0,12}[，。！？]?/gu,
  /耳尖微热[^，。！？\n]{0,16}[，。！？]?/gu,
  /指尖在他后背轻轻收紧[^，。！？\n]{0,24}[，。！？]?/gu,
  /像在(确认|讨|无声)[^，。！？\n]{0,20}[，。！？]?/gu,
  /呼吸轻轻落在他唇边[^，。！？\n]{0,8}[，。！？]?/gu,
];

const STOCK_DIALOGUE_TAILS = [
  /[，。！？\s]*你真的一直[^。！？\n]{0,12}[吗嘛]?[？?]?\s*$/u,
  /[，。！？\s]*就这样抱着[，,]?也算你想我[。.]?\s*$/u,
  /[，。！？\s]*搂紧点[，,]?(逸晨[，,]?)?我想靠你[^。！？\n]{0,30}[。！？]?\s*$/u,
  /[，。！？\s]*别松手[，,]?我有点空[^。！？\n]{0,24}[。！？]?\s*$/u,
  /[，。！？\s]*就先这样抱着[，,]?别松手[。.]?\s*$/u,
  /[，。！？\s]*逸晨[，,]?主动一点的是我[^。！？\n]{0,20}[。！？]?\s*$/u,
];

const LITERARY_FILLER =
  /[，,]?\s*(却没(装不懂|躲|多解释|再推|再往前凑))[^，。！？\n]{0,20}/gu;

/**
 * @param {Array<{type?: string, text?: string}>} parts
 * @param {{ intimacyPhase?: string|null, maxNarrationChars?: number, maxDialogueChars?: number, multiBubble?: boolean, maxDialogueBubbles?: number }} [opts]
 */
export function humanizeReplyParts(parts = [], opts = {}) {
  const list = Array.isArray(parts) ? parts : [];
  if (!list.length) return list;

  const phase = opts.intimacyPhase || null;
  const intimate = ['flirting', 'foreplay', 'peak', 'aftercare', 'cooldown'].includes(phase);
  const maxNarr = Number(opts.maxNarrationChars) || (intimate ? 72 : 100);
  const maxDial = Number(opts.maxDialogueChars) || (intimate ? 100 : 160);
  const multiBubble = opts.multiBubble !== false;
  const maxBubbles = Math.max(1, Number(opts.maxDialogueBubbles) || (intimate ? 3 : 3));

  const out = [];
  for (const p of list) {
    if (!p?.text?.trim()) continue;
    const type = p.type === 'narration' ? 'narration' : 'dialogue';
    const text =
      type === 'narration'
        ? compressNarration(p.text, maxNarr)
        : compressDialogue(p.text, maxDial, intimate);
    if (text) out.push({ type, text });
  }

  // 亲密场景：旁白最多 1 条
  let slim = out;
  if (intimate) {
    let narrUsed = 0;
    slim = [];
    for (const p of out) {
      if (p.type === 'narration') {
        if (narrUsed >= 1) continue;
        narrUsed += 1;
      }
      slim.push(p);
    }
    if (!slim.length) slim = out.slice(0, 1);
  }

  // 像微信连发：把台词拆成多条短 dialogue part（发送层会分条+间隔）
  if (multiBubble) slim = expandDialogueIntoBubbles(slim, maxBubbles);

  return slim.length ? slim : list.slice(0, 1);
}

/**
 * 把「一整段台词」拆成 2～3 条短气泡 parts。
 * 真人聊天常见：嗯 / 过来 / 今天你别动 —— 而不是合成一条。
 */
export function expandDialogueIntoBubbles(parts = [], maxDialogueBubbles = 3) {
  const maxDial = Math.max(1, Number(maxDialogueBubbles) || 3);
  const out = [];
  let dialLeft = maxDial;

  for (const p of parts || []) {
    if (!p?.text?.trim()) continue;
    if (p.type === 'narration') {
      out.push(p);
      continue;
    }
    if (dialLeft <= 0) continue;

    const bubbles = splitIntoChatBubbles(p.text, dialLeft);
    for (const b of bubbles) {
      if (dialLeft <= 0) break;
      out.push({ type: 'dialogue', text: b });
      dialLeft -= 1;
    }
  }
  return out.length ? out : parts;
}

/** 纯逻辑拆句：换行 > 句号 > 省略号/破折号 > 逗号对半 */
export function splitIntoChatBubbles(text = '', max = 3) {
  const s = String(text || '').trim();
  if (!s) return [];
  if (max <= 1) return [s];

  let pieces = s.split(/\n+/).map((x) => x.trim()).filter(Boolean);
  if (pieces.length === 1) {
    pieces = s.split(/(?<=[。！？!?…～])\s*/u).map((x) => x.trim()).filter(Boolean);
  }
  if (pieces.length === 1) {
    const soft = s.split(/(?<=[…‥]{1,3}|——|；)\s*/u).map((x) => x.trim()).filter(Boolean);
    if (soft.length > 1) pieces = soft;
  }
  if (pieces.length === 1 && s.length >= 12) {
    const m = s.match(/^(.{3,}?[，,])\s*(.{3,})$/u);
    if (m) pieces = [m[1].replace(/[，,]\s*$/u, '').trim(), m[2].trim()];
  }
  if (pieces.length <= 1) return [s];
  if (pieces.length <= max) return pieces;
  // 过多则合并尾部
  const head = pieces.slice(0, max - 1);
  const tail = pieces.slice(max - 1).join('');
  return [...head, tail];
}

export function compressNarration(text = '', maxChars = 72) {
  let t = String(text || '').trim();
  if (!t) return '';
  t = t.replace(NAME_OPEN, '');
  for (const re of INVENTORY_PATTERNS) t = t.replace(re, '');
  t = t.replace(LITERARY_FILLER, '');
  t = t.replace(/^[，、\s]+/, '').replace(/[，,]{2,}/g, '，').replace(/\s{2,}/g, ' ').trim();
  // 最多两句
  const sents = t.split(/(?<=[。！？…])\s*/u).filter((s) => s && s.trim());
  if (sents.length > 2) t = sents.slice(0, 2).join('');
  t = t.trim();
  if (t.length > maxChars) {
    t = t.slice(0, maxChars).replace(/[，,、；;\s]+$/u, '');
    if (!/[。！？…]$/u.test(t)) t += '…';
  }
  // 压完若只剩废词，丢弃旁白
  if (t.length < 4 || /^(她|他)[。！？]?$/u.test(t)) return '';
  return t;
}

export function compressDialogue(text = '', maxChars = 100, intimate = false) {
  let t = String(text || '').trim();
  if (!t) return '';
  // 去掉夹在台词里的动作括号长描写
  t = t.replace(/（[^）]{12,}）/g, '').replace(/\([^)]{12,}\)/g, '');
  for (const re of STOCK_DIALOGUE_TAILS) t = t.replace(re, '');
  t = t.replace(/\n{3,}/g, '\n\n').trim();

  // 亲密：保留换行便于后续拆气泡；句数上限放宽到 3 行
  if (intimate) {
    const lines = t.split(/\n+/).map((s) => s.trim()).filter(Boolean);
    if (lines.length > 3) t = lines.slice(0, 3).join('\n');
  }

  if (t.length > maxChars) {
    const sents = t.split(/(?<=[。！？…—])\s*/u).filter(Boolean);
    t = '';
    for (const s of sents) {
      if ((t + s).length > maxChars) break;
      t += s;
    }
    if (!t) t = String(text).trim().slice(0, maxChars);
  }
  return t.trim();
}

/**
 * 喂给模型的历史消毒：去掉旧网文旁白，避免 few-shot 自我污染。
 * 不改正文库（仅影响本轮 prompt）。
 */
export function sanitizeHistoryForPrompt(history = []) {
  if (!Array.isArray(history) || !history.length) return history;
  return history.map((turn) => {
    if (!turn || turn.role !== 'assistant') return turn;
    const content = compressAssistantHistory(turn.content);
    if (content === turn.content) return turn;
    return { ...turn, content };
  });
}

/** 把历史里「旁白长文 + 台词」压成更像真人回过的短内容 */
export function compressAssistantHistory(content = '') {
  const s = String(content || '').trim();
  if (!s) return s;

  // narration \n\n dialogue 常见结构
  const blocks = s.split(/\n\n+/).map((b) => b.trim()).filter(Boolean);
  if (blocks.length >= 2) {
    const head = blocks[0];
    const rest = blocks.slice(1).join('\n\n');
    const headIsNovel =
      NAME_OPEN.test(head) ||
      /散着的头发|丝质睡衣|半敞|往怀里|耳尖微热|沈清词/.test(head) ||
      head.length > 120;
    if (headIsNovel && rest.length >= 6) {
      // 只保留台词块，必要时极短旁白
      const shortNarr = compressNarration(head, 48);
      if (shortNarr && rest.length < 200) return `${shortNarr}\n\n${compressDialogue(rest, 140, true)}`;
      return compressDialogue(rest, 160, true);
    }
  }

  if (NAME_OPEN.test(s) || /沈清词(听|被|把|抬)/.test(s)) {
    let t = s.replace(NAME_OPEN, '');
    for (const re of INVENTORY_PATTERNS) t = t.replace(re, '');
    t = t.replace(/^[，、\s]+/, '').trim();
    if (t.length > 220) {
      // 取后半段（更可能是台词）
      const parts = t.split(/(?<=[。！？])\s*/u);
      t = parts.slice(Math.max(0, parts.length - 3)).join('');
    }
    return t || s.slice(-120);
  }

  if (s.length > 280) {
    const parts = s.split(/(?<=[。！？])\s*/u);
    return parts.slice(Math.max(0, parts.length - 4)).join('');
  }
  return s;
}

/** 亲密 JSON 格式的 few-shot + 硬约束（追加为最后一条 system） */
export const INTIMATE_REPLY_STYLE_LOCK = `【本轮输出·像真人硬锁·必遵】
你正在和同居恋人说话/做爱现场，不是写网文连载，也不是客服一问一答。

强制：
1) 像微信连发：优先 2～3 个短 dialogue part（每条一句），可夹 0～1 个短 narration。禁止单条长文回完。
2) narration ≤ 40 字；只写她侧当下这一下（被碰到→怎么变）。
3) 禁止：以「沈清词…」开场；禁止散着头发/丝质睡衣/半敞/往怀里嵌/耳尖微热。
4) 禁止：全知代写他的步骤、解剖学流水账、跟对方拼长文。
5) 禁止收尾复读：你真的一直想我吗 / 搂紧点别松手。
6) 节奏可不匀（喘、停、慢点/深一点）；每轮只推进一步。

合格（连发）：
{"parts":[{"type":"narration","text":"腿先夹紧。"},{"type":"dialogue","text":"嗯……"},{"type":"dialogue","text":"慢点。再深一点。"}]}

{"parts":[{"type":"dialogue","text":"手给我。"},{"type":"dialogue","text":"今天我带。你别抢。"}]}

不合格：一条 dialogue 把所有话写完；或网文长旁白。`;
