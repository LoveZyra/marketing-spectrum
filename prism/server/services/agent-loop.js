/**
 * /loop agent-loop helpers.
 *
 * 部分实现源自 Claude Code Web(Apache-2.0),已修改;版权与许可见 NOTICE。
 *
 * The loop engine itself lives in claude-sdk.js (it needs the persistent
 * runtime internals); this module owns the pure pieces: command parsing,
 * test-command detection, and test execution.
 */

import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';

export const LOOP_DEFAULT_ROUNDS = 4;
export const LOOP_MAX_ROUNDS = 8;
const TEST_TIMEOUT_MS = 5 * 60 * 1000;
const TEST_OUTPUT_TAIL = 6000;
/** 停止 / 超时时先 SIGTERM 整个进程组,过这么久还没退的再 SIGKILL。 */
const TEST_KILL_GRACE_MS = 2000;

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

/** 只留尾部的输出缓冲:验证命令的输出可能很大,判定与回喂给模型都只用最后 TEST_OUTPUT_TAIL 个字符。 */
function createTailBuffer() {
  let text = '';
  let dropped = false;
  return {
    append(chunk) {
      text += chunk;
      // 攒到四倍再截回两倍:不必每来一块都切一次,留的余量也够末尾的空白被 trim 掉之后仍有完整的一截
      if (text.length > TEST_OUTPUT_TAIL * 4) {
        text = text.slice(-TEST_OUTPUT_TAIL * 2);
        dropped = true;
      }
    },
    text: () => text,
    /** 前面截掉过一部分 */
    dropped: () => dropped,
  };
}

/**
 * Run the verification command. Resolves { ok, output, cancelled } — never rejects.
 *
 * `options.signal`:停止(见 claude-sdk 的 runAgentLoop);`options.timeoutMs`:上限,默认 TEST_TIMEOUT_MS。
 */
export function runTestCommand(cwd, command, options = {}) {
  return new Promise((resolve) => {
    /**
     * 验证命令要接受取消,而且停的是整条命令。
     *
     * 它是一条独立于 SDK 的执行入口(`bash -lc cmd`),不走工具审批。复合命令(`npm run build && npm test`)
     * 与 npm / pytest 派生的 worker 都是 bash 的子进程:只杀 bash 的话它们被过继给 1 号进程照跑,继续占 CPU、
     * 占端口、写构建产物,下一轮再起一遍时还会和它们抢。所以命令起在独立的进程组里(detached),停止或超时时
     * 先 SIGTERM 整组,宽限 TEST_KILL_GRACE_MS 后还在的 SIGKILL。
     *
     * 输出自己按尾部累积,不设缓冲上限:超过上限会被当成出错,把通过的测试判成失败。
     */
    const signal = options.signal;
    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : TEST_TIMEOUT_MS;
    // 被叫停时 `ok` 为 false,而且要让调用方分得出"没通过"和"被叫停"。
    if (signal?.aborted) {
      resolve({ ok: false, output: '', cancelled: true });
      return;
    }

    const stdout = createTailBuffer();
    const stderr = createTailBuffer();
    let cancelled = false;
    let timedOut = false;
    let settled = false;
    let child;
    try {
      child = spawn('bash', ['-lc', command], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      resolve({ ok: false, output: String(error?.message || error), cancelled: false });
      return;
    }

    const killGroup = (signalName) => {
      try {
        process.kill(-child.pid, signalName);
      } catch {
        // 进程组已经没了(或平台不支持按组发信号):退回只发给 bash 本身
        try { child.kill(signalName); } catch { /* 已经退出 */ }
      }
    };
    let escalated = false;
    const stopGroup = () => {
      if (escalated) return;
      escalated = true;
      killGroup('SIGTERM');
      const killTimer = setTimeout(() => killGroup('SIGKILL'), TEST_KILL_GRACE_MS);
      killTimer.unref?.();
    };
    const onAbort = () => {
      cancelled = true;
      stopGroup();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      stopGroup();
    }, timeoutMs);
    timeoutTimer.unref?.();

    const finish = (exitCode, spawnError = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      signal?.removeEventListener('abort', onAbort);
      // 两个缓冲各留着足够长的尾部,拼起来再取最后 TEST_OUTPUT_TAIL 个字符,与对整段输出取尾部相同;
      // 前面截掉过的一定标 truncated(只看拼出来的长度会漏标)
      const combined = `${stdout.text()}\n${stderr.text()}`.trim();
      const truncated = stdout.dropped() || stderr.dropped() || combined.length > TEST_OUTPUT_TAIL;
      let output = truncated
        ? `…(truncated)\n${combined.slice(-TEST_OUTPUT_TAIL)}`
        : combined;
      if (spawnError) output = output ? `${output}\n${spawnError}` : spawnError;
      resolve({ ok: exitCode === 0 && !cancelled && !timedOut && !spawnError, output, cancelled });
    };

    // 按 utf8 解码(跨块的多字节字符由流的解码器拼好)
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => stdout.append(chunk));
    child.stderr.on('data', (chunk) => stderr.append(chunk));
    child.on('error', (error) => finish(null, String(error?.message || error)));
    // close = bash 退出且输出管道都关了;停止 / 超时时组里其余进程由 stopGroup 收掉
    child.on('close', (code) => finish(code));
  });
}
