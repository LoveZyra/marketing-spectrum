/**
 * 编辑器多标签:关标签时落到哪一个,以及 setState 的 updater 必须是纯函数。
 *
 * updater 里再调别的 setState 是副作用:严格模式下 React 会把 updater 调两次,
 * 并发渲染时还可能丢弃重来。这里的运行时在调用 updater 时把它跑两遍,并记下
 * updater 执行期间发生的任何 setState。
 *
 * vitest 这边没有 jsdom,这里用一个只驱动单个自定义 hook 的最小 hooks 运行时替掉 react,
 * 直接跑真实的 useEditorSidebar。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => {
  type Slot = { value?: unknown; setter?: (next: unknown) => void; current?: unknown; fn?: unknown; deps?: unknown[] | null; cleanup?: (() => void) | void };
  let slots: Slot[] = [];
  let cursor = 0;
  let pendingEffects: Array<() => void> = [];
  let hookFn: ((props: unknown) => unknown) | null = null;
  let hookProps: unknown = null;
  let result: unknown = null;
  let insideUpdater = false;
  const violations: string[] = [];
  const depsEqual = (a?: unknown[] | null, b?: unknown[] | null) =>
    !!a && !!b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
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
          if (insideUpdater) violations.push(`setState #${index} 在别的 updater 里被调用`);
          let value = next;
          if (typeof next === 'function') {
            const updater = next as (prev: unknown) => unknown;
            insideUpdater = true;
            try {
              const first = updater(slot.value);
              const second = updater(slot.value);
              if (JSON.stringify(first) !== JSON.stringify(second)) violations.push(`updater #${index} 两次结果不同`);
              value = first;
            } finally {
              insideUpdater = false;
            }
          }
          slot.value = value;
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
        slot.cleanup = effect();
      });
    },
  };
  return {
    react,
    render,
    /** 每次动作之后重渲染一次,拿到最新的回调与状态(相当于 React 处理完一次点击)。 */
    rerender: () => render(),
    violations,
    reset() {
      slots = [];
      cursor = 0;
      pendingEffects = [];
      hookFn = null;
      hookProps = null;
      result = null;
      insideUpdater = false;
      violations.length = 0;
    },
  };
});

vi.mock('react', () => harness.react);
vi.mock('react-i18next', () => {
  const t = (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? _key;
  return { useTranslation: () => ({ t }) };
});
vi.mock('../utils/editorDirtyState', () => ({ confirmDiscardEditorChanges: () => true }));

type Sidebar = {
  openFiles: Array<{ path: string }>;
  activeEditorPath: string | null;
  editorExpanded: boolean;
  handleFileOpen: (path: string) => void;
  handleCloseFile: (path?: string) => void;
  handleSelectFile: (path: string) => void;
  handleToggleEditorExpand: () => void;
};

let sidebar: () => Sidebar;

/** 做一个动作,然后像 React 处理完这次点击那样重渲染。 */
const act = (action: (current: Sidebar) => void) => {
  action(sidebar());
  harness.rerender();
};

beforeEach(async () => {
  harness.reset();
  const { useEditorSidebar } = await import('./useEditorSidebar');
  harness.render(() => useEditorSidebar({ selectedProject: null, isMobile: false }));
  sidebar = () => harness.rerender() as Sidebar;
});

const paths = () => sidebar().openFiles.map((file) => file.path);
const open = (...files: string[]) => files.forEach((file) => act((s) => s.handleFileOpen(file)));

describe('useEditorSidebar 关标签', () => {
  it('关当前标签:落到左边那个', () => {
    open('a.ts', 'b.ts', 'c.ts');
    act((s) => s.handleCloseFile());
    expect(paths()).toEqual(['a.ts', 'b.ts']);
    expect(sidebar().activeEditorPath).toBe('b.ts');
  });

  it('关中间的当前标签:落到左边;关最左边的当前标签:落到右边', () => {
    open('a.ts', 'b.ts', 'c.ts');
    act((s) => s.handleSelectFile('b.ts'));
    act((s) => s.handleCloseFile('b.ts'));
    expect(sidebar().activeEditorPath).toBe('a.ts');
    act((s) => s.handleCloseFile('a.ts'));
    expect(paths()).toEqual(['c.ts']);
    expect(sidebar().activeEditorPath).toBe('c.ts');
  });

  it('关后台标签:当前标签不变', () => {
    open('a.ts', 'b.ts');
    act((s) => s.handleCloseFile('a.ts'));
    expect(paths()).toEqual(['b.ts']);
    expect(sidebar().activeEditorPath).toBe('b.ts');
  });

  it('关光了:没有当前标签,展开态收起', () => {
    open('a.ts');
    act((s) => s.handleToggleEditorExpand());
    expect(sidebar().editorExpanded).toBe(true);
    act((s) => s.handleCloseFile());
    expect(paths()).toEqual([]);
    expect(sidebar().activeEditorPath).toBeNull();
    expect(sidebar().editorExpanded).toBe(false);
  });

  it('关一个不存在的路径:什么都不动', () => {
    open('a.ts');
    act((s) => s.handleCloseFile('nope.ts'));
    expect(paths()).toEqual(['a.ts']);
    expect(sidebar().activeEditorPath).toBe('a.ts');
  });

  it('所有 updater 都是纯函数:执行期间不调别的 setState,调两次结果一样', () => {
    open('a.ts', 'b.ts', 'c.ts');
    act((s) => s.handleSelectFile('b.ts'));
    act((s) => s.handleCloseFile('b.ts'));
    act((s) => s.handleCloseFile());
    act((s) => s.handleCloseFile());
    expect(harness.violations).toEqual([]);
  });
});
