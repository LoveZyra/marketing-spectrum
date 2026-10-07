import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, test } from 'vitest';

/**
 * `prism status` / `prism help` 对 CONTEXT_WINDOW 的说明要与服务端的实际取值一致:
 * 用量显示的上下文窗口按 实测 → 模型目录 → CONTEXT_WINDOW → 200000 取,
 * CONTEXT_WINDOW 只是兜底,没设时最后落到 200000(见 claude-sdk.js 的 resolveContextWindowTokens)。
 */

const repoRoot = path.resolve(__dirname, '..', '..');
const tsx = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
const envFile = path.join(repoRoot, '.env');
const envFileSetsContextWindow = fs.existsSync(envFile)
  && /^\s*(export\s+)?CONTEXT_WINDOW\s*=/m.test(fs.readFileSync(envFile, 'utf8'));

const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '');

const runCli = (command: string, extraEnv: Record<string, string> = {}): string => {
  const result = spawnSync(tsx, ['--tsconfig', path.join(repoRoot, 'server', 'tsconfig.json'), path.join(repoRoot, 'server', 'cli.js'), command], {
    cwd: repoRoot,
    env: { PATH: process.env.PATH ?? '', HOME: tmpdir(), ...extraEnv },
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  return stripAnsi(result.stdout);
};

const contextWindowLine = (output: string): string => {
  const line = output.split('\n').find((row) => row.includes('CONTEXT_WINDOW:'));
  assert.ok(line, 'status 里应当有 CONTEXT_WINDOW 一行');
  return line!;
};

describe('prism status 的 CONTEXT_WINDOW', () => {
  test.skipIf(envFileSetsContextWindow)('没设:说明取值顺序,落到 200000,不再写 160000 (default)', () => {
    const line = contextWindowLine(runCli('status'));
    assert.match(line, /实测 → 模型目录 → 200000/);
    assert.doesNotMatch(line, /160000/);
  });

  test('设了:显示这个值,并说明它只是兜底', () => {
    const line = contextWindowLine(runCli('status', { CONTEXT_WINDOW: '150000' }));
    assert.match(line, /150000/);
    assert.match(line, /兜底/);
  });

  test('设了但不是正整数:说明被忽略', () => {
    const line = contextWindowLine(runCli('status', { CONTEXT_WINDOW: 'abc' }));
    assert.match(line, /abc/);
    assert.match(line, /忽略/);
    assert.match(line, /200000/);
  });
});

test('prism help 的 CONTEXT_WINDOW:写明是兜底与取值顺序,不再写 default: 160000', () => {
  const line = runCli('help').split('\n').find((row) => row.trimStart().startsWith('CONTEXT_WINDOW'));
  assert.ok(line, 'help 里应当有 CONTEXT_WINDOW 一行');
  assert.doesNotMatch(line!, /160000/);
  assert.match(line!, /200000/);
  assert.match(line!, /model catalog/);
});
