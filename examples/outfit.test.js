// O 线穿搭系统纯逻辑测试
import assert from 'node:assert';
import {
  applyOutfitFromTurns,
  clampOutfitState,
  defaultOutfitState,
  detectOutfitIntent,
  evolveOutfitState,
  inferOutfitContext,
  normalizeWardrobe,
  pickOutfit,
  toOutfitPrompt,
  OutfitDimension,
} from '../src/state/outfit.js';
import { loadPersonaConfig } from '../src/companion.js';

let passed = 0;
function ok(name, condition) {
  assert.ok(condition, name);
  console.log('  ✓', name);
  passed++;
}

console.log('outfit pure logic');
ok('默认状态合法', clampOutfitState({}).context === 'home');
const ward = normalizeWardrobe(null);
ok('默认衣橱多套', ward.wardrobe.length >= 5);
ok('工作情境能选到职场装', pickOutfit(ward, 'work').context === 'work' || /西装|衬衫/.test(pickOutfit(ward, 'work').summary));
ok('深夜推断 home/sleep', ['home', 'sleep'].includes(inferOutfitContext({ hour: 1, life: {} })));
ok('健身活动推断 sport', inferOutfitContext({ hour: 10, life: { current_activity: '在健身' } }) === 'sport');

const evolved = evolveOutfitState(defaultOutfitState(), {
  hour: 10,
  life: { current_activity: '在公司开会' },
  wardrobe: ward,
  now: Date.now(),
});
ok('情境变化会生成 current', Boolean(evolved.current?.summary));
ok('prompt 含穿着且不要求每轮报', (toOutfitPrompt(evolved).includes('穿着') || toOutfitPrompt(evolved).includes('穿搭')) && toOutfitPrompt(evolved).includes('不要每轮'));

const intent = detectOutfitIntent('你今天穿什么？好看');
ok('识别询问穿搭', intent.ask === true);
const changed = applyOutfitFromTurns(evolved, [{ role: 'user', content: '换上我的衬衫' }], ward);
ok('对话可换衬衫装', changed.changed === true && /衬衫/.test(changed.state.current?.summary || ''));

console.log('companion outfit.json');
const persona = loadPersonaConfig('companions/default');
ok('沈清词有丰富衣橱', Boolean(persona?.config?.outfitWardrobe?.wardrobe?.length >= 10));
ok('有包柜', Boolean(persona?.config?.outfitWardrobe?.bags?.length >= 5));
ok('有妆台化妆品', Boolean(persona?.config?.outfitWardrobe?.beauty?.skincare?.length >= 3));
ok('衣橱品牌不廉价', /Hermès|Chanel|The Row|Loro|Dior|Cartier/.test(JSON.stringify(persona?.config?.outfitWardrobe)));
ok('有内衣抽屉', Boolean(persona?.config?.outfitWardrobe?.lingerie?.length >= 5));
ok('内衣含 La Perla 等', /La Perla|Agent Provocateur|Eres/.test(JSON.stringify(persona?.config?.outfitWardrobe?.lingerie)));
const workLook = pickOutfit(normalizeWardrobe(persona.config.outfitWardrobe), 'work');
ok('职场装会带内衣信息', Boolean(workLook.pieces?.lingerie || workLook.pieces?.bra));
const shoes = persona?.config?.outfitWardrobe?.shoes || [];
ok('有鞋履柜', shoes.length >= 8);
ok('有高跟鞋', shoes.some((s) => /heel|高跟|Louboutin|Manolo|Jimmy/i.test(`${s.kind || ''} ${s.label || s}`)));
ok('有珠宝盒', (persona?.config?.outfitWardrobe?.jewelry || []).length >= 5);
ok('有表盘', (persona?.config?.outfitWardrobe?.watches || []).length >= 3);
ok('有四季主 look', (persona?.config?.outfitWardrobe?.wardrobe || []).filter((w) => w.season).length >= 4);
ok('有旅行箱', (persona?.config?.outfitWardrobe?.travel || []).length >= 5);
ok('有旅行护肤 mini', (persona?.config?.outfitWardrobe?.beauty?.travel_mini || []).length >= 3);
const summer = pickOutfit(normalizeWardrobe(persona.config.outfitWardrobe), 'outing', {
  season: 'summer',
  now: Date.parse('2026-07-15T12:00:00+08:00'),
  rng: () => 0,
});
ok('夏季外出偏好夏季主 look', summer?.id === 'season_summer' || summer?.season === 'summer');

console.log('OutfitDimension mock IO');
{
  let row = defaultOutfitState();
  const dim = new OutfitDimension({
    userId: 'u_out',
    wardrobe: persona?.config?.outfitWardrobe,
    read: async () => row,
    write: async (_u, _c, v) => { row = v; return v; },
    now: () => Date.parse('2026-07-12T10:00:00+08:00'),
  });
  const snap = await dim.snapshot({ life: { current_activity: '在公司开会' } });
  ok('snapshot 工作日生成穿搭', Boolean(snap.current?.summary));
  await dim.evolve([{ role: 'user', content: '换上睡衣吧' }], { life: { current_activity: '在家' } });
  ok('evolve 可换睡衣', /睡|丝质|居家/.test(row.current?.summary || '') || row.context === 'sleep' || row.current?.id?.includes('sleep'));
}

console.log(`\nOutfit 全部 ${passed} 条断言通过`);
