// A1 纯逻辑/骨架测试: 出图 provider(mock) + 自拍策略 + 图库命中。不连网, 注入假 read/write/provider。
import assert from 'node:assert';
import { MockImageProvider, HttpImageProvider, OpenAIImageProvider, withLoraTrigger } from '../src/appearance/provider.js';
import { shouldSendSelfie, canSendSelfie, buildSelfiePrompt, buildScenePrompt, decidePhoto, Selfie } from '../src/appearance/selfie.js';

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

console.log('OpenAIImageProvider (Seedream/OpenAI 兼容图片接口)');
{
  let request = null;
  const p = new OpenAIImageProvider({
    baseURL: 'https://ark.test/api/v3/',
    apiKey: 'secret',
    model: 'seedream-pro',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ data: [{ url: 'https://cdn.test/generated.png' }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    },
  });
  const img = await p.generate('一个自然自拍');
  ok('调用标准 /images/generations', request.url === 'https://ark.test/api/v3/images/generations');
  ok('使用 Bearer 鉴权', request.options.headers.authorization === 'Bearer secret');
  const body = JSON.parse(request.options.body);
  ok('请求带模型和提示词', body.model === 'seedream-pro' && body.prompt === '一个自然自拍');
  ok('读取返回图片 URL', img.url === 'https://cdn.test/generated.png');
}

console.log('OpenAIImageProvider (GPT Image Base64 响应)');
{
  let requestBody = null;
  const p = new OpenAIImageProvider({
    baseURL: 'https://api.openai.test/v1',
    apiKey: 'openai-secret',
    model: 'gpt-image-2',
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return new Response(JSON.stringify({ data: [{ b64_json: 'aW1hZ2U=' }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    },
  });
  const img = await p.generate('角色自拍', {
    size: '1536x1536', quality: 'high', background: 'opaque',
    output_format: 'webp', output_compression: 100,
  });
  ok('GPT Image 不发送 response_format=url', !('response_format' in requestBody));
  ok('GPT Image 传递全部输出参数', requestBody.size === '1536x1536' && requestBody.quality === 'high'
    && requestBody.background === 'opaque' && requestBody.output_format === 'webp'
    && requestBody.output_compression === 100);
  ok('GPT Image Base64 使用正确 MIME', img.url === 'data:image/webp;base64,aW1hZ2U=');
}

console.log('LoRA trigger (角色一致性触发词)');
{
  ok('有 LoRA trigger 时自动前置', withLoraTrigger('手机自拍', { loraTrigger: 'shiya_v2' }).startsWith('shiya_v2, '));
  ok('prompt 已包含 trigger 时不重复', withLoraTrigger('shiya_v2, 手机自拍', { loraTrigger: 'shiya_v2' }) === 'shiya_v2, 手机自拍');
}

console.log('OpenAIImageProvider (多参考图编辑接口)');
{
  let request = null;
  const p = new OpenAIImageProvider({
    baseURL: 'https://api.openai.test/v1', apiKey: 'secret', model: 'gpt-image-2',
    defaults: { size: '1024x1536', quality: 'high', output_format: 'png', input_fidelity: 'high' },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ data: [{ b64_json: 'aW1hZ2U=' }], usage: { total_tokens: 123 } }), { status: 200 });
    },
  });
  const img = await p.edit('保持人物特征，生成手机竖图', [
    { buffer: Buffer.from('one'), mime: 'image/png', name: 'one.png' },
    { buffer: Buffer.from('two'), mime: 'image/jpeg', name: 'two.jpg' },
  ]);
  ok('调用 /images/edits', request.url.endsWith('/images/edits'));
  ok('multipart 包含两张参考图', request.options.body.getAll('image[]').length === 2);
  ok('gpt-image-2 自动省略不支持的 input_fidelity', request.options.body.get('input_fidelity') === null);
  ok('编辑请求保留竖图尺寸', request.options.body.get('size') === '1024x1536');
  ok('编辑响应带 usage 元数据', img.meta.referenceCount === 2 && img.meta.usage.total_tokens === 123);
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
  ok('心情好 → happy tag + 成熟温柔神态', happy.tags.includes('happy') && /soft warm|married-woman|mature/i.test(happy.prompt));
  ok('含身份锁 face shape/proportions', /face shape|facial|identity lock/i.test(happy.prompt));

  const sick = buildSelfiePrompt({ emotion: {}, life: { sick_until: new Date(now + 3600000).toISOString() } }, '银发', now);
  ok('生病 → sick tag + 柔和憔悴', sick.tags.includes('sick') && /tired|soft|elegant|gentle/i.test(sick.prompt));
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

console.log('buildScenePrompt (随手拍: 她看到的风景/猫狗, 由当下活动决定)');
{
  const park = buildScenePrompt({ life: { current_activity: '在公园散步' } }, now);
  ok('在公园 → 出题材 + scene tag', park && park.tags.includes('scene') && park.tags.includes('park'));
  ok('公园题材含风景/狗狗', /风景|狗狗/.test(park.prompt));
  const home = buildScenePrompt({ life: { current_activity: '窝在沙发追剧' } }, now);
  ok('在家追剧 → 居家/猫 题材', home && home.tags.includes('home-pet'));
  const working = buildScenePrompt({ life: { current_activity: '在公司开会' } }, now);
  ok('开会这种没题材 → null', working === null);
  const sick = buildScenePrompt({ life: { current_activity: '在公园散步', sick_until: new Date(now + 3600000).toISOString() } }, now);
  ok('生病时不出去拍风景 → null', sick === null);
}

console.log('decidePhoto (统一决策: 自拍 vs 随手拍 vs 不发)');
{
  // 被点名要看她 → 自拍
  const reqd = decidePhoto({ emotion: { valence: 0.5, warmth: 0.8 }, life: {} }, { requested: true }, now);
  ok('被要求看她 → kind=selfie', reqd.ok && reqd.kind === 'selfie');

  // 在外面有好题材 + 中等亲密 → 随手拍 (门槛低)
  const outAndAbout = decidePhoto({ emotion: { valence: 0, warmth: 0.45 }, life: { current_activity: '在公园遛弯' } }, {}, now);
  ok('在公园 + 中等亲密 → kind=scene', outAndAbout.ok && outAndAbout.kind === 'scene');

  // 够亲密 + 心情好但没外出题材 → 自拍
  const happyHome = decidePhoto({ emotion: { valence: 0.5, warmth: 0.8 }, life: { current_activity: '在公司' } }, {}, now);
  ok('心情好够亲密无外出题材 → kind=selfie', happyHome.ok && happyHome.kind === 'selfie');

  // 不够亲密 + 无题材 → 不发
  const nope = decidePhoto({ emotion: { valence: 0, warmth: 0.3 }, life: { current_activity: '在公司' } }, {}, now);
  ok('不够亲密又没题材 → 不发', nope.ok === false);
}

console.log('Selfie.photo (kind=scene 走随手拍; 无题材返回 null)');
{
  const writes = [];
  const s = new Selfie({ userId: 'u1', companionId: 'keke', provider: new MockImageProvider(), read: async () => null, write: async (...a) => writes.push(a) });
  const scene = await s.photo({ life: { current_activity: '在公园散步' } }, { kind: 'scene', now });
  ok('scene 出图带 kind 与 scene tag', scene && scene.kind === 'scene' && scene.tags.includes('scene'));
  const none = await s.photo({ life: { current_activity: '在公司开会' } }, { kind: 'scene', now });
  ok('scene 无题材 → null, 不入库', none === null);
}

console.log(`\nA1 外貌骨架 全部 ${passed} 条断言通过`);
