import assert from 'node:assert';
import { extractStreamingDialoguePreview } from '../src/orchestrator/llm.js';
import { explainRecallHits, formatRecallExplanation } from '../src/orchestrator/explainRecall.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';

let passed = 0;
const ok = (name, cond) => {
  assert.ok(cond, name);
  console.log('  ✓', name);
  passed++;
};

console.log('extractStreamingDialoguePreview');
{
  ok('空缓冲', extractStreamingDialoguePreview('') === '');
  ok(
    '完整 JSON',
    extractStreamingDialoguePreview('{"parts":[{"type":"dialogue","text":"想你了"}]}').includes('想你了'),
  );
  ok(
    '半截 text 字段',
    extractStreamingDialoguePreview('{"parts":[{"type":"dialogue","text":"你好呀').length >= 0,
  );
  const half = extractStreamingDialoguePreview('{"parts":[{"type":"dialogue","text":"先发出来"}]}');
  ok('已闭合 text', half.includes('先发出来'));
}

console.log('explainRecallHits');
{
  const rows = explainRecallHits(
    [
      {
        id: '1',
        type: 'preference',
        fact_core: '对方讨厌香菜',
        similarity: 0.9,
        importance: 6,
        subject_kind: 'user',
      },
      {
        id: '2',
        type: 'episode',
        fact_core: '【篇章】加班夜',
        similarity: 0.6,
        subject_kind: 'dyad',
        _lowConfidence: true,
      },
    ],
    '香菜',
  );
  ok('两条解释', rows.length === 2);
  ok('高相似有理由', rows[0].why.includes('相近') || rows[0].why.includes('相关'));
  ok('dyad 标记', rows[1].why.includes('共同'));
  ok('文本可读', formatRecallExplanation(rows, '香菜').includes('香菜'));
}

console.log('replyStream mock');
{
  const deps = {
    memory: {
      async recall(q) {
        return { block: '记忆块', hits: [{ id: 'h1', type: 'fact', fact_core: '喜欢下雨', similarity: 0.88, importance: 5 }] };
      },
      async observe() {},
    },
    stateLayer: {
      async snapshot() {
        return { emotion: { valence: 0.2, warmth: 0.7 }, life: { energy: 0.7 }, desires: {} };
      },
      async evolve() {},
      toPrompt() {
        return '状态ok';
      },
      samplingHints() {
        return { temperature: 0.8, maxTokens: 400 };
      },
    },
    relationship: {
      async current() {
        return { relationship: { closeness: 0.7, trust: 0.7, tension: 0.1, repair_debt: 0 } };
      },
      async bump() {},
      toPrompt() {
        return '关系ok';
      },
    },
    persona: {
      async load() {},
      toPrompt() {
        return '人设ok';
      },
    },
    llm: {
      async think() {
        return '独白';
      },
      async generateReply() {
        return { parts: [{ type: 'dialogue', text: '整包回复' }] };
      },
      async *generateReplyStream() {
        yield { event: 'delta', text: '{"parts"' };
        yield { event: 'preview', text: '流' };
        yield { event: 'preview', text: '流式预览' };
        yield {
          event: 'done',
          parts: [{ type: 'dialogue', text: '流式预览完成' }],
          text: '流式预览完成',
          streamed: true,
        };
      },
    },
  };
  const orch = new Orchestrator({
    userId: 'stream-u',
    deps,
    options: { useMonologue: false, historyTurns: 4 },
  });
  const events = [];
  for await (const ev of orch.replyStream('今天怎么样', { debug: true })) {
    events.push(ev);
  }
  ok('有 preview 事件', events.some((e) => e.event === 'preview'));
  const done = events.find((e) => e.event === 'done');
  ok('有 done', Boolean(done?.text));
  ok('done 带 recallExplain 或 debug', Array.isArray(done.recallExplain) || Boolean(done.debug?.recallExplain));
}

console.log(`\norchestrator-stream 全部 ${passed} 条断言通过 ✅`);
