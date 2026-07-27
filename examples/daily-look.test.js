// 每日穿搭组合 + 成片生成
import assert from 'node:assert';
import {
  localDayKey,
  seedRng,
  composeDailyLook,
  enrichLookFromDrawers,
  ensureDailyLookState,
  shouldGenerateDailyPhoto,
  shouldShareDailyPhoto,
  generateDailyLookPhoto,
  markDailyPhotoShared,
  dailyAlbumCardId,
  buildDailyLookPrompt,
} from '../src/state/dailyLook.js';
import { normalizeWardrobe, defaultOutfitState } from '../src/state/outfit.js';
import { MockImageProvider } from '../src/appearance/provider.js';

let passed = 0;
const ok = (name, cond) => {
  assert.ok(cond, name);
  console.log('  ✓', name);
  passed++;
};

console.log('day key + seed');
{
  const k = localDayKey(Date.parse('2026-07-13T04:00:00+08:00'), 480);
  ok('东八区日键', k === '2026-07-13');
  const r1 = seedRng('2026-07-13|work');
  const r2 = seedRng('2026-07-13|work');
  ok('同 seed 可复现', r1() === r2() && r1() === r2());
}

console.log('compose + enrich');
{
  const wardrobe = normalizeWardrobe(null);
  const a = composeDailyLook({
    wardrobe,
    context: 'work',
    dailyKey: '2026-07-13',
    rotateAccessories: true,
  });
  const b = composeDailyLook({
    wardrobe,
    context: 'work',
    dailyKey: '2026-07-13',
    rotateAccessories: true,
  });
  ok('有 look', Boolean(a.look?.summary));
  ok('同日同情境稳定', a.look?.id === b.look?.id && a.look?.pieces?.bag === b.look?.pieces?.bag);
  ok('有鞋', Boolean(a.look?.pieces?.shoes));
  ok('composedFrom 有 lookId', Boolean(a.composedFrom?.lookId));

  const bare = {
    id: 'test_bare',
    context: 'date',
    summary: '黑色裙',
    pieces: { dress: '黑色裙' },
  };
  const en = enrichLookFromDrawers(bare, wardrobe, {
    context: 'date',
    dailyKey: '2026-07-13',
    rotateAccessories: true,
  });
  ok('空包被抽屉补上', Boolean(en.look.pieces.bag));
  ok('空鞋被抽屉补上', Boolean(en.look.pieces.shoes));
}

console.log('ensure daily state');
{
  const wardrobe = normalizeWardrobe(null);
  const empty = defaultOutfitState();
  const { state, composed } = ensureDailyLookState(empty, {
    wardrobe,
    now: Date.parse('2026-07-13T10:00:00+08:00'),
    config: {
      dailyLook: { enabled: true, autoCompose: true, rotateAccessories: true, timezoneOffsetMinutes: 480 },
    },
  });
  ok('跨日 compose', composed === true);
  ok('有 daily_key', state.daily_key === '2026-07-13');
  ok('有 current', Boolean(state.current?.summary));

  const again = ensureDailyLookState(state, {
    wardrobe,
    now: Date.parse('2026-07-13T18:00:00+08:00'),
    config: {
      dailyLook: { enabled: true, autoCompose: true, rotateAccessories: true, timezoneOffsetMinutes: 480 },
    },
  });
  ok('同日不重复 compose', again.composed === false);
  ok('同日保留 look', again.state.current?.id === state.current?.id);
}

console.log('prompt is person lookbook not product-only');
{
  const wardrobe = normalizeWardrobe(null);
  const { look, composedFrom, dailyKey } = composeDailyLook({
    wardrobe,
    context: 'date',
    dailyKey: '2026-07-13',
  });
  const outfit = {
    current: look,
    context: 'date',
    daily_key: dailyKey,
    composed_from: composedFrom,
  };
  const built = buildDailyLookPrompt({ outfit, emotion: { valence: 0.4 }, life: {} }, '瓜子脸精致五官', Date.now(), {
    hasReferences: true,
  });
  ok('人像 prompt', /woman|portrait|wearing/i.test(built.prompt));
  ok('含鞋', /shoe|footwear/i.test(built.prompt));
  ok('非纯产品禁人主导', !/^luxury product photography of a single item only/i.test(built.prompt));
}

console.log('photo generate mock');
{
  const wardrobe = normalizeWardrobe(null);
  const composed = composeDailyLook({ wardrobe, context: 'outing', dailyKey: '2026-07-13' });
  let outfit = {
    current: composed.look,
    context: 'outing',
    daily_key: composed.dailyKey,
    composed_from: composed.composedFrom,
    daily_photo: null,
  };
  ok('需要生成', shouldGenerateDailyPhoto(outfit).ok === true);

  const provider = new MockImageProvider();
  let savedAlbum = null;
  let savedAppearance = null;
  let written = null;

  const r1 = await generateDailyLookPhoto({
    outfit,
    appearance: 'elegant East Asian woman refined face',
    snapshot: { outfit, emotion: { valence: 0.5 }, life: {} },
    force: false,
    provider,
    getReferences: () => [],
    saveAlbum: async (cardId, payload) => {
      savedAlbum = { cardId, ...payload };
      return { ok: true, imageUrl: payload.url };
    },
    writeAppearance: async (asset) => {
      savedAppearance = asset;
    },
    writeOutfit: async (o) => {
      written = o;
    },
  });
  ok('生成成功', r1.ok === true && Boolean(r1.url));
  ok('album 卡 id', r1.albumCardId === dailyAlbumCardId('2026-07-13'));
  ok('写回 daily_photo', Boolean(written?.daily_photo?.url));
  ok('appearance tags 含 daily', (savedAppearance?.tags || []).includes('daily'));

  const r2 = await generateDailyLookPhoto({
    outfit: written,
    appearance: 'elegant East Asian woman refined face',
    provider,
    force: false,
  });
  ok('同日跳过', r2.skipped === true && r2.reason === 'already');

  const share0 = shouldShareDailyPhoto(written);
  ok('未分享可分享', share0.ok === true);
  const marked = markDailyPhotoShared(written);
  ok('标记后不可重复分享', shouldShareDailyPhoto(marked).ok === false);
}

console.log(`\ndaily-look 全部 ${passed} 条断言通过 ✅`);
