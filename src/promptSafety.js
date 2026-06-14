// P2 工程债 #9 · prompt 注入防护。
//
// 记忆里的 fact_core/narrative/content 来自用户对话与 LLM 提取, 不可信。
// 把它们拼进 system prompt (formatForPrompt/formatPersonaBlock/...) 前过一遍:
//   1) 折叠空白/换行 —— 防止一条记忆里藏的多行文本伪造出新的
//      "System:"/"###"/"[SYSTEM]" 段落, 跳出 "- 记忆条目" 的列表格式。
//   2) 命中"忽略以上指令"一类越权话术时, 整条替换成中性占位, 不参与拼接。
// 纯逻辑, 可离线单测。

const INJECTION_PATTERNS = [
  // "ignore/disregard previous/above instructions/rules" (英文越权话术)
  /\b(ignore|disregard)\b[^.!?。!?]{0,30}\b(previous|prior|above|earlier)\b[^.!?。!?]{0,20}\b(instructions?|prompts?|rules?)\b/i,
  // "忽略/无视 以上/之前/上述/前面 的 指令/提示/设定/规则/系统提示"
  /(忽略|无视)[^,。!?，！?]{0,10}(指令|提示词?|提示语|设定|规则|系统提示)/,
  // 伪造新的系统提示/指令段
  /new\s+(system\s+prompt|instructions?)\s*[:：]/i,
  /(新的?系统提示|新指令|系统提示词?)\s*[:：]/,
  // 伪造角色边界 / 标题, 跳出 "- 记忆条目" 列表项 —— 逐行匹配 (m), 不止首行
  /^\s*\[?(system|assistant|user)\]?\s*[:：]/im,
  /^\s*#{1,6}\s/m,
];

/** 文本是否看起来像 prompt 注入/越权指令。纯正则启发式, 宁可漏过也不要误杀正常记忆。 */
export function looksLikeInjection(text) {
  const s = String(text ?? '');
  return INJECTION_PATTERNS.some((re) => re.test(s));
}

/**
 * 把一条记忆文本变成可安全拼进 prompt 的形式:
 * 先在原文 (保留换行) 上判断是否像注入 —— 命中则整条替换为占位串;
 * 否则折叠空白/换行 (含 \r\n\t), 避免多行文本在列表里造出新段落。
 * @returns 处理后的文本; 原文本为空/纯空白则返回 ''
 */
export function sanitizeForPrompt(text) {
  const raw = String(text ?? '');
  if (!raw.trim()) return '';
  if (looksLikeInjection(raw)) return '[内容含可疑指令片段, 已过滤]';
  return raw.replace(/\s+/g, ' ').trim();
}
