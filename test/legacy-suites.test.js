import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';

const root = path.resolve('.');
const suites = fs.readdirSync(path.join(root, 'examples'))
  .filter((name) => name.endsWith('.test.js') && name !== 'emotion-live.test.js')
  .sort();

// Execute every legacy file independently during collection, then expose every reported
// assertion as its own Vitest case. One broken process never prevents later files from running,
// and the Vitest case count cannot silently shrink below the legacy assertion count.
const runs = suites.map((suite) => {
  const result = spawnSync(process.execPath, [path.join(root, 'examples', suite)], {
    cwd: root,
    env: { ...process.env, NODE_ENV: 'test', R2_LIVE_TEST: '0' },
    encoding: 'utf8',
    timeout: 120_000,
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const names = output.split('\n')
    .filter((line) => /^\s*✓/.test(line))
    .map((line) => line.replace(/^\s*✓\s*/u, '').trim());
  const reported = Number(output.match(/(?:全部\s*)?(\d+)\s*(?:条断言通过|passed)/iu)?.[1] ?? 0);
  while (names.length < reported) names.push(`legacy assertion ${names.length + 1}`);
  if (!names.length) names.push('process completed');
  return { suite, result, output, names };
});

describe('legacy suites migrated into isolated Vitest cases', () => {
  for (const run of runs) {
    describe(run.suite, () => {
      run.names.forEach((name, index) => {
        test(`${index + 1}. ${name}`, () => {
          expect(run.result.status, run.output || run.result.error?.message).toBe(0);
        });
      });
    });
  }
});
