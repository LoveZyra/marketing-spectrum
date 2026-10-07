/**
 * 「+」菜单的键盘行为:打开时焦点进第一项,方向键在项间移动(两头回绕),Esc / Tab 关闭并把焦点
 * 还给「+」,选中一项时焦点先回到「+」再执行。
 *
 * vitest 这边没有 jsdom,也不为这一个组件引入它:这里用最小 hooks 运行时替掉 react
 * (做法同 shell/hooks/shellConnectionLifecycle.test.ts),组件函数直接调用,返回的元素树里
 * 带 ref 的节点挂上假的 DOM 节点(只实现 focus / querySelectorAll / getBoundingClientRect),
 * 再按元素树上的 onClick / onKeyDown 与 window 上登记的 keydown 监听驱动。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => {
  type Slot = { value?: unknown; setter?: (next: unknown) => void; current?: unknown; fn?: unknown; deps?: unknown[] | null; cleanup?: (() => void) | void };
  let slots: Slot[] = [];
  let cursor = 0;
  let pendingEffects: Array<() => void> = [];
  let dirty = false;

  const depsEqual = (a?: unknown[] | null, b?: unknown[] | null) =>
    !!a && !!b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));

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
            dirty = true;
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

  let component: ((props: unknown) => unknown) | null = null;
  let componentProps: unknown = null;
  let tree: unknown = null;
  let commit: (tree: unknown) => void = () => {};

  /** 渲染一次:先像 React 提交那样挂好 ref,再跑 effect;状态变了就再来一遍,直到稳定。 */
  function flush() {
    for (let round = 0; round < 10; round += 1) {
      dirty = false;
      cursor = 0;
      tree = component!(componentProps);
      commit(tree);
      const run = pendingEffects;
      pendingEffects = [];
      run.forEach((effect) => effect());
      if (!dirty) return;
    }
    throw new Error('渲染没有稳定下来');
  }

  return {
    react,
    mount(fn: (props: unknown) => unknown, props: unknown, onCommit: (tree: unknown) => void) {
      component = fn;
      componentProps = props;
      commit = onCommit;
      flush();
    },
    flush,
    tree: () => tree,
    reset() {
      slots.forEach((slot) => {
        if (slot && typeof slot.cleanup === 'function') slot.cleanup();
      });
      slots = [];
      cursor = 0;
      pendingEffects = [];
      dirty = false;
      component = null;
      tree = null;
    },
  };
});

vi.mock('react', () => harness.react);
vi.mock('lucide-react', () => ({ Plus: () => null }));
vi.mock('../../../../shared/view/ui', () => ({ Button: function Button() { return null; } }));

const { default: ComposerPlusMenu } = await import('./ComposerPlusMenu');

type Element = { $$typeof?: symbol; type?: unknown; ref?: { current: unknown } | null; props?: Record<string, unknown> };

const ELEMENT = Symbol.for('react.element');
const PORTAL = Symbol.for('react.portal');

function walk(node: unknown, visit: (element: Element) => void): void {
  if (node == null || typeof node === 'boolean') return;
  if (Array.isArray(node)) {
    node.forEach((child) => walk(child, visit));
    return;
  }
  if (typeof node !== 'object') return;
  const element = node as Element & { children?: unknown };
  if (element.$$typeof === PORTAL) {
    walk(element.children, visit);
    return;
  }
  if (element.$$typeof === ELEMENT) {
    visit(element);
    walk(element.props?.children, visit);
  }
}

const find = (predicate: (element: Element) => boolean): Element | null => {
  let found: Element | null = null;
  walk(harness.tree(), (element) => {
    if (!found && predicate(element)) found = element;
  });
  return found;
};

const menuElement = () => find((element) => element.props?.role === 'menu');
const menuItemElements = () => {
  const items: Element[] = [];
  walk(harness.tree(), (element) => {
    if (element.props?.role === 'menuitem') items.push(element);
  });
  return items;
};

/** 假的 DOM:焦点、portal 容器、window 上的监听。 */
class FakeNode {
  constructor(readonly name: string) {}
  focus() { fakeDocument.activeElement = this; }
  contains(other: unknown) { return other === this; }
  getBoundingClientRect() { return { left: 24, top: 600, width: 32, height: 32 }; }
}

const fakeDocument = {
  activeElement: null as FakeNode | null,
  body: { nodeType: 1 },
  addEventListener: () => {},
  removeEventListener: () => {},
};
const windowListeners = new Map<string, Set<(event: unknown) => void>>();
const fakeWindow = {
  addEventListener: (type: string, listener: (event: unknown) => void) => {
    if (!windowListeners.has(type)) windowListeners.set(type, new Set());
    windowListeners.get(type)!.add(listener);
  },
  removeEventListener: (type: string, listener: (event: unknown) => void) => {
    windowListeners.get(type)?.delete(listener);
  },
};

const plusButton = new FakeNode('plus');
const itemNodes: FakeNode[] = [];
const fakeMenu = {
  contains: (other: unknown) => itemNodes.includes(other as FakeNode),
  querySelectorAll: () => itemNodes.slice(0, menuItemElements().length),
};

/** 像 React 提交那样把 ref 挂上:「+」按钮、菜单容器;菜单项的假节点按位置复用。 */
function commit(tree: unknown) {
  walk(tree, (element) => {
    if (!element.ref) return;
    if (element.props?.role === 'menu') element.ref.current = fakeMenu;
    else if (element.props?.['data-composer-plus']) element.ref.current = plusButton;
  });
  const count = menuItemElements().length;
  while (itemNodes.length < count) itemNodes.push(new FakeNode(`item${itemNodes.length}`));
}

const key = (name: string) => ({ key: name, preventDefault: vi.fn(), stopPropagation: vi.fn() });

const savedGlobals: Record<string, unknown> = {};
beforeEach(() => {
  const g = globalThis as Record<string, unknown>;
  for (const name of ['document', 'window']) savedGlobals[name] = g[name];
  g.document = fakeDocument;
  g.window = fakeWindow;
  fakeDocument.activeElement = null;
  windowListeners.clear();
  itemNodes.length = 0;
});
afterEach(() => {
  harness.reset();
  const g = globalThis as Record<string, unknown>;
  for (const [name, value] of Object.entries(savedGlobals)) {
    if (value === undefined) delete g[name];
    else g[name] = value;
  }
});

function mountMenu() {
  const selected: string[] = [];
  const items = ['attach', 'url', 'commands'].map((id) => ({
    id,
    icon: null,
    label: id,
    onSelect: () => { selected.push(`${id}:focus=${fakeDocument.activeElement?.name ?? 'none'}`); },
  }));
  harness.mount(ComposerPlusMenu as (props: unknown) => unknown, { items, label: '更多' }, commit);
  const open = () => {
    const button = find((element) => Boolean(element.props?.['data-composer-plus']));
    (button!.props!.onClick as () => void)();
    harness.flush();
  };
  const press = (name: string) => {
    const event = key(name);
    (menuElement()!.props!.onKeyDown as (event: unknown) => void)(event);
    harness.flush();
    return event;
  };
  return { open, press, selected };
}

describe('「+」菜单的键盘行为', () => {
  it('打开时焦点移到第一项', () => {
    const menu = mountMenu();
    expect(menuElement()).toBeNull();
    menu.open();
    expect(menuElement()).not.toBeNull();
    expect(menuElement()!.props!['aria-label']).toBe('更多');
    // 菜单项不进 Tab 序列,焦点由方向键管
    expect(menuItemElements().map((element) => element.props!.tabIndex)).toEqual([-1, -1, -1]);
    expect(fakeDocument.activeElement?.name).toBe('item0');
  });

  it('上下键在项间移动,两头回绕;Home / End 到首尾', () => {
    const menu = mountMenu();
    menu.open();
    expect(menu.press('ArrowUp').preventDefault).toHaveBeenCalled();
    expect(fakeDocument.activeElement?.name).toBe('item2');
    menu.press('ArrowDown');
    expect(fakeDocument.activeElement?.name).toBe('item0');
    menu.press('ArrowDown');
    expect(fakeDocument.activeElement?.name).toBe('item1');
    menu.press('End');
    expect(fakeDocument.activeElement?.name).toBe('item2');
    menu.press('Home');
    expect(fakeDocument.activeElement?.name).toBe('item0');
    // 别的键不动焦点,也不拦默认行为
    expect(menu.press('a').preventDefault).not.toHaveBeenCalled();
    expect(fakeDocument.activeElement?.name).toBe('item0');
  });

  it('Tab 关闭菜单,焦点还给「+」', () => {
    const menu = mountMenu();
    menu.open();
    menu.press('ArrowDown');
    menu.press('Tab');
    expect(menuElement()).toBeNull();
    expect(fakeDocument.activeElement).toBe(plusButton);
  });

  it('Esc 关闭菜单,焦点还给「+」(监听挂在 window 上,菜单关掉后摘除)', () => {
    const menu = mountMenu();
    menu.open();
    const listeners = [...(windowListeners.get('keydown') ?? [])];
    expect(listeners).toHaveLength(1);
    const escape = key('Escape');
    listeners[0](escape);
    harness.flush();
    expect(escape.preventDefault).toHaveBeenCalled();
    expect(menuElement()).toBeNull();
    expect(fakeDocument.activeElement).toBe(plusButton);
    expect(windowListeners.get('keydown')?.size ?? 0).toBe(0);
  });

  it('选中一项:先关菜单、焦点回到「+」,再执行那一项', () => {
    const menu = mountMenu();
    menu.open();
    menu.press('ArrowDown');
    (menuItemElements()[1].props!.onClick as () => void)();
    harness.flush();
    expect(menu.selected).toEqual(['url:focus=plus']);
    expect(menuElement()).toBeNull();
  });
});
