/**
 * 工作面板基线的条件请求。
 *
 * 回合结束、回滚后重取同一会话时带上次落地那份的 ETag;服务端回 304 时什么都不动(不重新解析、
 * 不重设状态,清单 / 产出也就不重折)。ETag 只在响应真正落地时记,切会话时清掉:304 的意思是
 * "你手里那份就是最新的",手里那份必须真是这个会话当前显示的那份。
 *
 * vitest 这边没有 jsdom,这里用一个只驱动单个 hook 的最小 hooks 运行时替掉 react,
 * 配一个由测试逐个应答的假 authenticatedFetch,把时序一步步推出来。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => {
  type Slot = {
    value?: unknown;
    setter?: (next: unknown) => void;
    current?: unknown;
    fn?: unknown;
    deps?: unknown[] | null;
    cleanup?: (() => void) | void;
  };
  let slots: Slot[] = [];
  let cursor = 0;
  let effects: Array<() => void> = [];
  let component: (() => unknown) | null = null;
  let output: unknown = null;
  let scheduled = false;

  const sameDeps = (a?: unknown[] | null, b?: unknown[] | null) =>
    !!a && !!b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));

  const render = () => {
    if (!component) return;
    cursor = 0;
    output = component();
    const run = effects;
    effects = [];
    run.forEach((effect) => effect());
  };

  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      render();
    });
  };

  const react = {
    useState(initial: unknown) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { value: typeof initial === 'function' ? (initial as () => unknown)() : initial };
      const slot = slots[index];
      if (!slot.setter) {
        slot.setter = (next: unknown) => {
          const value = typeof next === 'function' ? (next as (prev: unknown) => unknown)(slot.value) : next;
          if (!Object.is(value, slot.value)) {
            slot.value = value;
            schedule();
          }
        };
      }
      return [slot.value, slot.setter];
    },
    useRef(initial: unknown) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { current: initial };
      return slots[index];
    },
    useCallback(fn: unknown, deps: unknown[]) {
      const index = cursor++;
      const slot = slots[index];
      if (slot && sameDeps(slot.deps, deps)) return slot.fn;
      slots[index] = { fn, deps };
      return fn;
    },
    useEffect(effect: () => (() => void) | void, deps?: unknown[]) {
      const index = cursor++;
      const slot = slots[index] || (slots[index] = { deps: null });
      if (slot.deps && sameDeps(slot.deps, deps)) return;
      slot.deps = deps ?? null;
      effects.push(() => {
        if (typeof slot.cleanup === 'function') slot.cleanup();
        slot.cleanup = effect();
      });
    },
  };

  return {
    react,
    mount(fn: () => unknown) {
      slots = [];
      effects = [];
      component = fn;
      render();
    },
    rerender: render,
    current: () => output,
    unmount() {
      component = null;
      for (const slot of slots) {
        if (slot && typeof slot.cleanup === 'function') slot.cleanup();
      }
      slots = [];
    },
  };
});

const net = vi.hoisted(() => {
  type Call = { url: string; headers: Record<string, string>; respond: (response: unknown) => void };
  const calls: Call[] = [];
  return {
    calls,
    fetch: (url: string, options: { headers?: Record<string, string> } = {}) =>
      new Promise((resolve) => {
        calls.push({ url, headers: { ...(options.headers ?? {}) }, respond: resolve });
      }),
  };
});

vi.mock('react', () => ({ ...runtime.react, default: runtime.react }));
vi.mock('../../../utils/api', () => ({ authenticatedFetch: net.fetch }));

import { useSessionWorkFrames, type SessionWorkFramesState } from './useSessionWorkFrames';

const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  net.calls.length = 0;
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  });
});

afterEach(() => {
  runtime.unmount();
  vi.unstubAllGlobals();
});

const headerReader = (etag: string | null) => ({ get: (name: string) => (name.toLowerCase() === 'etag' ? etag : null) });
const ok = (etag: string | null, data: Record<string, unknown>) => ({
  ok: true,
  status: 200,
  headers: headerReader(etag),
  json: async () => ({ success: true, data }),
});
const notModified = (etag: string) => ({
  ok: false,
  status: 304,
  headers: headerReader(etag),
  json: async () => { throw new Error('304 没有响应体'); },
});

const task = (id: number, subject: string) => ({
  toolName: 'TaskCreate',
  toolInput: { subject },
  resultContent: `Task #${id} created successfully: ${subject}`,
  resultIsError: false,
  turn: 1,
});

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

let props = { sessionId: 's1' as string | null, isProcessing: false };
const mount = () => runtime.mount(() => useSessionWorkFrames(props.sessionId, props.isProcessing));
const state = () => runtime.current() as SessionWorkFramesState;
const setProps = (next: Partial<typeof props>) => {
  props = { ...props, ...next };
  runtime.rerender();
};
const lastCall = () => net.calls[net.calls.length - 1];

describe('useSessionWorkFrames 的 ETag / 304', () => {
  it('同一会话重取时带 If-None-Match;304 原样保留当前基线', async () => {
    props = { sessionId: 's1', isProcessing: false };
    mount();
    expect(net.calls).toHaveLength(1);
    expect(net.calls[0].url).toBe('/api/providers/sessions/s1/work-frames');
    expect(net.calls[0].headers['If-None-Match']).toBeUndefined();

    net.calls[0].respond(ok('"e1"', {
      frames: [task(1, '甲')],
      revertedPaths: [],
      turnOutputs: { a1: [{ path: '/p/a.md', addedLines: 3 }] },
      truncated: false,
      skillSurveys: [{ messageId: 'a1', skill: 'audit' }],
      userTurns: 1,
    }));
    await settle();
    const loaded = state();
    expect(loaded.baseMessages).toHaveLength(2);
    expect(loaded.turnOutputs).toEqual({ a1: [{ path: '/p/a.md', addedLines: 3 }] });
    expect([...loaded.skillSurveys]).toEqual([['a1', 'audit']]);

    // 回合结束:带上次的 ETag 重取,304 → 什么都不动
    setProps({ isProcessing: true });
    setProps({ isProcessing: false });
    expect(net.calls).toHaveLength(2);
    expect(lastCall().headers['If-None-Match']).toBe('"e1"');
    lastCall().respond(notModified('"e1"'));
    await settle();
    expect(state().baseMessages).toBe(loaded.baseMessages);
    expect(state().turnOutputs).toBe(loaded.turnOutputs);
    expect(state().skillSurveys).toBe(loaded.skillSurveys);

    // 手动 refresh 拿到新内容 → 换成新 ETag
    state().refresh();
    expect(lastCall().headers['If-None-Match']).toBe('"e1"');
    lastCall().respond(ok('"e2"', { frames: [task(1, '甲'), task(2, '乙')], userTurns: 1 }));
    await settle();
    expect(state().baseMessages).toHaveLength(3);
    state().refresh();
    expect(lastCall().headers['If-None-Match']).toBe('"e2"');
  });

  it('切会话清掉 ETag:切回来先整份重取,不拿旧 ETag 换一个空基线', async () => {
    props = { sessionId: 's1', isProcessing: false };
    mount();
    net.calls[0].respond(ok('"e1"', { frames: [task(1, '甲')], userTurns: 1 }));
    await settle();
    expect(state().baseMessages).toHaveLength(2);

    setProps({ sessionId: 's2' });
    await settle();
    expect(state().baseMessages).toEqual([]);
    expect(lastCall().url).toBe('/api/providers/sessions/s2/work-frames');
    expect(lastCall().headers['If-None-Match']).toBeUndefined();
    lastCall().respond(ok('"f1"', { frames: [], userTurns: 0 }));
    await settle();

    setProps({ sessionId: 's1' });
    expect(lastCall().url).toBe('/api/providers/sessions/s1/work-frames');
    expect(lastCall().headers['If-None-Match']).toBeUndefined();
    lastCall().respond(ok('"e1"', { frames: [task(1, '甲')], userTurns: 1 }));
    await settle();
    expect(state().baseMessages).toHaveLength(2);

    // 切走后对方的响应还没回来就切回:手里的 ETag 仍是 s1 的,但基线已经清空,不能再拿它问
    setProps({ sessionId: 's2' });
    setProps({ sessionId: 's1' });
    await settle();
    expect(state().baseMessages).toEqual([]);
    expect(lastCall().url).toBe('/api/providers/sessions/s1/work-frames');
    expect(lastCall().headers['If-None-Match']).toBeUndefined();
    lastCall().respond(ok('"e1"', { frames: [task(1, '甲')], userTurns: 1 }));
    await settle();
    expect(state().baseMessages).toHaveLength(2);
  });

  it('被后发请求顶掉的响应不落地,它的 ETag 也不记', async () => {
    props = { sessionId: 's1', isProcessing: false };
    mount();
    net.calls[0].respond(ok('"e1"', { frames: [task(1, '甲')], userTurns: 1 }));
    await settle();

    state().refresh();
    const older = lastCall();
    state().refresh();
    const newer = lastCall();
    expect(older.headers['If-None-Match']).toBe('"e1"');
    expect(newer.headers['If-None-Match']).toBe('"e1"');

    newer.respond(ok('"e3"', { frames: [task(1, '甲'), task(2, '乙'), task(3, '丙')], userTurns: 1 }));
    await settle();
    older.respond(ok('"e2"', { frames: [task(1, '甲'), task(2, '乙')], userTurns: 1 }));
    await settle();
    expect(state().baseMessages).toHaveLength(4);

    state().refresh();
    expect(lastCall().headers['If-None-Match']).toBe('"e3"');
  });

  it('响应没带 ETag(比如跨域部署读不到这个头)就照旧整份重取', async () => {
    props = { sessionId: 's1', isProcessing: false };
    mount();
    net.calls[0].respond(ok(null, { frames: [task(1, '甲')], userTurns: 1 }));
    await settle();
    state().refresh();
    expect(lastCall().headers['If-None-Match']).toBeUndefined();
  });
});
