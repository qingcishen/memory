// 穿搭相册：上身效果卡 + 默认提示词

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildAlbumCatalog,
  defaultWearingPrompt,
  albumCardId,
} from '../src/state/album.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
const ok = (name, cond) => {
  if (!cond) {
    console.error(`  ✗ ${name}`);
    process.exit(1);
  }
  console.log(`  ✓ ${name}`);
  passed++;
};

console.log('album catalog');
const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'companions/default/outfit.json'), 'utf8')).outfit;
const cat = buildAlbumCatalog(raw, [{ id: 'rain_exit', title: '雨夜下车', summary: '风衣与细跟', context: 'date' }]);

ok('每套造型有相册卡', cat.cards.filter((c) => c.source === 'look').length >= 10);
ok('含自定义卡', cat.cards.some((c) => c.source === 'custom'));
ok('card id 稳定', albumCardId('work_board') === 'album:look:work_board');
const sample = cat.cards.find((c) => c.lookId === 'work_board') || cat.cards[0];
ok('上身提示词强调穿着', /wearing|outfit|portrait/i.test(sample.defaultPrompt));
ok('defaultWearingPrompt 非空', defaultWearingPrompt({ summary: '黑裙', context: 'date' }).length > 40);
ok('counts.total 对齐', cat.counts.total === cat.cards.length);

console.log(`\n${passed} passed`);
