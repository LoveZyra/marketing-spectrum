import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  claimQueuedMessageAs,
  clearQueuedMessage,
  queuedMessageKey,
  readQueuedMessage,
  releaseQueuedMessageAs,
  writeQueuedMessage,
} from './chatStorage';
import {
  QUEUE_CLAIM_TTL_MS,
  canClaim,
  claimHeldBy,
  getLockManager,
  makeTabId,
  queueLockName,
  runExclusive,
  withoutClaim,
} from './queueClaim';

/** vitest 跑在 node 环境,没有 localStorage —— 装一个最小的同步实现。 */
function installLocalStorage() {
  const store = new Map<string, string>();
  const shim = {
    getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: shim, configurable: true, writable: true });
  return store;
}

describe('canClaim', () => {
  const now = 1_000_000;

  test('没人认领:随便谁都能拿', () => {
    expect(canClaim({}, 'tab-a', now)).toBe(true);
  });

  test('别的标签页刚认领:拿不到', () => {
    expect(canClaim({ claimedBy: 'tab-b', claimedAt: now - 10 }, 'tab-a', now)).toBe(false);
  });

  test('自己的戳:续期,不是抢锁', () => {
    expect(canClaim({ claimedBy: 'tab-a', claimedAt: now - 10 }, 'tab-a', now)).toBe(true);
  });

  test('认领方崩了:过了 TTL 就能接手,消息不会永远卡住', () => {
    expect(canClaim({ claimedBy: 'tab-b', claimedAt: now - QUEUE_CLAIM_TTL_MS }, 'tab-a', now)).toBe(true);
  });

  test('戳残缺(有 claimedBy 没 claimedAt)按已过期处理,不做永久锁', () => {
    expect(canClaim({ claimedBy: 'tab-b' }, 'tab-a', now)).toBe(true);
  });

  test('没有记录就没得认领', () => {
    expect(canClaim(null, 'tab-a', now)).toBe(false);
  });
});

describe('claimHeldBy / withoutClaim', () => {
  test('回读校验只认自己的戳', () => {
    expect(claimHeldBy({ claimedBy: 'tab-a' }, 'tab-a')).toBe(true);
    expect(claimHeldBy({ claimedBy: 'tab-b' }, 'tab-a')).toBe(false);
    expect(claimHeldBy(null, 'tab-a')).toBe(false);
  });

  test('摘戳只动认领字段,正文和发送选项原样保留', () => {
    expect(withoutClaim({ content: 'hi', options: { model: 'x' }, claimedBy: 'tab-a', claimedAt: 1 })).toEqual({
      content: 'hi',
      options: { model: 'x' },
    });
  });
});

describe('makeTabId / queueLockName', () => {
  test('两个标签页拿到的 id 不一样', () => {
    expect(makeTabId()).not.toBe(makeTabId());
  });

  test('锁名按会话分,不同会话不互相阻塞', () => {
    expect(queueLockName('s1')).not.toBe(queueLockName('s2'));
  });
});

describe('runExclusive', () => {
  test('环境没有 Web Locks 时直接跑(靠盖戳兜底)', async () => {
    expect(getLockManager({})).toBeNull();
    await expect(runExclusive('n', () => 42, {})).resolves.toBe(42);
  });

  test('有 Web Locks 时在锁里跑', async () => {
    const request = vi.fn(async (_name: string, cb: () => unknown) => await cb());
    const scope = { navigator: { locks: { request } } };
    await expect(runExclusive('lock-name', () => 7, scope)).resolves.toBe(7);
    expect(request).toHaveBeenCalledWith('lock-name', expect.any(Function));
  });

  test('不吞异常 —— 排队记录还在,下一轮能重来,在这里重跑会发重', async () => {
    const boom = new Error('socket closed');
    await expect(runExclusive('n', () => { throw boom; }, {})).rejects.toBe(boom);
  });
});

describe('claimQueuedMessageAs(跨标签页互斥)', () => {
  beforeEach(() => { installLocalStorage(); });
  afterEach(() => { clearQueuedMessage('s1'); });

  test('认领成功后戳落在 localStorage 上,别的标签页看得见', () => {
    writeQueuedMessage('s1', { content: '排队的这条', options: { model: 'glm' } });
    const claimed = claimQueuedMessageAs('s1', 'tab-a', 5_000);
    expect(claimed?.content).toBe('排队的这条');
    expect(claimed?.options).toEqual({ model: 'glm' });
    expect(readQueuedMessage('s1')?.claimedBy).toBe('tab-a');
  });

  test('两个标签页同时认领:只有一个拿到', () => {
    writeQueuedMessage('s1', { content: '排队的这条' });
    expect(claimQueuedMessageAs('s1', 'tab-a', 5_000)).not.toBeNull();
    expect(claimQueuedMessageAs('s1', 'tab-b', 5_000)).toBeNull();
  });

  test('同 tick 交错(A读 B读 A写 B写)时,回读判定只让后写的那个发', () => {
    // 手写交错:两个标签页都在对方盖戳之前读到了"没人认领"。
    writeQueuedMessage('s1', { content: '排队的这条' });
    const aSaw = readQueuedMessage('s1');
    const bSaw = readQueuedMessage('s1');
    expect(canClaim(aSaw, 'tab-a', 5_000)).toBe(true);
    expect(canClaim(bSaw, 'tab-b', 5_000)).toBe(true);

    writeQueuedMessage('s1', { ...aSaw!, claimedBy: 'tab-a', claimedAt: 5_000 });
    writeQueuedMessage('s1', { ...bSaw!, claimedBy: 'tab-b', claimedAt: 5_000 });

    // 回读:两边都再看一次,只有 tab-b 认出自己的戳。
    const settled = readQueuedMessage('s1');
    expect(claimHeldBy(settled, 'tab-a')).toBe(false);
    expect(claimHeldBy(settled, 'tab-b')).toBe(true);
  });

  test('认领方超时后另一个标签页能接手 —— 消息不会因为对方崩了而丢', () => {
    writeQueuedMessage('s1', { content: '排队的这条' });
    expect(claimQueuedMessageAs('s1', 'tab-a', 5_000)).not.toBeNull();
    expect(claimQueuedMessageAs('s1', 'tab-b', 5_000 + QUEUE_CLAIM_TTL_MS)).not.toBeNull();
    expect(readQueuedMessage('s1')?.claimedBy).toBe('tab-b');
  });

  test('没有排队记录时认领返回 null', () => {
    expect(claimQueuedMessageAs('s1', 'tab-a', 5_000)).toBeNull();
  });

  test('发送失败摘戳后,另一个标签页立刻能接手', () => {
    writeQueuedMessage('s1', { content: '排队的这条' });
    claimQueuedMessageAs('s1', 'tab-a', 5_000);
    releaseQueuedMessageAs('s1', 'tab-a');
    expect(readQueuedMessage('s1')?.claimedBy).toBeUndefined();
    expect(claimQueuedMessageAs('s1', 'tab-b', 5_001)).not.toBeNull();
  });

  test('摘戳只摘自己的,不动别人的', () => {
    writeQueuedMessage('s1', { content: '排队的这条' });
    claimQueuedMessageAs('s1', 'tab-a', 5_000);
    releaseQueuedMessageAs('s1', 'tab-b');
    expect(readQueuedMessage('s1')?.claimedBy).toBe('tab-a');
  });

  test('重新入队会覆盖旧戳:新的一条排队是新的一次认领', () => {
    writeQueuedMessage('s1', { content: '第一条' });
    claimQueuedMessageAs('s1', 'tab-a', 5_000);
    writeQueuedMessage('s1', { content: '第二条' });
    expect(readQueuedMessage('s1')?.claimedBy).toBeUndefined();
    expect(claimQueuedMessageAs('s1', 'tab-b', 5_001)?.content).toBe('第二条');
  });

  test('历史遗留的纯文本排队记录也能被认领', () => {
    localStorage.setItem(queuedMessageKey('s1'), '老格式的裸文本');
    const claimed = claimQueuedMessageAs('s1', 'tab-a', 5_000);
    expect(claimed?.content).toBe('老格式的裸文本');
    expect(readQueuedMessage('s1')?.claimedBy).toBe('tab-a');
  });
});
