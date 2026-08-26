/**
 * bs:会话排序按「真实发生会话的时间」,而不是文件 mtime。
 *
 * 点开会话会触发预热(claude --resume),它会碰 JSONL 的 mtime 却不追加消息 ——
 * 以前 updated_at 取 mtime,于是"只点一下没说话"也把会话顶到最前。改成取最后一条
 * user/assistant 消息的时间;这里钉住那条挑选规则。
 */
import { describe, it, expect } from 'vitest';

import { pickLastActivityTimestamp } from '../claude-session-synchronizer.provider.js';

const line = (o: Record<string, unknown>) => JSON.stringify(o);

describe('pickLastActivityTimestamp', () => {
  it('取最后一条 user/assistant 的时间', () => {
    const content = [
      line({ type: 'user', timestamp: '2026-08-25T10:00:00.000Z', message: { role: 'user', content: 'hi' } }),
      line({ type: 'assistant', timestamp: '2026-08-25T10:00:05.000Z', message: { role: 'assistant' } }),
    ].join('\n');
    expect(pickLastActivityTimestamp(content)).toBe('2026-08-25T10:00:05.000Z');
  });

  it('尾部的元数据行不算活动(预热/改名/压缩等碰了文件但没说话)', () => {
    const content = [
      line({ type: 'user', timestamp: '2026-08-25T10:00:00.000Z', message: { role: 'user' } }),
      line({ type: 'assistant', timestamp: '2026-08-25T10:00:05.000Z', message: { role: 'assistant' } }),
      // 下面这些都在最后一条对话之后,但都不是真实会话,必须被跳过
      line({ type: 'queue-operation', timestamp: '2026-08-25T13:00:00.000Z' }),
      line({ type: 'custom-title', customTitle: 'x', timestamp: '2026-08-25T13:01:00.000Z' }),
      line({ type: 'summary', timestamp: '2026-08-25T13:02:00.000Z' }),
      line({ type: 'system', subtype: 'compact_boundary', timestamp: '2026-08-25T13:03:00.000Z' }),
    ].join('\n');
    // 期望仍是最后一条 assistant 的 10:00:05,而不是 13:xx 的元数据
    expect(pickLastActivityTimestamp(content)).toBe('2026-08-25T10:00:05.000Z');
  });

  it('新的一轮真实对话会前移时间', () => {
    const content = [
      line({ type: 'user', timestamp: '2026-08-25T10:00:00.000Z', message: { role: 'user' } }),
      line({ type: 'assistant', timestamp: '2026-08-25T10:00:05.000Z', message: { role: 'assistant' } }),
      line({ type: 'user', timestamp: '2026-08-25T14:00:00.000Z', message: { role: 'user' } }),
    ].join('\n');
    expect(pickLastActivityTimestamp(content)).toBe('2026-08-25T14:00:00.000Z');
  });

  it('无对话行 / 空内容 / 坏行 → undefined(调用方回落到 mtime)', () => {
    expect(pickLastActivityTimestamp('')).toBeUndefined();
    expect(pickLastActivityTimestamp('not json\n{bad')).toBeUndefined();
    expect(pickLastActivityTimestamp(line({ type: 'queue-operation', timestamp: '2026-08-25T13:00:00.000Z' }))).toBeUndefined();
  });

  it('非法 timestamp 跳过,取更早的合法那条', () => {
    const content = [
      line({ type: 'assistant', timestamp: '2026-08-25T10:00:05.000Z', message: {} }),
      line({ type: 'user', timestamp: 'not-a-date', message: {} }),
    ].join('\n');
    expect(pickLastActivityTimestamp(content)).toBe('2026-08-25T10:00:05.000Z');
  });
});
