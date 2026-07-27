// 自定义整套造型
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createCustomLook,
  readCustomLooks,
  deleteCustomLook,
  updateCustomLook,
  findCustomLook,
} from '../src/state/outfitCustomLooks.js';
import { buildOutfitCatalog, lookToOutfitState } from '../src/state/outfitCards.js';

let passed = 0;
const ok = (name, cond) => {
  assert.ok(cond, name);
  console.log('  ✓', name);
  passed++;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'outfit-custom-'));

console.log('create / read / wear shape');
{
  const look = createCustomLook(tmp, {
    title: '测试酒红晚宴',
    summary: '深酒红缎面裹身裙，Jimmy Choo 细跟，Chanel 小包',
    context: 'date',
    dress: '深酒红缎面裹身裙',
    shoes: 'Jimmy Choo 细跟',
    bag: 'Chanel 小包',
    prompt: 'full body woman wearing wine dress',
  });
  ok('有 id', String(look.id).startsWith('custom_'));
  ok('有 summary', /酒红/.test(look.summary));
  ok('pieces.dress', look.pieces?.dress?.includes('酒红'));
  ok('可穿状态', Boolean(lookToOutfitState({ lookId: look.id, ...look })?.current?.id));

  const list = readCustomLooks(tmp);
  ok('列表含新建', list.some((x) => x.id === look.id));

  const cat = buildOutfitCatalog(null, list);
  const card = cat.looks.find((c) => c.lookId === look.id);
  ok('catalog 有自定义卡', Boolean(card));
  ok('wearable', card.wearable === true);
  ok('source custom', card.source === 'custom');
  ok('defaultPrompt 用人像种子', /wine dress|酒红|woman|full body/i.test(card.defaultPrompt));

  const updated = updateCustomLook(tmp, look.id, { summary: '更新后的摘要，黑裙' });
  ok('可更新', updated?.summary.includes('更新后'));

  ok('find', findCustomLook(tmp, look.id)?.id === look.id);
  ok('删除', deleteCustomLook(tmp, look.id) === true);
  ok('删后找不到', !findCustomLook(tmp, look.id));
}

console.log(`\noutfit-custom-looks 全部 ${passed} 条断言通过 ✅`);

// cleanup
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
