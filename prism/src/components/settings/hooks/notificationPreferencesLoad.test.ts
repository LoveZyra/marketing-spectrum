/**
 * 通知偏好没从服务端读到时,不能拿默认值顶上去再写回服务端。
 *
 * 读失败后界面上是默认值;要是把它记成「已加载」基线,用户随后改任意一项设置(权限、排序),
 * 自动保存就会把默认通知偏好整份 PUT 回去,覆盖服务端已存的偏好。
 *
 * vitest 这边没有 jsdom,这里用一个只驱动单个自定义 hook 的最小 hooks 运行时替掉 react,
 * 直接跑真实的 useSettingsController。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => {
  type Slot = { value?: unknown; setter?: (next: unknown) => void; current?: unknown; fn?: unknown; deps?: unknown[] | null; cleanup?: (() => void) | void };
  let slots: Slot[] = [];
  let cursor = 0;
  let pendingEffects: Array<() => void> = [];
  let hookFn: ((props: unknown) => unknown) | null = null;
  let hookProps: unknown = null;
  let result: unknown = null;
  let scheduled = false;
  let unmounted = false;
  const depsEqual = (a?: unknown[] | null, b?: unknown[] | null) =>
    !!a && !!b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const schedule = () => {
    if (scheduled || unmounted) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (!unmounted && hookFn) render();
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
    unmount() {
      unmounted = true;
      slots.forEach((slot) => {
        if (slot && typeof slot.cleanup === 'function') slot.cleanup();
      });
    },
    reset() {
      slots = [];
      cursor = 0;
      pendingEffects = [];
      hookFn = null;
      hookProps = null;
      result = null;
      scheduled = false;
      unmounted = false;
    },
  };
});

const server = vi.hoisted(() => ({
  /** GET 依次取用的响应;取空了就当服务端正常返回 stored。 */
  getQueue: [] as Array<() => Promise<unknown>>,
  stored: null as unknown,
  puts: [] as unknown[],
  soundWrites: [] as boolean[],
}));

vi.mock('react', () => harness.react);
vi.mock('../constants/constants', () => ({
  DEFAULT_CODE_EDITOR_SETTINGS: { wordWrap: false, showMinimap: true, lineNumbers: true, fontSize: '14' },
  SETTINGS_MAIN_TAB_IDS: ['agents', 'notifications'],
}));
vi.mock('../../../utils/accountSettings', () => ({ pushAccountSettings: async () => {} }));
vi.mock('../../../utils/notificationSound', () => ({
  setNotificationSoundEnabled: (enabled: boolean) => server.soundWrites.push(enabled),
}));
vi.mock('../../provider-auth/hooks/useProviderAuthStatus', () => {
  const stable = {
    providerAuthStatus: {},
    checkProviderAuthStatus: async () => ({ authenticated: true }),
    refreshProviderAuthStatuses: async () => {},
  };
  return { useProviderAuthStatus: () => stable };
});
vi.mock('../../../utils/api', () => ({
  authenticatedFetch: async (url: string, init?: { method?: string; body?: string }) => {
    if (url !== '/api/settings/notification-preferences') throw new Error(`unexpected ${url}`);
    if (init?.method === 'PUT') {
      const body = JSON.parse(String(init.body));
      server.puts.push(body);
      server.stored = body;
      return { ok: true, status: 200, json: async () => ({ success: true, preferences: body }) };
    }
    const next = server.getQueue.shift();
    if (next) return next();
    return { ok: true, status: 200, json: async () => ({ success: true, preferences: server.stored }) };
  },
}));

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string) { return this.map.get(key) ?? null; }
  setItem(key: string, value: string) { this.map.set(key, String(value)); }
  removeItem(key: string) { this.map.delete(key); }
  clear() { this.map.clear(); }
}
const storage = new MemoryStorage();

const savedGlobals: Record<string, unknown> = {};
beforeAll(() => {
  const g = globalThis as Record<string, unknown>;
  for (const key of ['window', 'localStorage']) savedGlobals[key] = g[key];
  g.localStorage = storage;
  g.window = {
    localStorage: storage,
    setTimeout: (...args: Parameters<typeof setTimeout>) => globalThis.setTimeout(...args),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(id),
    dispatchEvent: () => true,
  };
});
afterAll(() => {
  const g = globalThis as Record<string, unknown>;
  for (const [key, value] of Object.entries(savedGlobals)) {
    if (value === undefined) delete g[key];
    else g[key] = value;
  }
});

/** 服务端存着的偏好:用户关了声音、开了桌面通知、不要「已停止」提醒。 */
const userPrefs = {
  channels: { inApp: true, webPush: false, desktop: true, sound: false },
  events: { actionRequired: true, stop: false, error: true },
};

const failWith502 = () => async () => ({ ok: false, status: 502, json: async () => { throw new Error('html'); } });

type Controller = {
  notificationPreferences: typeof userPrefs;
  setNotificationPreferences: (value: typeof userPrefs) => void;
  setClaudePermissions: (value: { allowedTools: string[]; disallowedTools: string[]; skipPermissions: boolean }) => void;
  notificationPreferencesLoadFailed?: boolean;
  retryNotificationPreferences?: () => Promise<void>;
};
const controller = () => harness.current() as Controller;

async function open() {
  const { useSettingsController } = await import('./useSettingsController');
  harness.render(useSettingsController as (p: unknown) => unknown, { isOpen: true, initialTab: 'notifications' });
  await vi.advanceTimersByTimeAsync(10);
}

beforeEach(() => {
  vi.useFakeTimers();
  harness.reset();
  storage.clear();
  server.getQueue.length = 0;
  server.stored = userPrefs;
  server.puts.length = 0;
  server.soundWrites.length = 0;
});
afterEach(async () => {
  harness.unmount();
  await vi.runOnlyPendingTimersAsync();
  vi.useRealTimers();
});

describe('通知偏好 · 加载失败', () => {
  it('加载失败后改了别的设置:自动保存不提交通知偏好,本机的权限照常保存', async () => {
    server.getQueue.push(failWith502());
    await open();

    controller().setClaudePermissions({ allowedTools: ['Bash(ls:*)'], disallowedTools: [], skipPermissions: false });
    await vi.advanceTimersByTimeAsync(600);

    expect(server.puts, '默认通知偏好被写回了服务端').toEqual([]);
    expect(JSON.parse(storage.getItem('claude-settings') ?? '{}').allowedTools).toEqual(['Bash(ls:*)']);
  });

  it('响应不是 JSON、请求抛错,同样算加载失败', async () => {
    server.getQueue.push(async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } }));
    await open();
    expect(controller().notificationPreferencesLoadFailed).toBe(true);

    harness.unmount();
    harness.reset();
    server.getQueue.push(async () => { throw new TypeError('Failed to fetch'); });
    await open();
    expect(controller().notificationPreferencesLoadFailed).toBe(true);
  });

  it('加载失败时打出标记,界面据此禁用开关', async () => {
    server.getQueue.push(failWith502());
    await open();
    expect(controller().notificationPreferencesLoadFailed).toBe(true);
  });

  it('加载失败时不拿默认值去改本机的提示音开关', async () => {
    server.getQueue.push(failWith502());
    await open();
    expect(server.soundWrites).toEqual([]);
  });

  it('重试成功:换上服务端的值、清掉标记,重试本身不触发保存', async () => {
    server.getQueue.push(failWith502());
    await open();

    await controller().retryNotificationPreferences!();
    await vi.advanceTimersByTimeAsync(600);

    expect(controller().notificationPreferencesLoadFailed).toBe(false);
    expect(controller().notificationPreferences).toEqual(userPrefs);
    expect(server.puts).toEqual([]);
    expect(server.soundWrites.at(-1)).toBe(false);
  });

  it('重试成功后再改通知开关:提交的是服务端的值加上这次改动', async () => {
    server.getQueue.push(failWith502());
    await open();
    await controller().retryNotificationPreferences!();
    await vi.advanceTimersByTimeAsync(10);

    const prefs = controller().notificationPreferences;
    controller().setNotificationPreferences({ ...prefs, events: { ...prefs.events, error: false } });
    await vi.advanceTimersByTimeAsync(600);

    expect(server.puts).toEqual([{ ...userPrefs, events: { ...userPrefs.events, error: false } }]);
  });

  it('重试仍失败:标记保持', async () => {
    server.getQueue.push(failWith502(), failWith502());
    await open();
    await controller().retryNotificationPreferences!();
    await vi.advanceTimersByTimeAsync(10);
    expect(controller().notificationPreferencesLoadFailed).toBe(true);
  });
});

describe('通知偏好 · 加载成功(原有行为)', () => {
  it('只打开不改:不写任何东西', async () => {
    await open();
    await vi.advanceTimersByTimeAsync(600);
    expect(controller().notificationPreferencesLoadFailed).toBe(false);
    expect(controller().notificationPreferences).toEqual(userPrefs);
    expect(server.puts).toEqual([]);
  });

  it('改了权限:连同读到的通知偏好一起保存(值不变)', async () => {
    await open();
    controller().setClaudePermissions({ allowedTools: ['Read'], disallowedTools: [], skipPermissions: false });
    await vi.advanceTimersByTimeAsync(600);
    expect(server.puts).toEqual([userPrefs]);
  });
});
