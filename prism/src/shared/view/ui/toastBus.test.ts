import { describe, test, expect, beforeEach } from 'vitest';

import { emitToast, subscribeToast } from './toastBus';

/**
 * by / D3:toast 事件总线。组件与非组件(如 api.js 的 401 拦截)共用它。
 * 关键契约:订阅者收到 emit;订阅前 emit 的会在订阅时补发(backlog);退订后不再收。
 */
describe('toastBus', () => {
  const received: string[] = [];
  let unsub: (() => void) | null = null;

  beforeEach(() => {
    received.length = 0;
    if (unsub) { unsub(); unsub = null; }
  });

  test('订阅者收到 emit 的提示', () => {
    unsub = subscribeToast((t) => received.push(t.message));
    emitToast({ message: 'hello' });
    expect(received).toEqual(['hello']);
  });

  test('订阅前 emit 的在订阅时补发(backlog 不丢)', () => {
    // 没有订阅者时 emit
    emitToast({ message: 'early-1' });
    emitToast({ message: 'early-2' });
    // 之后订阅,应补发
    unsub = subscribeToast((t) => received.push(t.message));
    expect(received).toEqual(['early-1', 'early-2']);
  });

  test('退订后不再收到', () => {
    unsub = subscribeToast((t) => received.push(t.message));
    emitToast({ message: 'a' });
    unsub();
    unsub = null;
    emitToast({ message: 'b' });
    expect(received).toEqual(['a']);
  });

  test('emit 返回递增 id', () => {
    const id1 = emitToast({ message: 'x' });
    const id2 = emitToast({ message: 'y' });
    expect(typeof id1).toBe('number');
    expect(id2).toBeGreaterThan(id1);
  });
});
