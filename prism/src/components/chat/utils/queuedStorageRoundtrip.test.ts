import { beforeEach, describe, expect, it } from 'vitest';

import { readQueuedMessage, writeQueuedMessage, claimQueuedMessageAs, queuedMessageKey } from './chatStorage';
import { fromStoredCommand, toStoredCommand, restoredEntry, type SendCommand } from './sendCommand';

/**
 * fz:**这条测试必须真的走一遍 localStorage。**
 *
 * 老的那条(outboxLifecycle.test.ts)拿 `toStoredCommand(...)` 的返回值直接喂
 * `fromStoredCommand`,中间没经过存储 —— 于是 `readQueuedMessage` 把七个字段
 * 削成两个这件事,一条测试都红不起来。凡是跨存储的边界,测试必须真的跨过去。
 */
/**
 * 测试环境是 node,没有 localStorage。这里装一个**真的会序列化**的内存实现 ——
 * 关键就在于让 JSON 的写入与读出真的发生一次,而不是把对象直接传过去。
 */
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
  setItem: (key: string, value: string) => { store.set(key, String(value)); },
  removeItem: (key: string) => { store.delete(key); },
  clear: () => store.clear(),
  key: (index: number) => Array.from(store.keys())[index] ?? null,
  get length() { return store.size; },
};

beforeEach(() => { store.clear(); });

const command = (over: Partial<SendCommand> = {}): SendCommand => ({
  clientMessageId: 'cmd_abc_123',
  sessionKey: 'S',
  sessionId: 'S',
  projectId: 'P',
  text: '看这张图,顺便把 README 改了',
  namingText: '看这张图',
  images: [{ path: '/proj/attachments/a.png' } as never],
  options: { model: 'claude-x' } as never,
  forkFrom: { sessionId: 'parent' } as never,
  hiddenContext: '隐藏上下文',
  createdAt: 1,
  ...over,
} as SendCommand);

describe('排队命令的存储往返', () => {
  it('**写进去七项,读回来还是七项**', () => {
    writeQueuedMessage('S', toStoredCommand(command()));
    const back = readQueuedMessage('S') as Record<string, unknown> | null;
    expect(back).not.toBeNull();
    expect(back?.clientMessageId).toBe('cmd_abc_123');
    expect(back?.imageCount).toBe(1);
    expect(Array.isArray(back?.images)).toBe(true);
    expect(back?.forkFrom).toBeTruthy();
    expect(back?.hiddenContext).toBe('隐藏上下文');
    expect(back?.namingText).toBe('看这张图');
  });

  it('**附件还在 → 恢复成 queued**(不是"以为没图,照发")', () => {
    writeQueuedMessage('S', toStoredCommand(command()));
    const stored = readQueuedMessage('S') as never;
    const entry = restoredEntry(fromStoredCommand(stored, { sessionKey: 'S', sessionId: 'S', projectId: 'P' }));
    expect(entry?.status).toBe('queued');
    expect(entry?.command.images).toHaveLength(1);
    expect(entry?.command.clientMessageId).toBe('cmd_abc_123');
  });

  it('**附件真丢了 → needs_attachment,停下来等用户**(F12 那道保险)', () => {
    const stored = { ...toStoredCommand(command()), images: [] };
    writeQueuedMessage('S', stored as never);
    const back = readQueuedMessage('S') as never;
    const entry = restoredEntry(fromStoredCommand(back, { sessionKey: 'S', sessionId: 'S', projectId: 'P' }));
    expect(entry?.status).toBe('needs_attachment');
  });

  it('**认领不许把盘上那份削平** —— 认领只该盖个戳', () => {
    writeQueuedMessage('S', toStoredCommand(command()));
    claimQueuedMessageAs('S', 'tab-1', 1000);
    const back = readQueuedMessage('S') as Record<string, unknown> | null;
    expect(back?.clientMessageId).toBe('cmd_abc_123');
    expect(back?.imageCount).toBe(1);
    expect(back?.claimedBy).toBe('tab-1');
  });

  it('老格式(裸文本)照旧读得出来', () => {
    localStorage.setItem(queuedMessageKey('S'), '就一句话');
    expect(readQueuedMessage('S')).toEqual({ content: '就一句话' });
  });

  it('空正文一律当没有', () => {
    writeQueuedMessage('S', { content: '   ' } as never);
    expect(readQueuedMessage('S')).toBeNull();
  });
});
