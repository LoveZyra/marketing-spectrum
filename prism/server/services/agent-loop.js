/**
 * /loop agent-loop helpers (ported from claude-web-ui 2.0 Agent Loop).
 *
 * The loop engine itself lives in claude-sdk.js (it needs the persistent
 * runtime internals); this module owns the pure pieces: command parsing,
 * test-command detection, and test execution.
 */

import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';

export const LOOP_DEFAULT_ROUNDS = 4;
export const LOOP_MAX_ROUNDS = 8;
const TEST_TIMEOUT_MS = 5 * 60 * 1000;
const TEST_OUTPUT_TAIL = 6000;

/**
 * Parse "/loop <goal> [--rounds N] [--test "cmd"]".
 * Returns null when the input is not a /loop command.
 */
export function parseLoopCommand(command) {
  if (typeof command !== 'string') return null;
  const trimmed = command.trim();
  if (!/^\/loop(\s|$)/.test(trimmed)) return null;

  let rest = trimmed.replace(/^\/loop\s*/, '');
  let rounds = LOOP_DEFAULT_ROUNDS;
  let testCommand = null;

  const roundsMatch = rest.match(/--rounds[= ](\d+)/);
  if (roundsMatch) {
    rounds = Math.max(1, Math.min(LOOP_MAX_ROUNDS, parseInt(roundsMatch[1], 10)));
    rest = rest.replace(roundsMatch[0], '');
  }

  const testMatch = rest.match(/--test[= ]("([^"]+)"|'([^']+)'|(\S+))/);
  if (testMatch) {
    testCommand = testMatch[2] || testMatch[3] || testMatch[4] || null;
    rest = rest.replace(testMatch[0], '');
  }

  const goal = rest.trim();
  return { goal, rounds, testCommand };
}

/** Detect a runnable verification command for the project. */
export async function detectTestCommand(cwd) {
  if (!cwd) return null;

  try {
    const packageJsonRaw = await fs.readFile(path.join(cwd, 'package.json'), 'utf8');
    const packageJson = JSON.parse(packageJsonRaw);
    const testScript = packageJson?.scripts?.test;
    if (typeof testScript === 'string'
      && testScript.trim()
      && !/no test specified/i.test(testScript)) {
      return 'npm test --silent';
    }
  } catch { /* not a node project */ }

  const pytestMarkers = ['pytest.ini', 'setup.cfg', 'pyproject.toml'];
  for (const marker of pytestMarkers) {
    try {
      const content = await fs.readFile(path.join(cwd, marker), 'utf8');
      if (marker === 'pytest.ini' || /\[tool\.pytest|\[pytest\]/.test(content)) {
        return 'python3 -m pytest -q';
      }
    } catch { /* keep looking */ }
  }
  try {
    const stat = await fs.stat(path.join(cwd, 'tests'));
    if (stat.isDirectory()) return 'python3 -m pytest -q';
  } catch { /* no tests dir */ }

  return null;
}

/**
 * Run the verification command. Resolves { ok, output } — never rejects.
 */
export function runTestCommand(cwd, command, options = {}) {
  return new Promise((resolve) => {
    /**
     * fj:验证命令要**接受取消**。
     *
     * 它是一条独立于 SDK 的执行入口:`execFile('bash', ['-lc', cmd])`,不走
     * 工具审批、也不认 abort。用户在验证跑到一半按停止,原来的行为是"这条命令
     * 照跑到底(最长 `TEST_TIMEOUT_MS`),跑完还可能接着起下一轮" ——
     * 从用户视角就是按了停止但机器还在忙。
     *
     * 传进来的 `signal` 由 `execFile` 直接支持(Node 会 kill 掉子进程)。
     */
    const child = execFile('bash', ['-lc', command], {
      cwd,
      timeout: TEST_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      signal: options.signal,
    }, (error, stdout, stderr) => {
      const combined = `${stdout || ''}\n${stderr || ''}`.trim();
      const output = combined.length > TEST_OUTPUT_TAIL
        ? `…(truncated)\n${combined.slice(-TEST_OUTPUT_TAIL)}`
        : combined;
      // 被取消时 `ok` 为 false,而且要让调用方分得出"没通过"和"被叫停"。
      const cancelled = Boolean(error) && (error.name === 'AbortError' || error.code === 'ABORT_ERR');
      resolve({ ok: !error, output, cancelled });
    });
    void child;
  });
}
