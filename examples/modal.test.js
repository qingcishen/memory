// M6 纯逻辑测试: 多模态记忆 (图片/语音) 的组装与降级。不连网。
// 验收 (见 docs/DEVELOPMENT.md M6):
//   - 图片 caption 进 content (可被文本召回), modality=image
//   - 语音转写进 content, 语气进 affect
//   - 缺凭证 (无 url/file 且无 caption/transcript) 降级为 []、不崩
import assert from 'node:assert';
import { buildImageMemory, ingestImage } from '../src/modal/image.js';
import { prosodyToAffect, buildAudioMemory, ingestAudio } from '../src/modal/audio.js';

let passed = 0;
const ok = (name, cond) => {
  assert.ok(cond, name);
  console.log('  ✓', name);
  passed++;
};

console.log('buildImageMemory (图片 → image 记忆)');
{
  const m = buildImageMemory({ caption: '海边的日落和两个人的背影', mediaRef: 'https://x/p.jpg', affect: { valence: 0.7, intensity: 0.6 } });
  ok('modality=image', m.modality === 'image');
  ok('caption 进 fact_core/content (可文本召回)', m.content.includes('日落') && m.fact_core === m.content);
  ok('保留 media_ref', m.media_ref === 'https://x/p.jpg');
  ok('一起看的图默认 dyad', m.subject_kind === 'dyad');
  ok('affect 进情感层', m.affect_valence === 0.7 && m.affect_intensity === 0.6);
  ok('空 caption → null', buildImageMemory({ caption: '   ' }) === null);
}

console.log('prosodyToAffect (语气 → 情感层)');
{
  ok('直接给 valence/intensity 则采用', prosodyToAffect({ valence: -0.5, intensity: 0.8 }).valence === -0.5);
  ok('哭腔 → 负向', prosodyToAffect({ tone: 'crying' }).valence < 0);
  ok('开心 → 正向', prosodyToAffect({ tone: 'happy' }).valence > 0);
  ok('越界被裁剪', prosodyToAffect({ valence: 9, intensity: 9 }).valence === 1);
  ok('无语气 → 中性低强度', prosodyToAffect({}).valence === 0);
}

console.log('buildAudioMemory (语音 → audio 记忆, 语气进 affect)');
{
  const sad = buildAudioMemory({ transcript: '我没事', prosody: { tone: 'crying' }, subjectName: '诗雅' });
  const ok2 = buildAudioMemory({ transcript: '我没事', prosody: { tone: 'happy' } });
  ok('modality=audio', sad.modality === 'audio');
  ok('转写进 content', sad.content === '我没事');
  ok('同一句话, 哭腔与笑着 affect 不同 (语气进了记忆)', sad.affect_valence < ok2.affect_valence);
  ok('语气写进 narrative', sad.narrative.includes('crying'));
  ok('空转写 → null', buildAudioMemory({ transcript: '' }) === null);
}

console.log('降级: 缺凭证且无文本时返回 []、不抛');
{
  const img = await ingestImage('u_test', {}); // 无 url 无 caption
  ok('ingestImage 无输入 → []', Array.isArray(img) && img.length === 0);
  const aud = await ingestAudio('u_test', {}); // 无 file 无 transcript
  ok('ingestAudio 无输入 → []', Array.isArray(aud) && aud.length === 0);
}

console.log(`\nM6 全部 ${passed} 条断言通过 ✅`);
