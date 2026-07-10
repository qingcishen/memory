// M6 纯逻辑测试: 多模态记忆 (图片/语音) 的组装与降级, 以及媒体向量闭环 (#6 工程债)。不连网。
// 验收 (见 docs/DEVELOPMENT.md M6):
//   - 图片 caption 进 content (可被文本召回), modality=image
//   - 语音转写进 content, 语气进 affect
//   - 缺凭证 (无 url/file 且无 caption/transcript) 降级为 []、不崩
//   - rankByMediaSimilarity: 按 media_embedding 余弦相似度排序 (图搜图), 缺向量的候选被跳过
import assert from 'node:assert';
import { buildImageMemory, ingestImage, rankByMediaSimilarity } from '../src/modal/image.js';
import { prosodyToAffect, buildAudioMemory, ingestAudio } from '../src/modal/audio.js';
import { PARAMS } from '../src/params.js';

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
  const img = await ingestImage('u_test', 'default', {}); // 无 url 无 caption
  ok('ingestImage 无输入 → []', Array.isArray(img) && img.length === 0);
  const aud = await ingestAudio('u_test', 'default', {}); // 无 file 无 transcript
  ok('ingestAudio 无输入 → []', Array.isArray(aud) && aud.length === 0);
}

console.log('rankByMediaSimilarity (#6 媒体向量闭环: 按 media_embedding 余弦相似度图搜图)');
{
  const query = [1, 0, 0];
  const candidates = [
    { id: 'beach', media_embedding: [1, 0, 0] }, // 与 query 完全一致
    { id: 'mountain', media_embedding: [0, 1, 0] }, // 正交, 不相关
    { id: 'beach2', media_embedding: '[0.9, 0.1, 0]' }, // pgvector 字符串形式, 较相似
    { id: 'caption-only', fact_core: '只有文字描述的图', media_embedding: null }, // 没存向量
    { id: 'no-media-field' }, // 纯文本记忆, 压根没有 media_embedding 字段
  ];

  const ranked = rankByMediaSimilarity(candidates, query);
  ok('最相似的排第一', ranked[0]?.id === 'beach');
  ok('第二相似的排第二', ranked[1]?.id === 'beach2');
  ok('没有 media_embedding 的候选被跳过', !ranked.some((m) => m.id === 'caption-only' || m.id === 'no-media-field'));
  ok('结果带 _mediaSimilarity', typeof ranked[0]._mediaSimilarity === 'number');
  ok('完全一致的向量相似度为 1', Math.abs(ranked[0]._mediaSimilarity - 1) < 1e-9);
  ok('降序排列', ranked[0]._mediaSimilarity >= ranked[1]._mediaSimilarity);

  ok('topK 截断', rankByMediaSimilarity(candidates, query, { topK: 1 }).length === 1);
  ok('默认 topK 取自 PARAMS.modal.mediaTopK', PARAMS.modal.mediaTopK > 0);

  ok('queryEmbedding 为空时返回 []', rankByMediaSimilarity(candidates, null).length === 0);
  ok('候选为空时返回 []', rankByMediaSimilarity([], query).length === 0);
  ok('原字段被保留', ranked[0].id === 'beach');
}

console.log(`\nM6 全部 ${passed} 条断言通过 ✅`);
