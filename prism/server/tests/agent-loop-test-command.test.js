import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, describe, test } from 'vitest';

import { runTestCommand } from '../services/agent-loop.js';

/**
 * /loop 的验证命令:停止或超时要把整条命令连同它派生的子进程一起收掉,不能只杀外层 bash。
 * 复合命令(`npm run build && npm test`)与 npm / pytest 派生的 worker 都是 bash 的子进程,
 * 只杀 bash 的话它们会被过继给 1 号进程继续跑(占端口、写构建产物)。
 */

const cwd = mkdtempSync(path.join(tmpdir(), 'prism-loop-test-'));
afterAll(() => rmSync(cwd, { recursive: true, force: true }));

/** 用 `exec -a` 给孙进程起一个独一无二的名字,好在 ps 里认出它。 */
const probeName = (tag) => `prism_loop_probe_${process.pid}_${tag}`;
// 只认命令名就是它的那一行(外层 bash 的参数里也带着这个名字)
const survivors = (name) => execSync('ps -eo pid,ppid,args').toString()
  .split('\n')
  .filter((line) => line.trim().split(/\s+/)[2] === name);
const waitUntilGone = async (name, timeoutMs = 4000) => {
  const started = Date.now();
  while (survivors(name).length > 0 && Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return survivors(name);
};

describe('runTestCommand', () => {
  test('按停止:整个进程组收掉,复合命令里的子进程不留成孤儿', async () => {
    const name = probeName('abort');
    const controller = new AbortController();
    const running = runTestCommand(cwd, `bash -c "exec -a ${name} sleep 30" && echo never`, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(survivors(name).length, 1, '前提:孙进程起来了');
    controller.abort();
    const result = await running;
    assert.equal(result.cancelled, true);
    assert.equal(result.ok, false);
    assert.deepEqual(await waitUntilGone(name), [], '孙进程也被收掉了');
  });

  test('超时:同样整组收掉,判为没通过(不是被叫停)', async () => {
    const name = probeName('timeout');
    const result = await runTestCommand(cwd, `bash -c "exec -a ${name} sleep 30"; echo after`, { timeoutMs: 400 });
    assert.equal(result.ok, false);
    assert.equal(result.cancelled, false);
    assert.deepEqual(await waitUntilGone(name), []);
  });

  test('信号到之前就已叫停:不起进程,直接按被叫停返回', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runTestCommand(cwd, 'echo should-not-run', { signal: controller.signal });
    assert.equal(result.cancelled, true);
    assert.equal(result.ok, false);
    assert.doesNotMatch(result.output, /should-not-run/);
  });

  test('退出码决定通过与否;输出合并 stdout 与 stderr', async () => {
    const pass = await runTestCommand(cwd, 'echo out-line; echo err-line 1>&2');
    assert.equal(pass.ok, true);
    assert.equal(pass.cancelled, false);
    assert.match(pass.output, /out-line/);
    assert.match(pass.output, /err-line/);
    const fail = await runTestCommand(cwd, 'echo boom; exit 3');
    assert.equal(fail.ok, false);
    assert.equal(fail.cancelled, false);
    assert.match(fail.output, /boom/);
  });

  test('输出很大也不影响判定(只留尾部),通过的测试不会因为输出超过缓冲上限被判成失败', async () => {
    const result = await runTestCommand(cwd, "head -c 20000000 /dev/zero | tr '\\0' 'a'; echo; echo tail-marker");
    assert.equal(result.ok, true);
    assert.match(result.output, /^…\(truncated\)\n/);
    assert.match(result.output, /tail-marker$/);
    assert.ok(result.output.length < 7000);
  });
});
