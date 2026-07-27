// 系列提示词解析（启发式）
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseLookSeriesHeuristic,
  extractPiecesFromLookText,
  buildSharedImagePrefix,
} from '../src/state/lookSeriesParse.js';
import { importSeriesLooks, readCustomLooks } from '../src/state/outfitCustomLooks.js';
import { buildOutfitCatalog } from '../src/state/outfitCards.js';

let passed = 0;
const ok = (name, cond) => {
  assert.ok(cond, name);
  console.log('  ✓', name);
  passed++;
};

const SAMPLE = `
仅参考上传图片中人物的脸型轮廓与五官比例这两项，锁定为同一个人。
成熟优雅的成年东方女性，这一组主题是「有韵味的衣服 + 人妻感超绝」概念摄影系列。
必须是完整全身时尚人像，鞋子必须完整清晰可见。

依次生成以下 8 张独立图片。

1 暖灰针织长裙：
身穿暖灰色修身针织连衣长裙，方领设计。外搭一件米杏色薄针织披肩。
脚穿裸米色尖头小猫跟鞋。站在窗边浅色客厅。发色为深巧克力棕，发型为松散低盘发。

2 酒红裹身裙：
身穿深酒红色裹身式连衣裙。脚穿黑色尖头细跟高跟鞋。餐桌旁。发色为雾霾栗棕，发型为空气感大波浪。

3 白衬衫 + 包臀长裙：
身穿微宽松白色真丝衬衫，下身搭配高腰深灰色包臀针织长裙。脚穿深灰色细跟高跟鞋。书房。

4 紫灰丝缎长裙：
身穿低饱和紫灰色丝缎收腰长裙。脚穿银灰色细带高跟凉鞋。

5 深蓝改良旗袍风：
身穿深蓝灰色改良旗袍式连衣裙。脚穿黑色玛丽珍细跟鞋。

6 奶油色羊绒套装：
身穿奶油米色高领贴身针织上衣，外搭同色短款羊绒开衫，下身是高腰燕麦色长裙。脚穿米白色穆勒高跟鞋。

7 墨绿色西装裙：
身穿低饱和墨绿色收腰西装裙。脚穿黑色漆皮尖头高跟鞋。

8 黑色轻熟晚间裙：
身穿黑色修身长袖连衣裙。脚穿黑色细带高跟凉鞋。

English reinforcement:
full body fashion portrait, shoes visible.
`;

console.log('extract pieces');
{
  const p = extractPiecesFromLookText(SAMPLE.split('1 暖灰')[1].split('2 酒红')[0]);
  ok('抽到裙', /针织|长裙|暖灰/.test(p.dress || ''));
  ok('抽到鞋', /裸米色|小猫跟|鞋/.test(p.shoes || ''));
}

console.log('heuristic series');
{
  const parsed = parseLookSeriesHeuristic(SAMPLE);
  ok('8 套', parsed.looks.length === 8);
  ok('系列标题含主题', /韵味|人妻|系列/.test(parsed.seriesTitle));
  ok('第1标题', /暖灰/.test(parsed.looks[0].title));
  ok('第2标题', /酒红/.test(parsed.looks[1].title));
  ok('有 imagePrompt', parsed.looks.every((l) => l.imagePrompt && l.imagePrompt.length > 80));
  ok('imagePrompt 含全身/鞋', /full body|shoes|鞋/i.test(parsed.looks[0].imagePrompt));
  ok('第1有 pieces.shoes', Boolean(parsed.looks[0].pieces?.shoes));
  const prefix = buildSharedImagePrefix(SAMPLE.slice(0, 400));
  ok('shared prefix 非空', prefix.length > 40);
}

console.log('import to custom looks');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'series-import-'));
  const parsed = parseLookSeriesHeuristic(SAMPLE);
  const { looks, seriesId } = importSeriesLooks(tmp, parsed);
  ok('导入 8 张', looks.length === 8);
  ok('同 seriesId', looks.every((l) => l.seriesId === seriesId));
  const list = readCustomLooks(tmp);
  const cat = buildOutfitCatalog(null, list);
  const seriesCards = cat.looks.filter((c) => c.seriesId === seriesId);
  ok('catalog 系列卡', seriesCards.length === 8);
  ok('可上身', seriesCards.every((c) => c.wearable));
  ok('有默认提示词', seriesCards.every((c) => (c.defaultPrompt || '').length > 40));
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\nlook-series-parse 全部 ${passed} 条断言通过 ✅`);
