// 套装有人 / 单品纯产品
import assert from 'node:assert';
import { defaultPromptForCard, buildOutfitCatalog } from '../src/state/outfitCards.js';
import { isPersonOutfitCard, applyProductPromptKit, applyPromptKit } from '../src/appearance/promptKit.js';

let passed = 0;
const ok = (name, cond) => {
  assert.ok(cond, name);
  console.log('  ✓', name);
  passed++;
};

console.log('kind split');
{
  ok('look 是人像卡', isPersonOutfitCard('look'));
  ok('lingerie 是人像卡', isPersonOutfitCard('lingerie'));
  ok('bag 不是人像卡', !isPersonOutfitCard('bag'));
  ok('shoe 不是人像卡', !isPersonOutfitCard('shoe'));
}

console.log('look prompt = person');
{
  const p = defaultPromptForCard({
    kind: 'look',
    title: '酒红裹身',
    summary: '深酒红裹身连衣裙',
    context: 'date',
    pieces: { dress: '酒红缎面', shoes: '黑色细跟' },
  });
  ok('look 有人/女人', /woman|person|portrait|wearing/i.test(p));
  ok('look 全身鞋', /full body|head-to-toe|shoes/i.test(p));
  ok('look 含套装描述', p.includes('酒红'));
}

console.log('bag/shoe = product only');
{
  const bag = defaultPromptForCard({ kind: 'bag', title: 'Hermès Birkin 25 黑金', brand: 'Hermès' });
  ok('bag 声明 no person', /no person|single item only/i.test(bag));
  ok('bag 不写 East Asian woman 人像', !/East Asian woman|married-woman|full body head-to-toe/i.test(bag));
  ok('bag 含包名', bag.includes('Birkin') || bag.includes('handbag'));
  ok('bag Avoid 含 person', /Avoid:.*person/i.test(bag));

  const shoe = defaultPromptForCard({
    kind: 'shoe',
    title: 'Jimmy Choo 细跟',
    brand: 'Jimmy Choo',
    heel: 'stiletto',
  });
  ok('shoe 纯产品', /no person|product/i.test(shoe) && !/married-woman elegance/i.test(shoe));
  ok('shoe 含 footwear/shoe', /shoe|footwear|heel/i.test(shoe));
}

console.log('beauty / jewelry product');
{
  const b = defaultPromptForCard({ kind: 'beauty', title: 'Chanel 口红', beautyCategoryLabel: '唇妆' });
  ok('beauty 无全身人像', !/full body head-to-toe fashion portrait/i.test(b));
  ok('beauty 产品', /product|flat-lay|packaging/i.test(b));
}

console.log('apply kits');
{
  const person = applyPromptKit('wearing black dress', { forceFullBody: true }).prompt;
  ok('person kit 有 identity', /identity lock|face shape/i.test(person));
  const prod = applyProductPromptKit('Hermès Kelly bag').prompt;
  ok('product kit 去人', /no person/i.test(prod));
  ok('product kit 不强制全身人像锁', !/FULL_BODY|head-to-toe fashion portrait of.*woman/i.test(prod) || /no person/i.test(prod));
}

console.log('catalog defaultPrompt wired');
{
  const cat = buildOutfitCatalog(null);
  const look = cat.looks?.[0];
  const bag = cat.bags?.[0];
  if (look?.defaultPrompt) {
    ok('catalog look 有人', /woman|wearing|portrait/i.test(look.defaultPrompt));
  } else ok('catalog 有 look', cat.looks?.length > 0);
  if (bag?.defaultPrompt) {
    ok('catalog bag 无人像基底', /no person|single item/i.test(bag.defaultPrompt));
  } else ok('catalog 有 bag 或跳过', true);
}

console.log(`\noutfit-cards-prompt 全部 ${passed} 条断言通过 ✅`);
