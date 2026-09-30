import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, describe, test, vi } from 'vitest';

/**
 * hl 复核:常驻路径里压缩态的收尾。
 *
 * 1. CLI 先发 `status{compact_result:'success'}` 再吐 `compact_boundary` —— 边界帧不能
 *    把压缩态重新点亮(baseline:点亮到回合结束,剩余回合都按压缩上限计时);
 * 2. PreCompact hook 拦下压缩时只有 `status:null`、没有 `compact_result` —— 要收尾
 *    (baseline:一直亮到回合结束,最后被当成"压缩成功");
 * 3. 只有边界帧、没有 status 帧的压缩:边界帧即完成,立即收尾;
 * 4. 压缩上限默认 15 分钟(常驻路径压缩期间没有保活帧,这实际是总时长上限)。
 *
 * SDK 的 `query` 用 vi.mock 换成脚本,不起子进程、不花钱。
 */

let script = [];

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ prompt }) => {
    const frames = script;
    return {
      async *[Symbol.asyncIterator]() {
        // 每收到一条用户输入,吐一遍脚本
        for await (const _message of prompt) {
          for (const frame of frames) yield frame;
        }
      },
      interrupt: async () => {},
      close: () => {},
      getContextUsage: async () => null,
      setPermissionMode: async () => {},
      setModel: async () => {},
      supportedCommands: async () => [],
    };
  },
}));

const sdk = await import('../claude-sdk.js');
const { queryClaudeSDK, disposeAllRuntimes, readCompactionIdleTimeout } = sdk;

const cwd = mkdtempSync(path.join(tmpdir(), 'hl-compact-'));

afterAll(async () => { await disposeAllRuntimes(); });

function writer() {
  const frames = [];
  return { frames, userId: 1, send: (f) => { frames.push(f); }, setSessionId: () => {} };
}

/** 压缩态的"点亮 / 收尾"序列。心跳帧(phase running、beat>0)不算点亮,滤掉。 */
const phases = (frames) => frames
  .filter((f) => f?.statusKind === 'compacting')
  .filter((f) => !(f.compaction.phase === 'running' && f.compaction.beat > 0))
  .map((f) => f.compaction.phase);

async function runTurn(sessionUuid, frames) {
  script = frames.map((f) => ({ session_id: sessionUuid, ...f }));
  const ws = writer();
  await queryClaudeSDK('hi', { cwd, projectPath: cwd, runId: `run-${sessionUuid}`, permissionMode: 'default' }, ws);
  return ws.frames;
}

const result = { type: 'result', subtype: 'success', is_error: false, result: 'ok' };
const assistant = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '继续干活' }] } };

describe('hl 复核:压缩态的收尾', () => {
  test('status 成功 → 边界帧:不再重新点亮(只有一次 running → done)', async () => {
    const frames = await runTurn('aaaaaaaa-0000-4000-8000-000000000001', [
      { type: 'system', subtype: 'init' },
      { type: 'system', subtype: 'status', status: 'compacting' },
      { type: 'system', subtype: 'status', status: null, compact_result: 'success' },
      { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 150000, post_tokens: 20000, duration_ms: 42000 } },
      assistant,
      result,
    ]);
    // baseline-hk:['running','done','running','done'] —— 第二次 running 一直亮到回合结束。
    assert.deepEqual(phases(frames), ['running', 'done']);
  });

  test('PreCompact hook 拦截:status:null 无 compact_result → 立即按"跳过"收尾', async () => {
    const frames = await runTurn('aaaaaaaa-0000-4000-8000-000000000002', [
      { type: 'system', subtype: 'init' },
      { type: 'system', subtype: 'status', status: 'compacting' },
      { type: 'system', subtype: 'status', status: null },
      assistant,
      result,
    ]);
    const ps = phases(frames);
    // baseline-hk:['running','done'] —— 被拦下的压缩在回合结束时被报成"压缩成功"。
    assert.deepEqual(ps, ['running', 'skipped']);
    const skipped = frames.find((f) => f?.statusKind === 'compacting' && f.compaction.phase === 'skipped');
    const skippedAt = frames.indexOf(skipped);
    const textAt = frames.findIndex((f) => f?.kind === 'text');
    assert.ok(skippedAt < textAt, '收尾应当发生在 status:null 那一刻,而不是回合结束');
  });

  test('只有边界帧的压缩:边界帧即完成,带上元数据', async () => {
    const frames = await runTurn('aaaaaaaa-0000-4000-8000-000000000003', [
      { type: 'system', subtype: 'init' },
      { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 90000, post_tokens: 10000, duration_ms: 30000 } },
      assistant,
      result,
    ]);
    assert.deepEqual(phases(frames), ['running', 'done']);
    const done = frames.find((f) => f?.statusKind === 'compacting' && f.compaction.phase === 'done');
    assert.equal(done.compaction.trigger, 'manual');
    assert.equal(done.compaction.preTokens, 90000);
    assert.equal(done.compaction.postTokens, 10000);
    const doneAt = frames.indexOf(done);
    assert.ok(doneAt < frames.findIndex((f) => f?.kind === 'text'), '边界帧到了就收尾');
  });

  test('压缩上限默认 15 分钟;0 关闭;废值回默认', () => {
    assert.equal(readCompactionIdleTimeout({}), 15 * 60 * 1000);
    assert.equal(readCompactionIdleTimeout({ PRISM_COMPACT_TIMEOUT_MS: '0' }), 0);
    assert.equal(readCompactionIdleTimeout({ PRISM_COMPACT_TIMEOUT_MS: 'abc' }), 15 * 60 * 1000);
  });
});
