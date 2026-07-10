// 本地控制台的纯逻辑单测: .env 解析/写回/脱敏 (src/ui/envfile.js)。
// 不起 http 服务、不碰真实 .env 文件。

import { parseEnvText, applyEnvUpdates, formatEnvValue, maskValue } from '../src/ui/envfile.js';
import { extractProjectRef, buildMemoriesQuery, safePersonaName, normalizeModelIds, resolveModelTarget, listModels } from '../src/ui/server.js';

let passed = 0;
const ok = (name, cond) => {
  if (!cond) {
    console.error(`  ✗ ${name}`);
    process.exit(1);
  }
  console.log(`  ✓ ${name}`);
  passed++;
};

console.log('parseEnvText (env 文本 -> 键值)');
{
  const text = [
    '# ---- Supabase ----',
    'SUPABASE_URL=https://xxxx.supabase.co',
    'SUPABASE_KEY=abc123  # 行内注释',
    '',
    'EMPTY=',
    'QUOTED="hello world # not comment"',
    "SINGLE='keep $raw'",
    'export EXPORTED=1',
    '无效行不崩',
  ].join('\n');
  const env = parseEnvText(text);
  ok('普通键值', env.SUPABASE_URL === 'https://xxxx.supabase.co');
  ok('行内注释被截掉', env.SUPABASE_KEY === 'abc123');
  ok('空值是空串', env.EMPTY === '');
  ok('双引号内的 # 保留', env.QUOTED === 'hello world # not comment');
  ok('单引号原样保留', env.SINGLE === 'keep $raw');
  ok('export 前缀兼容', env.EXPORTED === '1');
  ok('无效行忽略不崩', !('无效行不崩' in env));
}

console.log('formatEnvValue (写回时转义)');
{
  ok('普通值原样', formatEnvValue('deepseek-chat') === 'deepseek-chat');
  ok('空值加引号 (KEY="" 比 KEY= 意图更明确)', formatEnvValue('') === '""');
  ok('带空格加引号', formatEnvValue('a b') === '"a b"');
  ok('带 # 加引号', formatEnvValue('a#b') === '"a#b"');
  ok('内部双引号转义', formatEnvValue('a"b') === '"a\\"b"');
}

console.log('applyEnvUpdates (原地替换 + 保留注释顺序 + 追加新键)');
{
  const original = [
    '# ---- Supabase ----',
    'SUPABASE_URL=https://old.supabase.co',
    'SUPABASE_KEY=oldkey',
    '',
    '# ---- LLM ----',
    'LLM_MODEL=deepseek-chat',
  ].join('\n');

  const updated = applyEnvUpdates(original, {
    SUPABASE_URL: 'https://new.supabase.co',
    NEW_KEY: 'hello world',
    SKIPPED: null,
  });
  const env = parseEnvText(updated);
  ok('目标键被替换', env.SUPABASE_URL === 'https://new.supabase.co');
  ok('未提及的键不动', env.SUPABASE_KEY === 'oldkey' && env.LLM_MODEL === 'deepseek-chat');
  ok('注释保留', updated.includes('# ---- Supabase ----') && updated.includes('# ---- LLM ----'));
  ok('顺序保留 (URL 仍在 KEY 前)', updated.indexOf('SUPABASE_URL') < updated.indexOf('SUPABASE_KEY'));
  ok('新键追加到末尾并转义', updated.trimEnd().endsWith('NEW_KEY="hello world"'));
  ok('null 视为不改动', !updated.includes('SKIPPED'));
  ok('文件以换行结尾', updated.endsWith('\n'));

  const dup = applyEnvUpdates('A=1\nA=2\nB=3', { A: '9' });
  ok('同名重复行只保留第一处', parseEnvText(dup).A === '9' && dup.match(/^A=/gm).length === 1);

  ok('空更新原样返回', applyEnvUpdates(original, {}) === original);
  const fromEmpty = applyEnvUpdates('', { K: 'v' });
  ok('空底稿也能追加', parseEnvText(fromEmpty).K === 'v');
}

console.log('maskValue (密钥脱敏)');
{
  ok('空值 -> 空串', maskValue('') === '');
  ok('短密钥全遮', maskValue('abc123') === '••••••');
  ok('长密钥只露末 4 位', maskValue('sk-1234567890abcdef') === '••••••cdef');
  ok('原文不出现在结果里', !maskValue('sk-1234567890abcdef').includes('sk-'));
}

console.log('extractProjectRef (SQL 工具箱: 从 SUPABASE_URL 提取项目 ref)');
{
  ok('标准托管地址', extractProjectRef('https://abcd1234.supabase.co') === 'abcd1234');
  ok('带尾斜杠', extractProjectRef('https://abcd1234.supabase.co/') === 'abcd1234');
  ok('自建域名 -> null (走不了 Management API)', extractProjectRef('https://db.example.com') === null);
  ok('空值 -> null', extractProjectRef('') === null);
  ok('不吃子域伪装', extractProjectRef('https://evil.com/abcd.supabase.co') === null);
}

console.log('buildMemoriesQuery (记忆浏览: PostgREST 查询串)');
{
  const base = buildMemoriesQuery({});
  ok('默认只取未被取代的', base.includes('superseded_by=is.null'));
  ok('默认按时间倒序', base.includes('order=created_at.desc'));
  const scoped = buildMemoriesQuery({ userId: 'telegram:1', companionId: 'default', q: '香菜', includeSuperseded: true, limit: 30 });
  ok('按用户过滤', scoped.includes(encodeURIComponent('eq.telegram:1')));
  ok('内容模糊搜索', decodeURIComponent(scoped).includes('content=ilike.*香菜*'));
  ok('含被取代时不过滤', !scoped.includes('superseded_by=is.null'));
  ok('limit 有上限', buildMemoriesQuery({ limit: 99999 }).includes('limit=200'));
  ok('搜索词里的通配符被清理', !decodeURIComponent(buildMemoriesQuery({ q: 'a%b_c' })).includes('%b'));
  const filtered = decodeURIComponent(buildMemoriesQuery({ type: 'reflection', subjectKind: 'dyad', modality: 'image', minImportance: 7 }));
  ok('支持类型/主体/模态筛选', filtered.includes('type=eq.reflection') && filtered.includes('subject_kind=eq.dyad') && filtered.includes('modality=eq.image'));
  ok('支持最低重要性筛选', filtered.includes('importance=gte.7'));
}

console.log('safePersonaName (人设文件白名单)');
{
  ok('普通文件名放行', safePersonaName('default.json') === 'default.json');
  ok('路径穿越被剥掉目录', safePersonaName('../../etc/passwd.json') === 'passwd.json');
  ok('非 json 拒绝', safePersonaName('bot.js') === null);
  ok('隐藏文件拒绝', safePersonaName('.env.json') === null);
  ok('空名拒绝', safePersonaName('') === null);
}

console.log('normalizeModelIds (兼容端点模型目录)');
{
  const openai = normalizeModelIds({ data: [{ id: 'gpt-4o-mini' }, { id: 'text-embedding-3-small' }, { id: 'gpt-4o-mini' }] });
  ok('读取 OpenAI data 格式并去重', openai.length === 2 && openai.includes('gpt-4o-mini'));
  const alternate = normalizeModelIds({ models: [{ name: 'alpha' }, 'beta', { id: 'gamma' }] });
  ok('兼容 models/name/string 格式', alternate.join(',') === 'alpha,beta,gamma');
  ok('异常响应返回空列表', normalizeModelIds({ nope: true }).length === 0);
}

console.log('listModels (读取当前密钥可访问模型)');
{
  const originalFetch = globalThis.fetch;
  let requestUrl = '';
  let requestAuth = '';
  globalThis.fetch = async (url, options = {}) => {
    requestUrl = String(url);
    requestAuth = options.headers?.authorization ?? '';
    return new Response(JSON.stringify({ data: [{ id: 'model-b' }, { id: 'model-a' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const result = await listModels('llm', { LLM_BASE_URL: 'https://provider.test/v1/', LLM_API_KEY: 'secret' });
  globalThis.fetch = originalFetch;
  ok('请求标准 /models 地址', requestUrl === 'https://provider.test/v1/models');
  ok('使用 Bearer 密钥', requestAuth === 'Bearer secret');
  ok('返回排序后的可访问模型', result.ok && result.models.join(',') === 'model-a,model-b');
  ok('无密钥时不发请求', !(await listModels('llm', {})).ok);
}

console.log('resolveModelTarget (多供应商模型回退链)');
{
  const env = {
    LLM_BASE_URL: 'https://deepseek.test', LLM_API_KEY: 'deep-key', LLM_MODEL: 'cheap',
    REPLY_BASE_URL: 'https://ark.test/v3/', REPLY_API_KEY: 'ark-key', REPLY_MODEL: 'pro',
    EMBED_BASE_URL: 'https://openai.test/v1', EMBED_API_KEY: 'openai-key', EMBED_MODEL: 'embed',
  };
  const reply = resolveModelTarget('reply', env);
  ok('回复模型使用独立方舟配置', reply.base === 'https://ark.test/v3' && reply.key === 'ark-key' && reply.model === 'pro');
  const vision = resolveModelTarget('vision', env);
  ok('视觉模型默认复用回复模型', vision.base === reply.base && vision.key === reply.key && vision.model === reply.model);
  const asr = resolveModelTarget('asr', env);
  ok('ASR 默认复用 OpenAI 向量凭证', asr.base === 'https://openai.test/v1' && asr.key === 'openai-key' && asr.model === 'whisper-1');
  const image = resolveModelTarget('image', { ...env, IMAGE_MODEL: 'seedream' });
  ok('图片生成默认复用回复供应商', image.base === reply.base && image.key === reply.key && image.model === 'seedream');
  const tts = resolveModelTarget('tts', { ...env, TTS_MODEL: 'tts-1' });
  ok('TTS 默认复用 ASR 链路凭证', tts.base === 'https://openai.test/v1' && tts.key === 'openai-key' && tts.model === 'tts-1');
  ok('TTS 未配模型时 model 为空 (opt-in)', resolveModelTarget('tts', env).model === '');
}

console.log(`\n控制台 envfile 全部 ${passed} 条断言通过`);
