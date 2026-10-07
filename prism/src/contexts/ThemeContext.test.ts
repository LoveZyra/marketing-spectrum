/**
 * 主题:没手动选过时跟随系统,选过之后不再干预;上一次选的浅色刷新后还在。
 *
 * 只有用户动作(选主题、命令面板切深浅)才写 `prism-ui-theme`。挂载时就把按系统解析出来的主题
 * 写进去的话,「没选过」这个状态第一屏之后就不存在了,跟随系统永远不生效。
 *
 * vitest 这边没有 jsdom,这里用一个只驱动单个组件函数的最小 hooks 运行时替掉 react,
 * Provider 渲染出来的元素里直接取 context 的 value。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => {
  type Slot = { value?: unknown; setter?: (next: unknown) => void; fn?: unknown; deps?: unknown[] | null; cleanup?: (() => void) | void };
  let slots: Slot[] = [];
  let cursor = 0;
  let pendingEffects: Array<() => void> = [];
  let component: ((props: unknown) => unknown) | null = null;
  let componentProps: unknown = null;
  let output: unknown = null;
  let scheduled = false;
  const depsEqual = (a?: unknown[] | null, b?: unknown[] | null) =>
    !!a && !!b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (component) render();
    });
  };
  function render(fn?: (props: unknown) => unknown, props?: unknown) {
    if (fn) {
      component = fn;
      componentProps = props;
    }
    cursor = 0;
    output = component!(componentProps);
    const run = pendingEffects;
    pendingEffects = [];
    run.forEach((effect) => effect());
    return output;
  }
  const react = {
    createContext: (defaultValue: unknown) => ({ Provider: 'Provider', defaultValue }),
    useContext: () => null,
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
    useCallback(fn: unknown, deps: unknown[]) {
      const index = cursor++;
      const slot = slots[index];
      if (slot && depsEqual(slot.deps, deps)) return slot.fn;
      slots[index] = { fn, deps };
      return fn;
    },
    useMemo(factory: () => unknown, deps: unknown[]) {
      const index = cursor++;
      const slot = slots[index];
      if (slot && depsEqual(slot.deps, deps)) return slot.value;
      const value = factory();
      slots[index] = { value, deps };
      return value;
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
  const jsx = (type: unknown, props: unknown) => ({ type, props });
  return {
    react: { ...react, default: react },
    jsxRuntime: { jsx, jsxs: jsx, jsxDEV: jsx, Fragment: 'Fragment' },
    render,
    output: () => output,
    unmount() {
      component = null;
      slots.forEach((slot) => {
        if (slot && typeof slot.cleanup === 'function') slot.cleanup();
      });
      slots = [];
      cursor = 0;
      pendingEffects = [];
      scheduled = false;
    },
  };
});

vi.mock('react', () => harness.react);
vi.mock('react/jsx-runtime', () => harness.jsxRuntime);
vi.mock('react/jsx-dev-runtime', () => harness.jsxRuntime);

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string) { return this.map.get(key) ?? null; }
  setItem(key: string, value: string) { this.map.set(key, String(value)); }
  removeItem(key: string) { this.map.delete(key); }
  clear() { this.map.clear(); }
}
const storage = new MemoryStorage();

/** 可以手动翻转的系统深浅色。 */
const system = {
  dark: false,
  listeners: new Set<(event: { matches: boolean }) => void>(),
  flip(dark: boolean) {
    this.dark = dark;
    this.listeners.forEach((listener) => listener({ matches: dark }));
  },
};

const root = {
  classes: new Set<string>(),
  dataset: {} as Record<string, string>,
  classList: {
    toggle: (name: string, on: boolean) => {
      if (on) root.classes.add(name);
      else root.classes.delete(name);
    },
  },
};

const savedGlobals: Record<string, unknown> = {};
beforeAll(() => {
  const g = globalThis as Record<string, unknown>;
  for (const key of ['window', 'document', 'localStorage']) savedGlobals[key] = g[key];
  g.localStorage = storage;
  g.window = {
    localStorage: storage,
    matchMedia: () => ({
      get matches() { return system.dark; },
      addEventListener: (_: string, listener: (event: { matches: boolean }) => void) => system.listeners.add(listener),
      removeEventListener: (_: string, listener: (event: { matches: boolean }) => void) => system.listeners.delete(listener),
    }),
  };
  g.document = { documentElement: root, querySelector: () => null };
});
afterAll(() => {
  const g = globalThis as Record<string, unknown>;
  for (const [key, value] of Object.entries(savedGlobals)) {
    if (value === undefined) delete g[key];
    else g[key] = value;
  }
});

type ThemeValue = {
  uiTheme: string;
  setUiTheme: (theme: string) => void;
  isDarkMode: boolean;
  toggleDarkMode: () => void;
};

const flush = async () => {
  for (let i = 0; i < 3; i += 1) await Promise.resolve();
};

async function mount(): Promise<() => ThemeValue> {
  const { ThemeProvider } = await import('./ThemeContext');
  harness.render(ThemeProvider as (props: unknown) => unknown, { children: null });
  await flush();
  return () => (harness.output() as { props: { value: ThemeValue } }).props.value;
}

beforeEach(() => {
  harness.unmount();
  storage.clear();
  system.dark = false;
  system.listeners.clear();
  root.classes.clear();
  root.dataset = {};
});

describe('主题 · 没手动选过', () => {
  it('首屏按系统解析,但不写进存储', async () => {
    system.dark = true;
    const theme = await mount();
    expect(theme().uiTheme).toBe('dark');
    expect(root.classes.has('dark')).toBe(true);
    expect(storage.getItem('prism-ui-theme')).toBeNull();
  });

  it('同一页面里系统切深 / 浅色:跟着变', async () => {
    const theme = await mount();
    expect(theme().uiTheme).toBe('blueprint');

    system.flip(true);
    await flush();
    expect(theme().uiTheme).toBe('dark');

    system.flip(false);
    await flush();
    expect(theme().uiTheme).toBe('blueprint');
  });

  it('刷新后仍按当时的系统解析', async () => {
    await mount();
    harness.unmount();
    system.dark = true;
    const theme = await mount();
    expect(theme().uiTheme).toBe('dark');
  });
});

describe('主题 · 选过之后', () => {
  it('选了主题就记下来,系统再变也不干预', async () => {
    const theme = await mount();
    theme().setUiTheme('glass');
    await flush();
    expect(storage.getItem('prism-ui-theme')).toBe('glass');

    system.flip(true);
    await flush();
    expect(theme().uiTheme).toBe('glass');
  });

  it('命令面板切深浅也算选过', async () => {
    const theme = await mount();
    theme().toggleDarkMode();
    await flush();
    expect(theme().uiTheme).toBe('dark');
    expect(storage.getItem('prism-ui-theme')).toBe('dark');

    system.flip(false);
    await flush();
    expect(theme().uiTheme).toBe('dark');
  });

  it('旧的深浅开关键也算选过', async () => {
    storage.setItem('theme', 'dark');
    const theme = await mount();
    expect(theme().uiTheme).toBe('dark');
    system.flip(false);
    await flush();
    expect(theme().uiTheme).toBe('dark');
  });
});

describe('主题 · 上一次选的浅色', () => {
  it('选过棱光玻璃再切深色,刷新后用命令面板切回浅色仍是棱光玻璃', async () => {
    let theme = await mount();
    theme().setUiTheme('glass');
    await flush();
    theme().setUiTheme('dark');
    await flush();

    harness.unmount();
    theme = await mount();
    expect(theme().uiTheme).toBe('dark');
    theme().toggleDarkMode();
    await flush();
    expect(theme().uiTheme).toBe('glass');
    expect(storage.getItem('prism-ui-theme')).toBe('glass');
  });

  it('存的上一次浅色无效时回落到纸构蓝图', async () => {
    storage.setItem('prism-ui-theme', 'dark');
    storage.setItem('prism-ui-theme-last-light', 'neon');
    const theme = await mount();
    theme().toggleDarkMode();
    await flush();
    expect(theme().uiTheme).toBe('blueprint');
  });
});
