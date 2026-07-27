// 新建角色人设脚手架。
//
// 之前新建一个"真正不同"的角色 (不只是改名字的克隆) 只能靠翻 companions/default/*.json 和
// src/companion.js 的 personaJsonToConfig 源码去猜每个分片文件该长什么样。这个脚本把全部分片
// (persona/profile/appearance/life/relationship/runtime/knowledge/story, 可选 intimacy) 一次性
// 生成好占位内容, 填 TODO 就行; 写完用 `npm run companion:validate <id>` 校验。
//
// 用法:
//   node scripts/new-companion.js <companionId> [--name="显示名"]
//   node scripts/new-companion.js <companionId> --clone=<已有角色ID> [--name="显示名"]
//   node scripts/new-companion.js <companionId> --intimacy   (额外生成 intimacy.json 占位)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMPANIONS_DIR = path.join(ROOT, 'companions');

function safeCompanionId(id = '') {
  const clean = String(id ?? '').trim();
  return /^[\w-]{1,64}$/.test(clean) && !clean.startsWith('.') ? clean : null;
}

function parseArgs(argv) {
  const [id, ...rest] = argv;
  const opts = { id, name: null, cloneFrom: null, intimacy: false };
  for (const arg of rest) {
    if (arg.startsWith('--name=')) opts.name = arg.slice('--name='.length);
    else if (arg.startsWith('--clone=')) opts.cloneFrom = arg.slice('--clone='.length);
    else if (arg === '--intimacy') opts.intimacy = true;
  }
  return opts;
}

function blankSections(id, name, { intimacy }) {
  const sections = {
    'persona.json': {
      meta: { id, display_name: name, version: 1 },
      persona: {
        name,
        personality: 'TODO: 2-3 句话总体性格 —— 气质/说话给人的感觉/外部身份和对用户时的反差',
        speech: ['TODO: 说话风格要点 1 (语气/句长/口头禅)', 'TODO: 说话风格要点 2'],
        likes: [],
        dislikes: [],
        background: 'TODO: 背景故事 —— 身份、和用户的关系起点、现在的相处状态 (同居/异地/暧昧…)',
        values: 'TODO: 处世态度/感情观 —— 她在什么事上会坚持自己、什么事上会让步',
        address_user: 'TODO: 她对用户的称呼, 例如 "你" / "宝" / 具体名字',
        identity_constraints: ['TODO: 用户角色的硬性事实, 例如 "是在读大学生, 不是上班族, 别问加班"'],
      },
    },
    'profile.json': {
      profile: {
        legalName: name,
        nicknames: [],
        gender: '女',
        birthDate: '',
        birthPlace: '',
        nationality: '中国',
        idCardNumber: '',
        passportNumber: '',
        family: [],
        menstrual: { enabled: false, lastPeriodStart: '', cycleLengthDays: 28, periodLengthDays: 5, remindersEnabled: false, notes: '' },
      },
    },
    'appearance.json': {
      appearance: {
        anchor_prompt: 'TODO: 外貌描述, 会注入 prompt (不做图像生成), 例如 "及肩黑发, 冷淡气质, 穿搭简约"',
        lora: null,
        ref_images: [],
      },
    },
    'life.json': {
      life: {
        sleep: '00:30-08:00',
        schedule_template: [
          { from: '09:00', to: '12:00', activity: 'TODO: 上午在做什么' },
          { from: '20:00', to: '22:00', activity: 'TODO: 晚上在做什么' },
        ],
        sick_probability: 0.02,
      },
    },
    'relationship.json': {
      emotion_baseline: { valence: 0, warmth: 0.5, half_life_hours: 5 },
      relationship: { start_stage: null },
    },
    'runtime.json': {
      runtime: { use_monologue: true, history_turns: 6 },
    },
    'knowledge.json': { knowledge: [] },
    'story.json': { story: { cast: [], lines: [] } },
  };
  if (intimacy) {
    sections['intimacy.json'] = {
      intimacy: {
        enabled: true,
        baseline: { sexual_openness: 0.5, satisfaction: 0.5, pace: 'normal' },
        hard_boundaries: ['TODO: 明确说停或表达不适时必须立即停止，不得继续推进'],
        soft_preferences_seed: ['TODO: 她的软性偏好，会被种进 self 记忆'],
        style_hints: ['TODO: 亲密时的性格底色，例如主动/被动、克制/热情'],
      },
    };
  }
  return sections;
}

function writeSections(destDir, sections) {
  for (const [file, content] of Object.entries(sections)) {
    fs.writeFileSync(path.join(destDir, file), `${JSON.stringify(content, null, 2)}\n`);
  }
}

function main() {
  const { id, name, cloneFrom, intimacy } = parseArgs(process.argv.slice(2));
  if (!id) {
    console.error('用法: node scripts/new-companion.js <companionId> [--name="显示名"] [--clone=<已有角色ID>] [--intimacy]');
    process.exit(1);
  }
  const safeId = safeCompanionId(id);
  if (!safeId) {
    console.error(`角色 ID 不合法: "${id}" (只能是字母/数字/下划线/短横线)`);
    process.exit(1);
  }
  const destDir = path.join(COMPANIONS_DIR, safeId);
  if (fs.existsSync(destDir) || fs.existsSync(path.join(COMPANIONS_DIR, `${safeId}.json`))) {
    console.error(`角色 ${safeId} 已存在 (companions/${safeId})`);
    process.exit(1);
  }
  const displayName = name || safeId;

  if (cloneFrom) {
    const srcId = safeCompanionId(cloneFrom);
    const srcDir = srcId ? path.join(COMPANIONS_DIR, srcId) : null;
    if (!srcId || !srcDir || !fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) {
      console.error(`找不到要克隆的角色目录: companions/${cloneFrom}`);
      process.exit(1);
    }
    fs.cpSync(srcDir, destDir, { recursive: true });
    const personaFile = path.join(destDir, 'persona.json');
    if (fs.existsSync(personaFile)) {
      const json = JSON.parse(fs.readFileSync(personaFile, 'utf8'));
      json.persona = { ...(json.persona ?? {}), name: displayName };
      json.meta = { ...(json.meta ?? {}), id: safeId, display_name: displayName };
      fs.writeFileSync(personaFile, `${JSON.stringify(json, null, 2)}\n`);
    }
    console.log(`已从 ${srcId} 克隆出角色 ${safeId} (${displayName})`);
    console.log(`目录: companions/${safeId}/ —— 克隆的内容大多还是源角色的, 记得去改性格/说话风格/外貌/背景等字段`);
    return;
  }

  fs.mkdirSync(destDir, { recursive: true });
  const sections = blankSections(safeId, displayName, { intimacy });
  writeSections(destDir, sections);
  console.log(`已创建角色 ${safeId} (${displayName})`);
  console.log(`目录: companions/${safeId}/ —— 共 ${Object.keys(sections).length} 个分片文件, 每个字段都填了 TODO 占位`);
  console.log(`改完用 npm run companion:validate ${safeId} 校验`);
}

main();
