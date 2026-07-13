// 校验一个角色的人设文件。
//
// loadPersonaConfig (生产入口用) 遇到坏文件会打日志但返回 null, 不会告诉你具体哪个字段错了。
// 这个脚本用 loadPersonaConfigOrThrow, 直接把 JSON 解析错误/zod 校验错误抛出来, 写人设时用它
// 能立刻定位到问题, 而不是发现"人设看起来是空的"再去猜。
//
// 用法: node scripts/validate-companion.js <companionId>

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPersonaConfigOrThrow } from '../src/companion.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function summarize(config) {
  const truncate = (s, n) => (s && s.length > n ? `${s.slice(0, n)}…` : s || '(空)');
  return [
    `name: ${config.name}`,
    `personality: ${truncate(config.personality, 40)}`,
    `speechStyle: ${truncate(config.speechStyle, 40)}`,
    `appearance: ${truncate(config.appearance, 40)}`,
    `identityConstraints: ${config.identityConstraints.length} 条`,
    `seedFacts: ${config.seedFacts.length} 条, knowledgeBank: ${config.knowledgeBank.length} 条`,
    `storyCast: ${config.storyCast.length} 人, storylines: ${config.storylines.length} 条`,
    `intimacyEnabled: ${config.intimacyEnabled}`,
  ];
}

function main() {
  const id = process.argv[2];
  if (!id) {
    console.error('用法: node scripts/validate-companion.js <companionId>');
    process.exit(1);
  }
  const target = path.join(ROOT, 'companions', `${id}.json`);
  try {
    const result = loadPersonaConfigOrThrow(target);
    if (!result) {
      console.error(`✗ 角色 ${id} 不存在 (companions/${id}/ 目录和 companions/${id}.json 都没找到)`);
      process.exit(1);
    }
    console.log(`✓ 角色 ${id} 人设校验通过`);
    for (const line of summarize(result.config)) console.log(`  ${line}`);
  } catch (error) {
    console.error(`✗ 角色 ${id} 人设校验失败:`);
    if (Array.isArray(error.issues)) {
      for (const issue of error.issues) {
        console.error(`  - ${issue.path.join('.') || '(顶层)'}: ${issue.message}`);
      }
    } else {
      console.error(`  ${error.message}`);
    }
    process.exit(1);
  }
}

main();
