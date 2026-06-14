// A1 纯逻辑/骨架测试: 出图 provider(mock) + 自拍策略 + 图库命中。不连网, 注入假 read/write/provider。
import assert from 'node:assert';
import { MockImageProvider, HttpImageProvider } from '../src/appearance/provider.js';
import { shouldSendSelfie, canSendSelfie, buildSelfiePrompt, Selfie } from '../src/appearance/selfie.js';

let passed = 0;
const ok = (name, cond) => {
  assert.ok(cond, name);
  console.log('  ✓', name);
  passed++;
};

const now = new Date(2026, 5, 15, 14, 0, 0).getTime();

console.log('MockImageProvider (不出真图, 结构稳定可重现)');
{
  const p = new MockImageProvider();
  const a = await p.generate('一个女生, 笑容明媚');
  const b = await p.generate('一个女生, 笑容明媚');
  ok('返回 {url, seed, meta}', a.url && a.seed && a.meta);
  ok('url 是占位 mock://', a.url.startsWith('mock://selfie/'));
  ok('同 prompt → 同 url/seed (可重现)', a.url === b.url && a.seed === b.seed);
  ok('meta 标注 provider=mock', a.meta.provider === 'mock');
}

console.log('HttpImageProvider (未配置 endpoint 时降级 mock, 不崩)');
{
  const h = new HttpImageProvider({});
  const r = await h.generate('test');
  ok('无 endpoint → 降级 mock url', r.url.startsWith('mock://'));
}

console.log('shouldSendSelfie (被状态触发, 不是随机/有求必应)');
{
  const happyClose = { emotion: { valence: 0.5, warmth: 0.8 }, life: { current_activity: '在追剧' } };
  ok('亲密 + 心情好 → 主动发', shouldSendSelfie(happyClose, {}, now).ok === true);

  const notClose = { emotion: { valence: 0.5, warmth: 0.3 }, life: {} };
  ok('不够亲密 → 不主动', shouldSendSelfie(notClose, {}, now).ok === false);
  ok('不够亲密但被明确要求 → 放行', shouldSendSelfie(notClose, { requested: true }, now).ok === true);

  const sick = { emotion: { valence: 0.5, warmth: 0.9 }, life: { sick_until: new Date(now + 3600000).toISOString() } };
  ok('生病 → 不发自拍 (即便被要求)', shouldSendSelfie(sick, { requested: true }, now).ok === false);

  const flat = { emotion: { valence: 0, warmth: 0.8 }, life: { current_activity: '在工作' } };
  ok('够亲密但无正向情境 → 不主动', shouldSendSelfie(flat, {}, now).ok === false);
  const workout = { emotion: { valence: 0, warmth: 0.8 }, life: { current_activity: '刚健身完, 有点累但很爽' } };
  ok('刚健身完 → 主动 (post_workout)', shouldSendSelfie(workout, {}, now).reason === 'post_workout');
}

console.log('canSendSelfie (冷却 + 每日上限)');
{
  ok('无历史 → 可发', canSendSelfie({}, now).ok === true);
  const justSent = { sentAt: [new Date(now - 60 * 1000).toISOString()] };
  ok('刚发过 → cooldown 拦住', canSendSelfie(justSent, now).reason === 'cooldown');
  const twoToday = { sentAt: [new Date(now - 13 * 3600000).toISOString(), new Date(now - 14 * 3600000).toISOString()] };
  ok('今日已达上限 → daily_limit', canSendSelfie(twoToday, now).reason === 'daily_limit');
}

console.log('buildSelfiePrompt (状态修饰 + tags 命中)');
{
  const happy = buildSelfiePrompt({ emotion: { valence: 0.5 }, life: { current_activity: '在追剧' } }, '齐肩黑发, 米色毛衣', now);
  ok('prompt 含角色外貌描述', happy.prompt.includes('齐肩黑发'));
  ok('心情好 → happy tag + 笑容', happy.tags.includes('happy') && happy.prompt.includes('笑容'));

  const sick = buildSelfiePrompt({ emotion: {}, life: { sick_until: new Date(now + 3600000).toISOString() } }, '银发', now);
  ok('生病 → sick tag + 憔悴', sick.tags.includes('sick') && sick.prompt.includes('憔悴'));
}

console.log('Selfie 门面 (图库命中复用; miss 则出图入库)');
{
  const writes = [];
  const provider = new MockImageProvider();

  // 命中: read 返回一条
  const cachedSelfie = new Selfie({
    userId: 'u1',
    companionId: 'keke',
    provider,
    read: async () => ({ url: 'mock://cached.png', seed: 's1' }),
    write: async (...a) => writes.push(a),
  });
  const r1 = await cachedSelfie.selfie({ emotion: { valence: 0.5 }, life: {} }, { appearance: '黑发', now });
  ok('图库命中 → 复用, 不再出图入库', r1.cached === true && r1.url === 'mock://cached.png' && writes.length === 0);

  // miss: read 返回 null → 出图并入库
  const freshSelfie = new Selfie({
    userId: 'u1',
    companionId: 'keke',
    provider,
    read: async () => null,
    write: async (uid, cid, asset) => writes.push({ uid, cid, asset }),
  });
  const r2 = await freshSelfie.selfie({ emotion: { valence: 0.5 }, life: {} }, { appearance: '黑发', now });
  ok('图库 miss → 出图 (cached=false)', r2.cached === false && r2.url.startsWith('mock://selfie/'));
  ok('miss → 入库一条', writes.length === 1 && writes[0].asset.url === r2.url);
  ok('入库带状态 tags', Array.isArray(writes[0].asset.tags) && writes[0].asset.tags.includes('happy'));
}

console.log(`\nA1 外貌骨架 全部 ${passed} 条断言通过`);
