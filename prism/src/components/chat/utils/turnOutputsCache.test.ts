import { beforeEach, describe, expect, it, vi } from 'vitest';

import { readCachedTurnOutputs, writeCachedTurnOutputs } from './turnOutputsCache';

/**
 * ek:「产出」卡的本地快照。
 *
 * 它存在的唯一理由是**刷新页面时卡片不消失** —— 服务端映射走的是 work-frames
 * 那一次请求,内存清空后有一段空窗(用户实测:"一刷新产出文件的部分就会消失,
 * 然后等待重新加载完成")。挂载时同步读回快照,首帧就有卡片。
 */
const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  });
});

const files = (n: number) => Array.from({ length: n }, (_, i) => ({ path: `/p/f${i}.md`, addedLines: i }));

describe('turnOutputsCache', () => {
  it('存进去、读回来是同一份', () => {
    writeCachedTurnOutputs('s1', { a1: files(2), a2: files(1) });
    expect(readCachedTurnOutputs('s1')).toEqual({ a1: files(2), a2: files(1) });
  });

  it('没有缓存 / 没有会话 id → null(调用方退回空表,不是崩)', () => {
    expect(readCachedTurnOutputs('never-seen')).toBeNull();
    expect(readCachedTurnOutputs(null)).toBeNull();
    writeCachedTurnOutputs(null, { a1: files(1) });
    expect(store.size).toBe(0);
  });

  it('每个会话只留最近的一批回合', () => {
    const turns: Record<string, ReturnType<typeof files>> = {};
    for (let i = 0; i < 200; i += 1) turns[`a${i}`] = files(1);
    writeCachedTurnOutputs('s1', turns);
    const back = readCachedTurnOutputs('s1');
    expect(Object.keys(back ?? {}).length).toBeLessThanOrEqual(120);
    // 留的是**最近的**(尾部),不是最早的
    expect(back).toHaveProperty('a199');
    expect(back).not.toHaveProperty('a0');
  });

  it('会话数有上限,最旧的先走', () => {
    for (let i = 0; i < 12; i += 1) writeCachedTurnOutputs(`s${i}`, { a1: files(1) });
    const raw = JSON.parse(store.get('prism-turn-outputs-v1') || '{}');
    expect(Object.keys(raw).length).toBeLessThanOrEqual(8);
    expect(raw).toHaveProperty('s11');
    expect(raw).not.toHaveProperty('s0');
  });

  it('损坏的缓存不抛,当成没有', () => {
    store.set('prism-turn-outputs-v1', '{ not json');
    expect(readCachedTurnOutputs('s1')).toBeNull();
    store.set('prism-turn-outputs-v1', '[1,2,3]');
    expect(readCachedTurnOutputs('s1')).toBeNull();
    store.set('prism-turn-outputs-v1', '{"s1":{"at":1}}');
    expect(readCachedTurnOutputs('s1')).toBeNull();
  });

  it('存储抛异常(隐私模式 / 配额满)也不影响功能', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
      removeItem: () => { throw new Error('denied'); },
    });
    expect(() => writeCachedTurnOutputs('s1', { a1: files(1) })).not.toThrow();
    expect(readCachedTurnOutputs('s1')).toBeNull();
  });
});
