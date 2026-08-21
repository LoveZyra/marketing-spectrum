import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let sessionMessagesDb: typeof import('@/modules/database/index.js')['sessionMessagesDb'];
let isDurableDisplayMessage: typeof import('@/modules/database/index.js')['isDurableDisplayMessage'];
let closeConnection: () => void;
let tempDir: string;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-display-log-'));
  // 必须是 DATABASE_PATH:连接层只认这个变量(见 connection.ts 的 resolveDatabasePath)。
  // 设错变量的后果不是"测试失败",而是**测试写进真库** —— 用例之间互相看得见,
  // 幂等那条今天就是这么假绿又假红的。
  process.env.DATABASE_PATH = path.join(tempDir, 'auth.db');
  const db = await import('@/modules/database/index.js');
  sessionMessagesDb = db.sessionMessagesDb;
  isDurableDisplayMessage = db.isDurableDisplayMessage;
  closeConnection = db.closeConnection;
  db.initializeDatabase();
});

afterAll(() => {
  try { closeConnection?.(); } catch { /* ignore */ }
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

const message = (over: Record<string, unknown> = {}) => ({
  id: 'm1',
  sessionId: 's1',
  kind: 'text',
  role: 'assistant',
  content: 'hello',
  timestamp: '2026-08-20T10:00:00.000Z',
  provider: 'claude',
  ...over,
}) as never;

describe('显示日志:什么该留下', () => {
  it('对话内容留下', () => {
    for (const kind of ['text', 'thinking', 'tool_use', 'tool_result', 'error']) {
      expect(isDurableDisplayMessage({ kind })).toBe(true);
    }
  });

  it('每 token 一条的流式增量、瞬时状态、权限询问一律不留 —— 留了就是把洪流灌进库里', () => {
    for (const kind of ['stream_delta', 'stream_end', 'complete', 'status',
                        'permission_request', 'permission_cancelled',
                        'session_created', 'checkpoint_created', 'changed_files']) {
      expect(isDurableDisplayMessage({ kind })).toBe(false);
    }
  });

  it('未知 kind 默认不留(白名单语义)', () => {
    expect(isDurableDisplayMessage({ kind: 'some_future_kind' })).toBe(false);
    expect(isDurableDisplayMessage({})).toBe(false);
  });
});

describe('显示日志:读写', () => {
  it('按追加顺序原样读回', () => {
    sessionMessagesDb.append('s-order', message({ id: 'a', sessionId: 's-order', content: '第一条' }));
    sessionMessagesDb.append('s-order', message({ id: 'b', sessionId: 's-order', content: '第二条' }));
    sessionMessagesDb.append('s-order', message({ id: 'c', sessionId: 's-order', content: '第三条' }));
    const rows = sessionMessagesDb.listForSession('s-order');
    assert.deepEqual(rows.map((r) => r.content), ['第一条', '第二条', '第三条']);
  });

  it('同一条重复推送幂等 —— 重连补发不该在历史里翻倍', () => {
    const m = message({ id: 'dup', sessionId: 's-dup' });
    expect(sessionMessagesDb.append('s-dup', m)).toBe(true);
    expect(sessionMessagesDb.append('s-dup', m)).toBe(false);
    assert.equal(sessionMessagesDb.countForSession('s-dup'), 1);
  });

  it('payload 原样往返,不做二次归一化', () => {
    const rich = message({
      id: 'rich', sessionId: 's-rich', kind: 'tool_use',
      toolName: 'Bash', toolInput: { command: 'ls -la' }, parentToolUseId: 'toolu_x',
    });
    sessionMessagesDb.append('s-rich', rich);
    const [back] = sessionMessagesDb.listForSession('s-rich');
    assert.deepEqual(back, rich);
  });

  it('非持久 kind 不写库', () => {
    expect(sessionMessagesDb.append('s-skip', message({ id: 'sd', kind: 'stream_delta' }))).toBe(false);
    assert.equal(sessionMessagesDb.countForSession('s-skip'), 0);
  });

  it('会话删除后日志一并清掉', () => {
    sessionMessagesDb.append('s-del', message({ id: 'x', sessionId: 's-del' }));
    assert.equal(sessionMessagesDb.countForSession('s-del'), 1);
    sessionMessagesDb.deleteForSession('s-del');
    assert.equal(sessionMessagesDb.countForSession('s-del'), 0);
  });

  it('没有日志的会话返回 0 —— 上层据此回落到 transcript', () => {
    assert.equal(sessionMessagesDb.countForSession('s-never-seen'), 0);
  });
});

describe('显示日志:没有 id 的消息', () => {
  it('两条都没 id 也各占一行 —— 不能被空串唯一键当成重复吞掉', () => {
    expect(sessionMessagesDb.append('s-noid', message({ id: undefined, sessionId: 's-noid', content: '甲' }))).toBe(true);
    expect(sessionMessagesDb.append('s-noid', message({ id: undefined, sessionId: 's-noid', content: '乙' }))).toBe(true);
    assert.deepEqual(
      sessionMessagesDb.listForSession('s-noid').map((r) => r.content),
      ['甲', '乙'],
    );
  });
});
