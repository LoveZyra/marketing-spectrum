/**
 * 技能优化作业列表:迟到的旧响应不能盖掉当前列表。
 *
 * - 换了技能:上一个技能的请求后回来,不能把它的作业显示在新技能下;
 * - 轮询与手动刷新交错:旧响应后到时不能把列表退回去(退成没有活作业时轮询还会就此停下);
 * - 请求比轮询间隔还慢时,每次响应仍要能落地,不能都被下一次请求作废。
 *
 * vitest 这边没有 jsdom,这里用一个只驱动单个自定义 hook 的最小 hooks 运行时替掉 react,
 * 直接跑真实的 useJobs。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => {
  type Slot = { value?: unknown; setter?: (next: unknown) => void; current?: unknown; fn?: unknown; deps?: unknown[] | null; cleanup?: (() => void) | void };
  let slots: Slot[] = [];
  let cursor = 0;
  let pendingEffects: Array<() => void> = [];
  let hookFn: ((props: unknown) => unknown) | null = null;
  let hookProps: unknown = null;
  let result: unknown = null;
  let scheduled = false;
  const depsEqual = (a?: unknown[] | null, b?: unknown[] | null) =>
    !!a && !!b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (hookFn) render();
    });
  };
  function render(fn?: (props: unknown) => unknown, props?: unknown) {
    if (fn) {
      hookFn = fn;
      hookProps = props;
    }
    cursor = 0;
    result = hookFn!(hookProps);
    const run = pendingEffects;
    pendingEffects = [];
    run.forEach((effect) => effect());
    return result;
  }
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
      if (slot && depsEqual(slot.deps, deps)) return slot.fn;
      slots[index] = { fn, deps };
      return fn;
    },
    useEffect(effect: () => (() => void) | void, deps?: unknown[]) {
      const index = cursor++;
      const slot = slots[index] || (slots[index] = { deps: null });
      if (slot.deps && depsEqual(slot.deps, deps)) return;
      slot.deps = deps ?? null;
      pendingEffects.push(() => {
        if (typeof slot.cleanup === 'function') slot.cleanup();
        slot.cleanup = effect();
      });
    },
  };
  return {
    react,
    render,
    current: () => result,
    reset() {
      slots = [];
      cursor = 0;
      pendingEffects = [];
      hookFn = null;
      hookProps = null;
      result = null;
      scheduled = false;
    },
  };
});

type Deferred = { skill: string | null; resolve: (jobs: unknown[]) => void; reject: (status: number) => void };
const server = vi.hoisted(() => ({ pending: [] as Deferred[] }));

vi.mock('react', () => harness.react);
vi.mock('../../../utils/api', () => ({
  api: {
    skillWhet: {
      jobs: (skill: string | null) => new Promise((resolve) => {
        server.pending.push({
          skill,
          resolve: (jobs) => resolve({ ok: true, status: 200, json: async () => ({ jobs }) }),
          reject: (status) => resolve({ ok: false, status, json: async () => ({ error: `HTTP ${status}` }) }),
        });
      }),
    },
  },
}));

const savedWindow = (globalThis as Record<string, unknown>).window;
beforeAll(() => {
  // 有活作业时 useJobs 会挂 3 秒轮询;这里不靠定时器推进,只给个空壳。
  (globalThis as Record<string, unknown>).window = { setInterval: () => 1, clearInterval: () => {} };
});
afterAll(() => {
  if (savedWindow === undefined) delete (globalThis as Record<string, unknown>).window;
  else (globalThis as Record<string, unknown>).window = savedWindow;
});

type Hook = { jobs: Array<{ id: string; state: string }>; loading: boolean; error: string | null; refresh: () => Promise<void> };
const hook = () => harness.current() as Hook;
const job = (id: string, state = 'done') => ({ id, state });
/** 让响应链(fetch → json → setState → 重渲染)走完。 */
const settle = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

async function mount(skill: string | null) {
  const { useJobs } = await import('./useJobs');
  harness.render((props) => useJobs((props as { skill: string | null }).skill), { skill });
  return (next: string | null) => harness.render((props) => useJobs((props as { skill: string | null }).skill), { skill: next });
}

beforeEach(() => {
  harness.reset();
  server.pending.length = 0;
});

describe('useJobs 请求代号', () => {
  it('换了技能:上一个技能的响应后到,不显示在新技能下', async () => {
    const rerender = await mount('alpha');
    expect(server.pending.map((p) => p.skill)).toEqual(['alpha']);

    rerender('beta');
    expect(server.pending.map((p) => p.skill)).toEqual(['alpha', 'beta']);

    server.pending[0].resolve([job('job_alpha')]);
    await settle();
    expect(hook().jobs).toEqual([]);
    expect(hook().loading).toBe(true);

    server.pending[1].resolve([job('job_beta')]);
    await settle();
    expect(hook().jobs).toEqual([job('job_beta')]);
    expect(hook().loading).toBe(false);
  });

  it('换了技能:旧列表立刻清掉,不等新响应', async () => {
    const rerender = await mount('alpha');
    server.pending[0].resolve([job('job_alpha')]);
    await settle();
    expect(hook().jobs).toEqual([job('job_alpha')]);

    rerender('beta');
    await settle();
    expect(hook().jobs).toEqual([]);
    expect(hook().loading).toBe(true);
  });

  it('换了技能:上一个技能的请求失败也不把错误挂到新技能下', async () => {
    const rerender = await mount('alpha');
    rerender('beta');
    server.pending[0].reject(502);
    await settle();
    expect(hook().error).toBeNull();
  });

  it('轮询与手动刷新交错:旧响应后到时不把列表退回去', async () => {
    await mount(null);
    server.pending[0].resolve([job('job_1', 'running')]);
    await settle();

    void hook().refresh();            // 轮询发出去,还没回来
    void hook().refresh();            // 刚建了新作业,手动刷新
    server.pending[2].resolve([job('job_2', 'queued'), job('job_1', 'running')]);
    await settle();
    server.pending[1].resolve([job('job_1', 'done')]);
    await settle();

    expect(hook().jobs).toEqual([job('job_2', 'queued'), job('job_1', 'running')]);
  });

  it('请求比轮询间隔还慢:先发的先回,每次响应照样落地', async () => {
    await mount(null);
    server.pending[0].resolve([job('job_1', 'running')]);
    await settle();

    void hook().refresh();
    void hook().refresh();
    server.pending[1].resolve([job('job_1', 'running'), job('job_2', 'queued')]);
    await settle();
    expect(hook().jobs).toEqual([job('job_1', 'running'), job('job_2', 'queued')]);

    server.pending[2].resolve([job('job_1', 'done'), job('job_2', 'running')]);
    await settle();
    expect(hook().jobs).toEqual([job('job_1', 'done'), job('job_2', 'running')]);
  });
});
