/**
 * 穿搭系统分类树：大类 → 小类
 * UI 一级 Tab 用大类，二级 chip 用小类。
 */

/** @typedef {{ id: string, label: string, hint?: string, empty?: string, subs?: { id: string, label: string }[] }} SectionDef */

/** 大类顺序（展示用） */
export const OUTFIT_SECTIONS = /** @type {SectionDef[]} */ ([
  {
    id: 'looks',
    label: '整套造型',
    hint: '完整 look · 可上身 · 系列小相册',
    empty: '还没有造型',
  },
  {
    id: 'dresses',
    label: '裙装',
    hint: '连衣裙 · 裹身 · 旗袍 · 西装裙',
    empty: '还没有裙装',
    subs: [
      { id: 'all', label: '全部' },
      { id: 'knit', label: '针织裙' },
      { id: 'wrap', label: '裹身裙' },
      { id: 'qipao', label: '旗袍/改良' },
      { id: 'suit', label: '西装裙' },
      { id: 'satin', label: '缎面/丝质' },
      { id: 'evening', label: '晚装裙' },
      { id: 'skirt', label: '半身裙' },
      { id: 'other', label: '其他裙装' },
    ],
  },
  {
    id: 'tops',
    label: '上装',
    hint: '衬衫 · 针织 · 上衣',
    empty: '还没有上装',
    subs: [
      { id: 'all', label: '全部' },
      { id: 'shirt', label: '衬衫' },
      { id: 'knit', label: '针织/羊绒' },
      { id: 'blouse', label: '真丝/轻薄' },
      { id: 'tee', label: '休闲上装' },
      { id: 'other', label: '其他上装' },
    ],
  },
  {
    id: 'bottoms',
    label: '下装',
    hint: '西裤 · 休闲裤 · 半身等',
    empty: '还没有下装',
    subs: [
      { id: 'all', label: '全部' },
      { id: 'trousers', label: '西裤/长裤' },
      { id: 'casual', label: '休闲裤' },
      { id: 'skirt', label: '半身裙' },
      { id: 'other', label: '其他下装' },
    ],
  },
  {
    id: 'outerwear',
    label: '外套',
    hint: '大衣 · 西装 · 开衫 · 披肩',
    empty: '外套柜是空的',
    subs: [
      { id: 'all', label: '全部' },
      { id: 'coat', label: '大衣' },
      { id: 'blazer', label: '西装/外套' },
      { id: 'knit', label: '开衫/披肩' },
      { id: 'leather', label: '皮衣' },
      { id: 'other', label: '其他外套' },
    ],
  },
  {
    id: 'hair',
    label: '发型',
    hint: '盘发 · 马尾 · 波浪 · 披发',
    empty: '还没有发型',
    subs: [
      { id: 'all', label: '全部' },
      { id: 'updo', label: '盘发/发髻' },
      { id: 'ponytail', label: '马尾' },
      { id: 'waves', label: '波浪/卷发' },
      { id: 'down', label: '披发/直发' },
      { id: 'other', label: '其他发型' },
    ],
  },
  {
    id: 'shoes',
    label: '鞋履',
    hint: '高跟 · 乐福 · 靴 · 平底',
    empty: '鞋柜是空的',
    subs: [
      { id: 'all', label: '全部' },
      { id: 'heel', label: '高跟鞋' },
      { id: 'mule', label: '穆勒/半拖' },
      { id: 'loafer', label: '乐福' },
      { id: 'flat', label: '平底/芭蕾' },
      { id: 'boot', label: '靴' },
      { id: 'sandal', label: '凉鞋' },
      { id: 'sneaker', label: '球鞋' },
      { id: 'other', label: '其他鞋履' },
    ],
  },
  {
    id: 'bags',
    label: '包袋',
    hint: 'Birkin · Kelly · Chanel…',
    empty: '包柜是空的',
    subs: [
      { id: 'all', label: '全部' },
      { id: 'tophandle', label: '手提包/Kelly' },
      { id: 'tote', label: '托特' },
      { id: 'flap', label: '翻盖/Classic' },
      { id: 'mini', label: '迷你/相机包' },
      { id: 'other', label: '其他包' },
    ],
  },
  {
    id: 'lingerie',
    label: '内衣',
    hint: '套装 · 文胸 · 丝袜',
    empty: '抽屉是空的',
    subs: [
      { id: 'all', label: '全部' },
      { id: 'set', label: '套装' },
      { id: 'bra', label: '文胸' },
      { id: 'hosiery', label: '丝袜/吊带' },
      { id: 'other', label: '其他' },
    ],
  },
  {
    id: 'jewelry',
    label: '珠宝',
    hint: 'Cartier · VCA · 耳钉手链',
    empty: '珠宝盒是空的',
    subs: [
      { id: 'all', label: '全部' },
      { id: 'earring', label: '耳饰' },
      { id: 'necklace', label: '项链' },
      { id: 'bracelet', label: '手链/手镯' },
      { id: 'ring', label: '戒指' },
      { id: 'other', label: '其他珠宝' },
    ],
  },
  {
    id: 'watches',
    label: '腕表',
    hint: 'Tank · Rolex · 运动表',
    empty: '表盘是空的',
    subs: [
      { id: 'all', label: '全部' },
      { id: 'dress', label: '正装表' },
      { id: 'sport', label: '运动表' },
      { id: 'other', label: '其他表' },
    ],
  },
  {
    id: 'accessories',
    label: '配饰',
    hint: '丝巾 · 墨镜 · 腰带 · 眼镜',
    empty: '配饰是空的',
    subs: [
      { id: 'all', label: '全部' },
      { id: 'scarf', label: '丝巾/披肩' },
      { id: 'sunglasses', label: '墨镜' },
      { id: 'glasses', label: '近视/光学' },
      { id: 'belt', label: '腰带' },
      { id: 'hat', label: '帽子' },
      { id: 'other', label: '其他配饰' },
    ],
  },
  {
    id: 'beauty',
    label: '妆容护肤',
    hint: '护肤 · 底妆 · 眼唇 · 甲 · 香',
    empty: '妆台是空的',
    subs: [
      { id: 'all', label: '全部' },
      { id: 'skincare', label: '护肤' },
      { id: 'base', label: '底妆' },
      { id: 'eyes', label: '眼妆' },
      { id: 'lips', label: '唇妆' },
      { id: 'nails', label: '甲油' },
      { id: 'fragrance', label: '香氛' },
      { id: 'tools', label: '工具' },
      { id: 'travel_mini', label: '旅行 mini' },
      { id: 'other', label: '其他' },
    ],
  },
  {
    id: 'travel',
    label: '旅行',
    hint: 'Rimowa · 登机箱 · 套装',
    empty: '旅行箱是空的',
    subs: [
      { id: 'all', label: '全部' },
      { id: 'carryon', label: '登机箱' },
      { id: 'luggage', label: '托运/大箱' },
      { id: 'tote', label: '舱内托特' },
      { id: 'other', label: '其他' },
    ],
  },
]);

export const OUTFIT_SECTION_IDS = OUTFIT_SECTIONS.map((s) => s.id);

export function getSection(id) {
  return OUTFIT_SECTIONS.find((s) => s.id === id) || null;
}

/** 从标题/种类文本推断小类 */
export function inferSubcategory(sectionId, card = {}) {
  const blob = [
    card.title,
    card.summary,
    card.subtitle,
    card.itemKind,
    card.heel,
    card.beautyCategory,
    card.beautyCategoryLabel,
    card.kind,
    ...(card.tags || []),
  ]
    .filter(Boolean)
    .join(' ');

  switch (sectionId) {
    case 'dresses':
      if (/裹身|wrap/i.test(blob)) return 'wrap';
      if (/旗袍|改良旗袍|cheongsam|qipao/i.test(blob)) return 'qipao';
      if (/西装裙|套装裙|blazer dress|suit dress/i.test(blob)) return 'suit';
      if (/缎|丝缎|satin|silk dress|真丝裙/i.test(blob)) return 'satin';
      if (/针织裙|knit dress/i.test(blob)) return 'knit';
      if (/晚|晚宴|晚装|evening|cocktail/i.test(blob)) return 'evening';
      if (/半身|pencil skirt|A字裙|包臀裙(?!.*连衣)/i.test(blob) && !/连衣/.test(blob)) return 'skirt';
      if (/裙|dress/i.test(blob)) return 'other';
      return 'other';

    case 'tops':
      if (/衬衫|shirt|blouse 领/i.test(blob)) return 'shirt';
      if (/针织|羊绒|cashmere|knit|sweater|开衫上衣/i.test(blob)) return 'knit';
      if (/真丝|silk|轻薄|雪纺/i.test(blob)) return 'blouse';
      if (/T恤|tee|卫衣|休闲/i.test(blob)) return 'tee';
      return 'other';

    case 'bottoms':
      if (/西裤|直筒裤|西装裤|trousers|slacks/i.test(blob)) return 'trousers';
      if (/半身|裙/i.test(blob) && !/连衣/.test(blob)) return 'skirt';
      if (/休闲|牛仔|jogger|运动裤/i.test(blob)) return 'casual';
      return 'other';

    case 'outerwear':
      if (/大衣|coat|驼大衣|101801/i.test(blob)) return 'coat';
      if (/西装|blazer|jacket|外套(?!开衫)/i.test(blob)) return 'blazer';
      if (/开衫|披肩|cardigan|shawl|robe|晨袍/i.test(blob)) return 'knit';
      if (/皮衣|leather/i.test(blob)) return 'leather';
      return 'other';

    case 'hair':
      if (/盘发|发髻|低盘|updo|bun/i.test(blob)) return 'updo';
      if (/马尾|ponytail|低马尾|高马尾/i.test(blob)) return 'ponytail';
      if (/波浪|卷发|大卷|waves|curl/i.test(blob)) return 'waves';
      if (/披|直发|中长发|散发|down|straight/i.test(blob)) return 'down';
      return 'other';

    case 'shoes': {
      const kind = String(card.itemKind || card.heel || '');
      if (/heel|高跟|细跟|中跟|stiletto|pump/i.test(`${kind} ${blob}`)) return 'heel';
      if (/mule|穆勒|半拖/i.test(`${kind} ${blob}`)) return 'mule';
      if (/loafer|乐福/i.test(`${kind} ${blob}`)) return 'loafer';
      if (/flat|芭蕾|平底|ballet/i.test(`${kind} ${blob}`)) return 'flat';
      if (/boot|靴/i.test(`${kind} ${blob}`)) return 'boot';
      if (/sandal|凉鞋|Oran/i.test(`${kind} ${blob}`)) return 'sandal';
      if (/sneaker|球鞋|跑鞋|小白鞋/i.test(`${kind} ${blob}`)) return 'sneaker';
      return 'other';
    }

    case 'bags':
      if (/Kelly|Birkin|手提包|top.?handle/i.test(blob)) return 'tophandle';
      if (/Tote|托特|Book Tote|Margaux/i.test(blob)) return 'tote';
      if (/Classic|Flap|翻盖|22 /i.test(blob)) return 'flap';
      if (/迷你|mini|Camera|Lou |Jodie/i.test(blob)) return 'mini';
      return 'other';

    case 'lingerie': {
      const k = String(card.itemKind || card.kind || '');
      if (/hosiery|丝袜|吊带/i.test(`${k} ${blob}`)) return 'hosiery';
      if (/bra|文胸/i.test(`${k} ${blob}`)) return 'bra';
      if (/set|套装|bodysuit/i.test(`${k} ${blob}`)) return 'set';
      return 'other';
    }

    case 'jewelry':
      if (/耳|earring|ear/i.test(blob)) return 'earring';
      if (/项链|necklace|pendant/i.test(blob)) return 'necklace';
      if (/手链|手镯|bracelet|bangle/i.test(blob)) return 'bracelet';
      if (/戒|ring/i.test(blob)) return 'ring';
      return 'other';

    case 'watches':
      if (/sport|运动|Apple Watch|潜水/i.test(blob)) return 'sport';
      if (/Tank|Reverso|正装|dress/i.test(blob)) return 'dress';
      return 'other';

    case 'accessories': {
      const k = String(card.itemKind || '');
      if (/scarf|shawl|丝巾|披肩|方巾/i.test(`${k} ${blob}`)) return 'scarf';
      if (/sunglass|墨镜/i.test(`${k} ${blob}`)) return 'sunglasses';
      if (/glass|近视|光学|Lindberg/i.test(`${k} ${blob}`)) return 'glasses';
      if (/belt|腰带|皮带/i.test(`${k} ${blob}`)) return 'belt';
      if (/hat|帽/i.test(`${k} ${blob}`)) return 'hat';
      return 'other';
    }

    case 'beauty':
      return card.beautyCategory || 'other';

    case 'travel': {
      const k = String(card.itemKind || '');
      if (/carryon|登机|cabin/i.test(`${k} ${blob}`)) return 'carryon';
      if (/check|托运|luggage|L /i.test(`${k} ${blob}`)) return 'luggage';
      if (/tote|软托特|Bohème/i.test(`${k} ${blob}`)) return 'tote';
      return 'other';
    }

    default:
      return 'all';
  }
}

/** 给卡片打上 category / subcategory */
export function stampCardCategory(sectionId, card) {
  const sub = sectionId === 'looks' ? 'all' : inferSubcategory(sectionId, card);
  return {
    ...card,
    category: sectionId,
    subcategory: sub,
  };
}

export function filterBySubcategory(cards, subId) {
  if (!subId || subId === 'all') return cards || [];
  return (cards || []).filter((c) => (c.subcategory || 'other') === subId);
}
