/**
 * 系列造型提示词解析：把「1 暖灰… 2 酒红…」拆成多张 look 卡。
 * - 启发式：离线可测、DeepSeek 失败时兜底
 * - LLM（DeepSeek）：补全 pieces / 情境 / 独立 imagePrompt
 */

import crypto from 'node:crypto';
import { OUTFIT_CONTEXTS } from './outfit.js';

/** 编号分割：支持 `1.` `1、` `1：` 或 `1 暖灰针织长裙：` */
const SPLIT_RE = /(?:^|\n)\s*(\d{1,2})(?:\s*[.、．)）:：]\s*|\s+(?=[^\d\s]))/g;

/** 从单条造型正文抽裙/鞋/包/发等 */
export function extractPiecesFromLookText(text = '') {
  const s = String(text || '');
  const pieces = {};
  const take = (key, re) => {
    const m = s.match(re);
    if (m?.[1]) pieces[key] = m[1].replace(/[。；;].*$/, '').trim().slice(0, 120);
  };
  // 身穿…裙 / 连衣裙
  take('dress', /身穿([^。\n]{4,80}?(?:裙|连衣裙|旗袍|袍))/);
  if (!pieces.dress) take('dress', /(?:裙装|长裙|短裙)[：:]\s*([^。\n]{4,80})/);
  // 衬衫+裙组合
  if (/衬衫/.test(s) && /裙/.test(s) && !pieces.dress) {
    const top = s.match(/身穿([^。\n]{4,60}衬衫[^。\n]{0,40})/);
    const bot = s.match(/(高腰[^。\n]{0,40}裙|包臀[^。\n]{0,30}裙)/);
    if (top) pieces.top = top[1].slice(0, 120);
    if (bot) pieces.bottom = bot[1].slice(0, 120);
  }
  take('outer', /外搭([^。\n]{4,60}?(?:披肩|开衫|外套|西装|大衣))/);
  take('shoes', /脚穿([^。\n]{4,80})/);
  if (!pieces.shoes) take('shoes', /鞋[：:]\s*([^。\n]{4,60})/);
  take('bag', /(?:手提包|腋下包|托特|手包|小包|背包)[：:]?\s*([^。\n]{2,60})/);
  take('hair', /发型为([^。\n]{2,40})/);
  if (!pieces.hair) {
    const color = s.match(/发色为([^。\n]{2,30})/);
    const style = s.match(/发型为([^。\n]{2,40})/);
    if (color || style) pieces.hair = [color?.[1], style?.[1]].filter(Boolean).join('，').slice(0, 120);
  }
  take('jewelry', /(?:耳饰|项链|手链|腕表|腰带)[：:]?\s*([^。\n]{2,50})/);
  // 西装裙 / 套装
  if (!pieces.dress && !pieces.top) {
    take('dress', /身穿([^。\n]{4,80}?(?:套装|西装裙))/);
  }
  return pieces;
}

function inferContextFromText(text = '') {
  const s = String(text);
  if (/书房|办公|西装|工作/.test(s)) return 'work';
  if (/晚|晚宴|夜|露台|夜景|约会/.test(s)) return 'date';
  if (/客厅|卧室|居家|沙发|窗边|餐桌/.test(s)) return 'home';
  if (/外出|街|城市/.test(s)) return 'outing';
  return 'home';
}

function splitNumberedBlocks(text) {
  const src = String(text || '').replace(/\r\n/g, '\n');
  const matches = [...src.matchAll(SPLIT_RE)];
  if (matches.length < 2) return { preamble: src, blocks: [] };

  const preamble = src.slice(0, matches[0].index).trim();
  const blocks = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : src.length;
    const index = Number(matches[i][1]);
    let body = src.slice(start, end).trim();
    // 去掉块尾 English / Negative 全局段
    body = body
      .replace(/\nEnglish reinforcement:[\s\S]*$/i, '')
      .replace(/\nNegative prompt:[\s\S]*$/i, '')
      .trim();
    if (!body) continue;
    // 标题：首行到冒号，或前 20 字
    let title = '';
    let rest = body;
    const titleM = body.match(/^([^\n：:]{2,40})[：:]\s*\n?/);
    if (titleM) {
      title = titleM[1].trim();
      rest = body.slice(titleM[0].length).trim();
    } else {
      const firstLine = body.split('\n')[0].trim();
      title = firstLine.slice(0, 24);
      rest = body;
    }
    blocks.push({ index, title, body: rest || body, raw: body });
  }
  return { preamble, blocks };
}

/** 从 preamble 抽出适合拼进每张图的共享段（去掉「依次生成8张」指令） */
export function buildSharedImagePrefix(preamble = '') {
  let p = String(preamble || '');
  p = p
    .replace(/依次生成以下[\s\S]*?(?=\n\s*1\s*[.、．)）:：]|$)/g, '')
    .replace(/一张一张分别输出[\s\S]*$/g, '')
    .replace(/不要拼图[\s\S]*$/g, '')
    .trim();
  // 压短：保留脸锁 + 气质 + 全身鞋履硬规则要点
  const chunks = [];
  if (/脸型|五官|身份|reference|同一人/i.test(p)) {
    chunks.push(
      'Use reference image ONLY for face shape and facial proportions. Same adult East Asian woman identity. ' +
        'Do not copy expression, pose, outfit, or mood from reference.',
    );
  }
  if (/人妻|成熟|韵味|温柔|克制/.test(p)) {
    chunks.push(
      'mature elegant adult East Asian woman, refined sophisticated presence, tasteful femininity, ' +
        'fully clothed, classy non-vulgar high-end lifestyle aesthetic.',
    );
  }
  chunks.push(
    'Photorealistic full-body head-to-toe fashion portrait, feet not cropped, shoes fully visible, no barefoot. ' +
      'Natural skin pores, soft film grain, low saturation, shallow DOF.',
  );
  // 若 preamble 较短也并入一部分中文气质句
  const zhBits = p
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l && /成熟|韵味|女人味|同一个人|皮肤|全身|鞋子/.test(l) && l.length < 120)
    .slice(0, 4);
  if (zhBits.length) chunks.push(zhBits.join(' '));
  return chunks.join(' ').slice(0, 1800);
}

export function buildLookImagePrompt({ sharedPrefix, title, body, englishTail = '' }) {
  const lookPart = [
    title ? `Look title: ${title}.` : '',
    body,
    'Full-length figure in frame, complete outfit readable, shoes fully visible and clearly described.',
  ]
    .filter(Boolean)
    .join('\n');
  const eng =
    englishTail ||
    'Realistic editorial fashion photography, mature elegant styling, classy non-vulgar, single person only.';
  const negative =
    'Avoid: minor, underage, schoolgirl, vulgar, barefoot, missing shoes, cropped feet, collage, grid, multiple panels, multiple people, low quality, plastic skin.';
  return [sharedPrefix, lookPart, eng, negative].filter(Boolean).join('\n\n').slice(0, 6000);
}

/**
 * 纯启发式解析（可单测）
 * @returns {{ seriesTitle, seriesId, sharedPrefix, looks: Array }}
 */
export function parseLookSeriesHeuristic(text = '') {
  const src = String(text || '').trim();
  if (!src) throw new Error('提示词为空');
  const { preamble, blocks } = splitNumberedBlocks(src);
  if (blocks.length < 1) {
    // 整段当作 1 张
    const pieces = extractPiecesFromLookText(src);
    const title = (src.match(/^(.{2,24})/) || [])[1] || '自定义造型';
    return {
      seriesTitle: title,
      seriesId: `series_${crypto.randomBytes(4).toString('hex')}`,
      sharedPrefix: buildSharedImagePrefix(src.slice(0, 800)),
      method: 'heuristic',
      looks: [
        {
          index: 1,
          title: title.slice(0, 40),
          summary: src.slice(0, 200),
          context: inferContextFromText(src),
          pieces,
          body: src.slice(0, 2000),
          imagePrompt: buildLookImagePrompt({
            sharedPrefix: buildSharedImagePrefix(src.slice(0, 600)),
            title,
            body: src.slice(0, 2000),
          }),
        },
      ],
    };
  }

  // English tail 常在编号块之后
  let englishTail = '';
  const engIdx = src.search(/\nEnglish reinforcement:|\nNegative prompt:/i);
  // english is usually after all numbered blocks - grab from last block cut
  const afterLast = (() => {
    const last = blocks[blocks.length - 1];
    // not stored; re-scan
    const m = src.match(/\nEnglish reinforcement:[\s\S]*$/i);
    return m ? m[0].trim() : '';
  })();
  if (afterLast) englishTail = afterLast.slice(0, 1200);

  const sharedPrefix = buildSharedImagePrefix(preamble);
  const themeM = preamble.match(/「([^」]{4,40})」/) || preamble.match(/主题是[「"]?([^」"\n]{4,40})/);
  const seriesTitle = themeM?.[1]?.trim() || `造型系列 ${blocks.length} 张`;
  const seriesId = `series_${crypto.randomBytes(4).toString('hex')}`;

  const looks = blocks.map((b) => {
    // 去掉块尾的 English 段
    let body = b.raw
      .replace(/\nEnglish reinforcement:[\s\S]*$/i, '')
      .replace(/\nNegative prompt:[\s\S]*$/i, '')
      .trim();
    const titleM = body.match(/^([^\n：:]{2,40})[：:]\s*/);
    let title = b.title;
    if (titleM) {
      title = titleM[1].trim();
      body = body.slice(titleM[0].length).trim();
    }
    const pieces = extractPiecesFromLookText(`${title}。${body}`);
    const summary = [title, pieces.dress || pieces.top, pieces.shoes].filter(Boolean).join(' · ').slice(0, 200);
    return {
      index: b.index,
      title: title.slice(0, 40),
      summary: summary || body.slice(0, 120),
      context: inferContextFromText(body),
      pieces,
      body: body.slice(0, 2500),
      imagePrompt: buildLookImagePrompt({
        sharedPrefix,
        title,
        body: body.slice(0, 2200),
        englishTail: englishTail.slice(0, 800),
      }),
    };
  });

  return {
    seriesTitle,
    seriesId,
    sharedPrefix,
    method: 'heuristic',
    looks,
  };
}

const LLM_SYSTEM = `你是时尚造型提示词结构化助手。用户会粘贴「一套系列提示词」（含身份锁 + 编号 1..N 多张造型）。
请拆成 JSON，不要 markdown。字段：
{
  "seriesTitle": "短标题",
  "looks": [
    {
      "index": 1,
      "title": "造型短名",
      "summary": "一句话穿着摘要（中文）",
      "context": "home|work|date|outing|sport|sleep|intimate|sick",
      "pieces": {
        "dress": "可选",
        "top": "可选",
        "bottom": "可选",
        "outer": "可选",
        "shoes": "必填尽量写清",
        "bag": "可选",
        "hair": "发色+发型",
        "jewelry": "可选"
      },
      "lookBody": "该张造型的中文正文（服装姿态场景），不含通用身份锁长文",
      "imagePrompt": "可直接给文生图的完整英文+中文混合提示词：含身份锁短句、该造型细节、全身鞋履、禁止拼图与幼态"
    }
  ]
}
规则：
- 每张 imagePrompt 必须独立完整，可单独出一张全身图
- 不要内衣/内裤/透明衣/擦边描写
- 必须强调 full body、鞋子完整可见、非赤脚
- looks 数量与编号一致（通常 6～12）`;

/**
 * DeepSeek / OpenAI 兼容 chat 解析
 */
export async function parseLookSeriesWithLlm(text, {
  baseURL = 'https://api.deepseek.com',
  apiKey = '',
  model = 'deepseek-chat',
  fetchImpl = globalThis.fetch,
  timeoutMs = 90_000,
} = {}) {
  if (!apiKey) throw new Error('未配置 LLM_API_KEY（DeepSeek）');
  const base = String(baseURL || '').replace(/\/+$/, '');
  const heuristic = parseLookSeriesHeuristic(text);
  const res = await fetchImpl(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: 8192,
      messages: [
        { role: 'system', content: LLM_SYSTEM },
        {
          role: 'user',
          content: `请解析下列系列提示词为 JSON。\n\n---\n${String(text).slice(0, 14000)}\n---`,
        },
      ],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(data?.error?.message || `LLM HTTP ${res.status}`);
  }
  const content = data?.choices?.[0]?.message?.content || '';
  const jsonStr = extractJsonObject(content);
  if (!jsonStr) {
    return { ...heuristic, method: 'heuristic_fallback', llmError: '模型未返回 JSON' };
  }
  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return { ...heuristic, method: 'heuristic_fallback', llmError: 'JSON 解析失败' };
  }
  const looksIn = Array.isArray(parsed.looks) ? parsed.looks : [];
  if (!looksIn.length) {
    return { ...heuristic, method: 'heuristic_fallback', llmError: 'looks 为空' };
  }
  const sharedPrefix = heuristic.sharedPrefix;
  const looks = looksIn.map((item, i) => {
    const title = String(item.title || `造型 ${i + 1}`).slice(0, 40);
    const body = String(item.lookBody || item.body || item.summary || '').slice(0, 2500);
    const pieces = {
      ...extractPiecesFromLookText(`${title} ${body}`),
      ...(item.pieces && typeof item.pieces === 'object' ? item.pieces : {}),
    };
    // 清理空 pieces
    for (const k of Object.keys(pieces)) {
      if (!pieces[k]) delete pieces[k];
      else pieces[k] = String(pieces[k]).slice(0, 120);
    }
    const imagePrompt = String(item.imagePrompt || '').trim()
      || buildLookImagePrompt({ sharedPrefix, title, body });
    const ctx = OUTFIT_CONTEXTS.includes(item.context) ? item.context : inferContextFromText(body);
    return {
      index: Number(item.index) || i + 1,
      title,
      summary: String(item.summary || title).slice(0, 200),
      context: ctx,
      pieces,
      body,
      imagePrompt: imagePrompt.slice(0, 6000),
    };
  });
  return {
    seriesTitle: String(parsed.seriesTitle || heuristic.seriesTitle).slice(0, 80),
    seriesId: heuristic.seriesId,
    sharedPrefix,
    method: 'llm',
    looks,
  };
}

function extractJsonObject(text) {
  const s = String(text || '');
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : s;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return raw.slice(start, end + 1);
}

/**
 * 高层：优先 LLM，失败回退启发式
 */
export async function parseLookSeries(text, opts = {}) {
  const useLlm = opts.useLlm !== false && opts.apiKey;
  if (useLlm) {
    try {
      return await parseLookSeriesWithLlm(text, opts);
    } catch (error) {
      const h = parseLookSeriesHeuristic(text);
      return { ...h, method: 'heuristic_fallback', llmError: error.message || String(error) };
    }
  }
  return parseLookSeriesHeuristic(text);
}
