import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, test } from 'vitest';

import { userTurnReachedTranscript } from '../claude-sdk.js';

/**
 * B8 回归:回退重放前的 transcript 侦察。
 *
 * 常驻回合在"输入已递交、还没流出内容"时崩溃,分发器要判断该不该把这一轮
 * 丢给一次性路径重放。判据:transcript 尾部有没有 timestamp 晚于回合起点的
 * user 行 —— 有(消息已落盘)就**不**重放(避免重复用户消息),没有才安全重放。
 * 拿不准(读不到文件 / 没有 resume id)一律按"已落盘"处理:宁可让用户重发。
 *
 * 该函数按 provider 的落盘约定拼路径:
 *   ~/.claude/projects/<cwd 编码>/<providerSessionId>.jsonl
 * 测试用 HOME 覆写把它指到临时目录。
 */

async function withFakeHome(runTest) {
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const tempHome = await mkdtemp(path.join(os.tmpdir(), 'sdk-transcript-'));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  try {
    await runTest(tempHome);
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousUserProfile;
    await rm(tempHome, { recursive: true, force: true });
  }
}

async function seedTranscript(home, cwd, providerSessionId, lines) {
  const encoded = String(cwd).replace(/[^a-zA-Z0-9-]/g, '-');
  const dir = path.join(home, '.claude', 'projects', encoded);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${providerSessionId}.jsonl`);
  await writeFile(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

describe('userTurnReachedTranscript', () => {
  test('没有 resume id → 按已落盘处理(true,不重放)', async () => {
    const reached = await userTurnReachedTranscript({ cwd: '/tmp/x' }, Date.now());
    assert.equal(reached, true);
  });

  test('transcript 不存在 → 读不到,按已落盘处理(true)', async () => {
    await withFakeHome(async () => {
      const reached = await userTurnReachedTranscript(
        { resumeSessionId: 'no-such-provider-id', cwd: '/home/proj' },
        Date.now(),
      );
      assert.equal(reached, true);
    });
  });

  test('尾部有晚于回合起点的 user 行 → 消息已落盘(true,不重放)', async () => {
    await withFakeHome(async (home) => {
      const cwd = '/home/proj';
      const sid = 'prov-1111';
      const since = Date.parse('2026-08-25T10:00:00.000Z');
      await seedTranscript(home, cwd, sid, [
        { type: 'user', timestamp: '2026-08-25T09:59:00.000Z', message: { role: 'user', content: '旧消息' } },
        { type: 'assistant', timestamp: '2026-08-25T09:59:30.000Z', message: { role: 'assistant' } },
        { type: 'user', timestamp: '2026-08-25T10:00:05.000Z', message: { role: 'user', content: '这一轮的消息' } },
      ]);
      const reached = await userTurnReachedTranscript({ resumeSessionId: sid, cwd }, since);
      assert.equal(reached, true);
    });
  });

  test('尾部最新 user 行早于回合起点 → 消息没落盘(false,可安全重放)', async () => {
    await withFakeHome(async (home) => {
      const cwd = '/home/proj';
      const sid = 'prov-2222';
      const since = Date.parse('2026-08-25T10:00:00.000Z');
      await seedTranscript(home, cwd, sid, [
        { type: 'user', timestamp: '2026-08-25T09:50:00.000Z', message: { role: 'user', content: '上一轮' } },
        { type: 'assistant', timestamp: '2026-08-25T09:50:30.000Z', message: { role: 'assistant' } },
      ]);
      // 文件 mtime 就是刚写的(≈now),晚于 since-2s,所以会进尾部扫描;
      // 扫描发现最新 user 行(09:50)早于 since → 判定未落盘。
      const reached = await userTurnReachedTranscript({ resumeSessionId: sid, cwd }, since);
      assert.equal(reached, false);
    });
  });
});
