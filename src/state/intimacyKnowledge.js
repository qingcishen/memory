// 亲密知识库 · 姿势/前戏/敏感点/节奏（纯逻辑）。
// 角色在 companions/*/intimacy.json 的 knowledge 里配置；运行时选子集注入 prompt，
// 并用 state.repertoire 避免连场只会一种姿势。

export const DEFAULT_INTIMACY_KNOWLEDGE = {
  positions: [
    { id: 'missionary', label: '正面', tags: ['深', '对视', '亲'], note: '便于亲与对视，角度好控' },
    { id: 'cowgirl', label: '骑乘', tags: ['主导', '磨', '深度可控'], note: '她主导时常用：慢慢磨，找敏感点' },
    { id: 'doggy', label: '后入', tags: ['深', '抱', '节奏'], note: '进得深，可从后面抱住，安全感强' },
    { id: 'spoon', label: '侧入 spoons', tags: ['慢', '贴', '事后也可'], note: '贴着做，适合慢与黏' },
    { id: 'lotus', label: '坐抱', tags: ['抱', '亲', '近'], note: '面对面坐抱，紧密' },
    { id: 'standing', label: '站位/靠墙', tags: ['急', '空间'], note: '靠墙或站立，节奏偏急' },
    { id: 'edge', label: '床边', tags: ['角度', '腿'], note: '她在床边，角度好发力' },
    { id: 'prone', label: '俯卧', tags: ['深', '压'], note: '趴着，贴背，深而闷' },
  ],
  foreplay: [
    { id: 'kiss', label: '深吻/颈侧', tags: ['前戏'] },
    { id: 'breast', label: '胸部与乳头', tags: ['敏感'] },
    { id: 'hand', label: '手指前戏', tags: ['湿', '准备'] },
    { id: 'oral', label: '口', tags: ['前戏', '敏感'] },
    { id: 'tease', label: '磨蹭不插', tags: ['撩', '急'] },
    { id: 'ear_neck', label: '耳后与锁骨', tags: ['轻'] },
  ],
  hotspots: [
    { id: 'nipples', label: '乳头', note: '同时刺激时反应大' },
    { id: 'clitoris', label: '阴蒂', note: '前戏与正戏都可兼顾' },
    { id: 'gspot', label: 'G点', note: '特定角度更容易到' },
    { id: 'neck', label: '脖颈', note: '亲咬会软' },
    { id: 'waist', label: '腰侧', note: '掐腰/搂腰带节奏' },
    { id: 'inner_thigh', label: '大腿内侧', note: '前戏敏感带' },
  ],
  pacing: [
    { id: 'slow_grind', label: '慢磨', note: '骑乘或贴着时控深度' },
    { id: 'deep_hold', label: '深顶停住', note: '顶到深处停一下' },
    { id: 'build', label: '由慢到快', note: '先适应再加速' },
    { id: 'edge', label: '边缘控制', note: '快到时放缓再推' },
  ],
  switches: [
    '同一场不要从头到尾只锁一个姿势，自然换 1～2 次',
    '她累或他快到时可改成她更省力/更可控的姿势',
    '换姿势用动作带，别像报菜名念姿势名',
  ],
};

/** 规范化角色 knowledge；缺省用默认全表。 */
export function normalizeIntimacyKnowledge(raw = null) {
  const base = DEFAULT_INTIMACY_KNOWLEDGE;
  if (!raw || typeof raw !== 'object') {
    return {
      positions: base.positions.map(cloneItem),
      foreplay: base.foreplay.map(cloneItem),
      hotspots: base.hotspots.map(cloneItem),
      pacing: base.pacing.map(cloneItem),
      switches: [...base.switches],
    };
  }
  return {
    positions: normalizeList(raw.positions, base.positions),
    foreplay: normalizeList(raw.foreplay, base.foreplay),
    hotspots: normalizeList(raw.hotspots, base.hotspots),
    pacing: normalizeList(raw.pacing, base.pacing),
    switches: Array.isArray(raw.switches) && raw.switches.length
      ? raw.switches.map(String).filter(Boolean).slice(0, 8)
      : [...base.switches],
  };
}

function normalizeList(list, fallback) {
  if (!Array.isArray(list) || list.length === 0) return fallback.map(cloneItem);
  return list
    .map((item, i) => {
      if (typeof item === 'string') return { id: `k${i}`, label: item, tags: [], note: '' };
      if (!item || typeof item !== 'object') return null;
      const label = String(item.label ?? item.name ?? item.id ?? '').trim();
      if (!label) return null;
      return {
        id: String(item.id ?? label).slice(0, 40),
        label: label.slice(0, 40),
        tags: Array.isArray(item.tags) ? item.tags.map(String).slice(0, 6) : [],
        note: String(item.note ?? '').slice(0, 80),
      };
    })
    .filter(Boolean)
    .slice(0, 24);
}

function cloneItem(item) {
  return { id: item.id, label: item.label, tags: [...(item.tags ?? [])], note: item.note ?? '' };
}

/** repertoire 会话记忆：最近用过的姿势 id，避免连场单一。 */
export function clampRepertoire(value = {}) {
  const last = Array.isArray(value?.last_positions)
    ? value.last_positions.map(String).filter(Boolean).slice(0, 6)
    : [];
  const focus = value?.focus_position ? String(value.focus_position).slice(0, 40) : null;
  const foreplayFocus = value?.focus_foreplay ? String(value.focus_foreplay).slice(0, 40) : null;
  return { last_positions: last, focus_position: focus, focus_foreplay: foreplayFocus };
}

/**
 * 为本场选一组知识提示：优先换姿势、兼顾前戏与敏感点。
 * @returns {{ position, foreplay, hotspot, pacing, avoidLabels: string[] }}
 */
export function pickIntimacyKnowledge(knowledge, repertoire = {}, phase = 'foreplay', rng = Math.random) {
  const k = normalizeIntimacyKnowledge(knowledge);
  const rep = clampRepertoire(repertoire);
  const recent = new Set(rep.last_positions);

  let positions = k.positions.filter((p) => !recent.has(p.id));
  if (positions.length === 0) positions = k.positions;
  // peak 略偏深度/主导；foreplay 略偏慢与前戏
  if (phase === 'peak') {
    const preferred = positions.filter((p) => (p.tags ?? []).some((t) => /深|主导|磨|抱/.test(t)));
    if (preferred.length) positions = preferred;
  } else if (phase === 'foreplay') {
    const preferred = positions.filter((p) => (p.tags ?? []).some((t) => /慢|贴|主导|近/.test(t)));
    if (preferred.length) positions = preferred;
  }

  const position = pickOne(positions, rng) ?? k.positions[0];
  const foreplay = pickOne(k.foreplay, rng);
  const hotspot = pickOne(k.hotspots, rng);
  const pacing = pickOne(k.pacing, rng);
  const avoidLabels = k.positions.filter((p) => recent.has(p.id)).map((p) => p.label).slice(0, 3);

  return { position, foreplay, hotspot, pacing, avoidLabels, switches: k.switches };
}

/** 把选中的知识写成内部指引（禁止当台词念姿势名清单）。 */
export function formatKnowledgePrompt(pick, phase = 'foreplay') {
  if (!pick?.position) return '';
  const lines = [];
  if (phase === 'foreplay' || phase === 'flirting') {
    lines.push(
      `前戏可侧重：${pick.foreplay?.label ?? '亲吻与触碰'}${pick.foreplay?.note ? `（${pick.foreplay.note}）` : ''}；敏感可照顾到${pick.hotspot?.label ?? '她熟悉的地方'}。`
    );
    lines.push(`若进入正戏，本场可自然用「${pick.position.label}」相关体位（${pick.position.note || pick.position.tags?.join('、') || '随感觉'}），用动作带，不要念姿势名。`);
  } else if (phase === 'peak') {
    lines.push(
      `本场体位多样性：可围绕「${pick.position.label}」做（${pick.position.note || '随节奏'}）；节奏参考「${pick.pacing?.label ?? '由慢到快'}」。`
    );
    if (pick.hotspot?.label) lines.push(`兼顾敏感：${pick.hotspot.label}${pick.hotspot.note ? `——${pick.hotspot.note}` : ''}。`);
    if (pick.avoidLabels?.length) {
      lines.push(`刚才已用过偏多的：${pick.avoidLabels.join('、')}——这轮尽量换一种感觉，别从头到尾一种姿势。`);
    } else {
      lines.push('同一场不要只锁一种姿势，自然换一次也可以。');
    }
  } else {
    return '';
  }
  lines.push('换姿势用身体带过去；dialogue 里禁止报菜名式念「我们来做某某式」。');
  return lines.map((l) => `- ${l}`).join('\n');
}

/** 从对话文本粗检是否提到某类姿势，用于写入 repertoire。 */
export function detectPositionMentions(text = '', knowledge = null) {
  const k = normalizeIntimacyKnowledge(knowledge);
  const s = String(text ?? '');
  const hit = [];
  const rules = [
    [/骑|坐上去|跨坐|磨/u, 'cowgirl'],
    [/后入|从后面|背后|趴/u, 'doggy'],
    [/正面|面对面|压着|躺下/u, 'missionary'],
    [/侧着|侧躺|勺子/u, 'spoon'],
    [/抱坐|坐抱|面对面坐/u, 'lotus'],
    [/靠墙|站着|抬腿/u, 'standing'],
    [/床边|坐在床/u, 'edge'],
    [/趴着|俯卧/u, 'prone'],
  ];
  for (const [re, id] of rules) {
    if (re.test(s) && k.positions.some((p) => p.id === id)) hit.push(id);
  }
  // 也匹配 label
  for (const p of k.positions) {
    if (p.label && s.includes(p.label) && !hit.includes(p.id)) hit.push(p.id);
  }
  return hit;
}

export function pushRepertoirePositions(repertoire, positionIds = []) {
  const rep = clampRepertoire(repertoire);
  const next = [...rep.last_positions];
  for (const id of positionIds) {
    if (!id) continue;
    const i = next.indexOf(id);
    if (i >= 0) next.splice(i, 1);
    next.unshift(id);
  }
  return clampRepertoire({
    ...rep,
    last_positions: next.slice(0, 6),
    focus_position: positionIds[0] ?? rep.focus_position,
  });
}

function pickOne(list, rng) {
  if (!list?.length) return null;
  const i = Math.min(list.length - 1, Math.max(0, Math.floor(rng() * list.length)));
  return list[i];
}
