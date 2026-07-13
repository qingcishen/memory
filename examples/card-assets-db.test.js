// Supabase 卡片资产：拼装与校验（不连网）

import {
  rowsToAssetMapLite,
  attachAssetsToCards,
  validateImagePayload,
  upsertAssetBody,
  listAssetsPath,
  MAX_IMAGE_BYTES,
} from '../src/state/cardAssetsDb.js';

let passed = 0;
const ok = (name, cond) => {
  if (!cond) {
    console.error(`  ✗ ${name}`);
    process.exit(1);
  }
  console.log(`  ✓ ${name}`);
  passed++;
};

console.log('card assets db helpers');

const map = rowsToAssetMapLite([
  { card_id: 'look:a', prompt: 'p1', mime: 'image/png', url: 'https://pub.example/a.webp', meta: { has_image: true }, updated_at: '2026-01-01' },
  { card_id: 'look:b', prompt: null, mime: null, meta: {} },
]);
ok('有图标记', map['look:a'].hasImage === true);
ok('无图标记', map['look:b'].hasImage === false);

const cards = attachAssetsToCards(
  [{ id: 'look:a', title: 'A', defaultPrompt: 'default' }, { id: 'look:b', title: 'B', defaultPrompt: 'defB' }],
  map,
  { companionId: 'default', collection: 'album' },
);
ok('自定义提示词优先', cards[0].prompt === 'p1');
ok('默认提示词回退', cards[1].prompt === 'defB');
ok('imageUrl 走 R2 公网', cards[0].imageUrl === 'https://pub.example/a.webp');
ok('无图无 url', cards[1].imageUrl === null);

const tiny = Buffer.from('hi').toString('base64');
const v = validateImagePayload({ mime: 'image/png', data: tiny });
ok('校验 png', v.mime === 'image/png' && v.base64 === tiny);

try {
  validateImagePayload({ mime: 'image/gif', data: tiny });
  ok('拒绝 gif', false);
} catch {
  ok('拒绝 gif', true);
}

const body = upsertAssetBody('default', 'outfit', 'look:x', {
  prompt: 'hello',
  mime: 'image/png',
  url: 'https://pub.example/x.png',
  r2_key: 'outfit/default/look:x.png',
});
ok('upsert 行含 collection', body.collection === 'outfit' && body.card_id === 'look:x');
ok('upsert 含 R2 url', body.url?.startsWith('https://') && body.r2_key);
ok('list path 合法', listAssetsPath('default', 'album').includes('companion_card_assets'));
ok('上限合理', MAX_IMAGE_BYTES >= 1024 * 1024);

console.log(`\n${passed} passed`);
