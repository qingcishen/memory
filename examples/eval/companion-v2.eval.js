import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildConversationGoals, goalsToPrompt } from '../../src/orchestrator/goals.js';
import { inferEmotionLabel } from '../../src/state/emotionLabel.js';
import { behaviorPolicy, behaviorToPrompt } from '../../src/state/behavior.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scenarios = JSON.parse(fs.readFileSync(path.join(__dirname, 'companion-v2.scenarios.json'), 'utf8'));

let failed = 0;
for (const s of scenarios) {
  const label = inferEmotionLabel(
    { mood: s.state.mood, relationship: s.state.relationship },
    s.state.desires,
    s.turns,
  );
  const behavior = behaviorPolicy(
    label,
    { relationship: s.state.relationship },
  );
  const goals = buildConversationGoals({ dueItems: [], desires: s.state.desires, storyBeat: s.storyBeat });
  const prompt = [behaviorToPrompt(behavior), goalsToPrompt(goals)].filter(Boolean).join('\n\n');
  const checks = [
    ['emotion label exists', typeof label === 'string' && label.length > 0],
    ['behavior prompt avoids internals', !/系统|目标栈|story|mood_link/i.test(prompt)],
    ['high sharing creates story goal when beat exists', !s.storyBeat || goals.some((g) => String(g.text).includes(s.storyBeat.content))],
    ['high tension can alter behavior', s.state.relationship.tension < 0.7 || behavior.replyDelayMs[1] > 0 || behavior.stonewall === true],
  ];
  const bad = checks.filter(([, ok]) => !ok);
  if (bad.length) {
    failed++;
    console.error(`✗ ${s.id}: ${bad.map(([name]) => name).join(', ')}`);
  } else {
    console.log(`✓ ${s.id}: ${s.title} · emotion=${label} · goals=${goals.length}`);
  }
}

if (failed) {
  console.error(`\nE1 companion-v2 eval failed: ${failed}/${scenarios.length}`);
  process.exit(1);
}

console.log(`\nE1 companion-v2 eval passed: ${scenarios.length}/${scenarios.length}`);
