// 穿搭 UI 卡片目录：从 outfit.json 展开 looks/bags/beauty/lingerie + 默认提示词

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildOutfitCatalog,
  defaultPromptForCard,
  lookToOutfitState,
  cardId,
} from '../src/state/outfitCards.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let passed = 0;
const ok = (name, cond) => {
  if (!cond) {
    console.error(`  ✗ ${name}`);
    process.exit(1);
  }
  console.log(`  ✓ ${name}`);
  passed++;
};

console.log('outfit cards catalog');

const rawFile = path.join(ROOT, 'companions/default/outfit.json');
const raw = JSON.parse(fs.readFileSync(rawFile, 'utf8'));
const outfit = raw.outfit || raw;
const cat = buildOutfitCatalog(outfit);

ok('有整套造型', cat.looks.length >= 10);
ok('有包柜卡片', cat.bags.length >= 5);
ok('有妆台卡片', cat.beauty.length >= 10);
ok('有内衣卡片', cat.lingerie.length >= 5);
ok('有鞋履柜', cat.shoes.length >= 8);
ok('高跟鞋在柜', cat.shoes.some((s) => /heel|高跟|Louboutin|Manolo|Jimmy/i.test(`${s.itemKind} ${s.title}`)));
ok('有珠宝盒', cat.jewelry.length >= 6);
ok('有表盘', cat.watches.length >= 3);
ok('有配饰', cat.accessories.length >= 5);
ok('有外套柜', cat.outerwear.length >= 4);
ok('有旅行箱', cat.travel.length >= 5);
ok('有四季主 look', cat.looks.filter((l) => l.season).length >= 4);
ok('有近视框配饰', cat.accessories.some((a) => /glasses|近视|光学|Lindberg|Cartier 金丝/i.test(`${a.itemKind} ${a.title}`)));
ok('有裸色或酒红晚装鞋', cat.shoes.some((s) => /裸|酒红|nude|wine/i.test(`${s.color || ''} ${s.title}`)));
ok('有上装分类', (cat.tops || []).length >= 1);
ok('有发型分类', (cat.hair || []).length >= 1);
ok('发型不在裙装里', !(cat.dresses || []).some((c) => /马尾|披肩发|盘发/.test(c.title) && !/裙/.test(c.title)));
ok('有单品汇总（兼容）', (cat.pieces || []).length >= 3);
ok('counts 对齐', cat.counts.looks === cat.looks.length && cat.counts.bags === cat.bags.length && cat.counts.shoes === cat.shoes.length);
ok('taxonomy 有大类', Array.isArray(cat.taxonomy) && cat.taxonomy.length >= 8);
ok('鞋有小类', cat.shoes.every((s) => s.category === 'shoes' && s.subcategory));

const look = cat.looks.find((x) => x.lookId === 'work_board') || cat.looks[0];
ok('造型可上身', look.wearable === true && Boolean(look.lookId));
ok('默认提示词含 luxury', /luxury|Luxury|editorial/i.test(look.defaultPrompt));
ok('cardId 稳定', cardId('look', 'work_board') === 'look:work_board');

const state = lookToOutfitState(look);
ok('上身状态有 summary', Boolean(state?.current?.summary));
ok('上身 context 同步', state.context === look.context);

const bagPrompt = defaultPromptForCard(cat.bags[0]);
ok('包提示词非空', bagPrompt.length > 40);

console.log(`\n${passed} passed`);
