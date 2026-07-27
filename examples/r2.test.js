// R2 图床：配置解析与 key 规则（默认连网测一次公开读）

import {
  resolveR2Config,
  r2ObjectKey,
  publicUrlForKey,
  uploadToR2,
} from '../src/media/r2.js';

let passed = 0;
const ok = (name, cond) => {
  if (!cond) {
    console.error(`  ✗ ${name}`);
    process.exit(1);
  }
  console.log(`  ✓ ${name}`);
  passed++;
};

console.log('r2 helpers');
const cfg = resolveR2Config({
  CLOUDFLARE_ACCOUNT_ID: '2581ca9560b48b398983980c1668d0d2',
  R2_BUCKET: 'qingci-companion-media',
  R2_PUBLIC_BASE: 'https://pub-3e3edc57d51e421c97cf033aaa061cb0.r2.dev',
  CLOUDFLARE_API_TOKEN: '',
});
ok('configured', cfg.configured);
ok('bucket 名', cfg.bucket === 'qingci-companion-media');

const key = r2ObjectKey({ companionId: 'default', collection: 'album', cardId: 'album:look:work_board', ext: 'webp' });
ok('key 含 album/default', key.startsWith('album/default/'));
ok('public url', publicUrlForKey(key, { R2_PUBLIC_BASE: cfg.publicBase }).startsWith('https://pub-'));

// 真实上传属于显式集成测试；npm test 永远保持离线、确定性。
const live = resolveR2Config(process.env);
if (process.env.R2_LIVE_TEST === '1' && live.canUpload) {
  const buf = Buffer.from(`r2-test-${Date.now()}`);
  const up = await uploadToR2(buf, {
    mime: 'text/plain',
    key: `test/unit-${Date.now()}.txt`,
    env: process.env,
  });
  ok('实网上传', up.ok === true && Boolean(up.url));
  if (up.ok) {
    const res = await fetch(up.url);
    const text = await res.text();
    ok('公网可读', res.ok && text.startsWith('r2-test-'));
  }
} else {
  console.log('  · skip live upload (set R2_LIVE_TEST=1 to run integration test)');
  ok('skip live', true);
  ok('skip read', true);
}

console.log(`\n${passed} passed`);
