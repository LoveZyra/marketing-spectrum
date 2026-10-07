/**
 * 终端连接:旧 socket 的回调、作废的取票,都不能动下一次连接。
 *
 * 断开(切会话、接管、重启)时旧 socket 只是开始关闭握手,onclose 要一个往返之后才到;
 * 那时自动连接往往已经发起了下一次。旧回调要是还去复位「连接中」标志,自动连接就会
 * 再开一条,前一条成为没人持有的孤儿连接。取票同理:断开时还在路上的那张票回来后不能再开连接。
 *
 * vitest 这边没有 jsdom,这里用一个只驱动单个自定义 hook 的最小 hooks 运行时替掉 react,
 * 配一个假 WebSocket,把时序一步步推出来。useShellTerminal 换成桩(它要 xterm 和 DOM),
 * 桩把 closeSocket 记下来,用来模拟终端拆掉重建时的那次关闭。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => {
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

  const tickets: Array<(url: string | null) => void> = [];
  const terminal = {
    closeSocket: null as null | (() => void),
    written: [] as string[],
  };

  return {
    react,
    render,
    current: () => result,
    unmount() {
      unmounted = true;
      slots.forEach((slot) => {
        if (slot && typeof slot.cleanup === 'function') {
          slot.cleanup();
          slot.cleanup = undefined;
        }
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
      tickets.length = 0;
      terminal.closeSocket = null;
      terminal.written.length = 0;
    },
    tickets,
    terminal,
  };
});

vi.mock('react', () => harness.react);
vi.mock('../constants/constants', () => ({ TERMINAL_INIT_DELAY_MS: 0 }));
vi.mock('../../../utils/ws-auth', () => ({
  buildAuthenticatedWebSocketUrl: () => new Promise<string | null>((resolve) => harness.tickets.push(resolve)),
}));
vi.mock('./useShellTerminal', () => {
  const fakeTerminal = {
    cols: 80,
    rows: 24,
    write: (data: string) => harness.terminal.written.push(data),
    clear: () => {},
  };
  const fakeFitAddon = { fit: () => {} };
  const clearTerminalScreen = () => {};
  const disposeTerminal = () => {};
  return {
    useShellTerminal: (options: {
      terminalRef: { current: unknown };
      fitAddonRef: { current: unknown };
      closeSocket: () => void;
    }) => {
      options.terminalRef.current = fakeTerminal;
      options.fitAddonRef.current = fakeFitAddon;
      harness.terminal.closeSocket = options.closeSocket;
      return { isInitialized: true, clearTerminalScreen, disposeTerminal };
    },
  };
});

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static all: FakeWebSocket[] = [];

  url: string;
  readyState = FakeWebSocket.CONNECTING;
  closedByClient = false;
  sent: Array<{ type: string }> = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.all.push(this);
  }

  send(raw: string) {
    this.sent.push(JSON.parse(raw) as { type: string });
  }

  close() {
    this.closedByClient = true;
    if (this.readyState < FakeWebSocket.CLOSING) this.readyState = FakeWebSocket.CLOSING;
  }

  /** 服务端接受了升级。 */
  accept() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  /** 关闭握手完成(主动关的要等一个往返;服务端断开的立即到)。 */
  finishClose() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  receive(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

/** 等定时器(0ms)和随后的微任务重渲染都落地。 */
const settle = async () => {
  for (let i = 0; i < 4; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

const savedGlobals: Record<string, unknown> = {};
beforeAll(() => {
  const g = globalThis as Record<string, unknown>;
  for (const key of ['WebSocket', 'window', 'localStorage']) savedGlobals[key] = g[key];
  g.WebSocket = FakeWebSocket;
  g.window = globalThis;
  g.localStorage = { getItem: () => null };
});
afterAll(() => {
  const g = globalThis as Record<string, unknown>;
  for (const [key, value] of Object.entries(savedGlobals)) {
    if (value === undefined) delete g[key];
    else g[key] = value;
  }
});

type RuntimeResult = {
  wsRef: { current: FakeWebSocket | null };
  isConnected: boolean;
  isConnecting: boolean;
  connectToShell: (options?: { forceRestart?: boolean }) => void;
  disconnectFromShell: (options?: { suppressAutoConnect?: boolean }) => void;
  takeOverConversation: () => void;
};

const project = { name: 'p', path: '/p', fullPath: '/p' };
const baseProps = {
  selectedProject: project,
  selectedSession: null as null | { id: string },
  initialCommand: null,
  isPlainShell: true,
  minimal: false,
  autoConnect: true,
  isRestarting: false,
  onProcessComplete: null,
  terminalId: 't1',
};

const live = () => FakeWebSocket.all.filter((s) => s.readyState === FakeWebSocket.OPEN && !s.closedByClient);
const current = () => harness.current() as RuntimeResult;

async function mountConnected(props = baseProps) {
  const { useShellRuntime } = await import('./useShellRuntime');
  harness.render(useShellRuntime as (p: unknown) => unknown, props);
  await settle();
  expect(harness.tickets).toHaveLength(1);
  harness.tickets[0]('ws://x/1');
  await settle();
  FakeWebSocket.all[0].accept();
  await settle();
  expect(current().isConnected).toBe(true);
  return useShellRuntime as (p: unknown) => unknown;
}

beforeEach(() => {
  harness.reset();
  FakeWebSocket.all = [];
});

// 卸载会跑 effect 清理(含自动连接的定时器),免得上一条用例的重连落到下一条里。
afterEach(async () => {
  harness.unmount();
  await settle();
});

describe('终端连接 · 断开后旧 socket 晚到的回调', () => {
  it('切会话:旧 socket 的 onclose 晚到,不会让自动连接再开一条', async () => {
    const hook = await mountConnected();
    const old = FakeWebSocket.all[0];

    // 切会话 → disconnectFromShell → 自动连接立刻发起下一次(第二张票在路上)
    harness.render(hook, { ...baseProps, selectedSession: { id: 's2' } });
    await settle();
    expect(harness.tickets).toHaveLength(2);

    // 旧 socket 的关闭握手这时才完成
    old.finishClose();
    await settle();
    expect(harness.tickets, '旧 onclose 复位了「连接中」,自动连接又取了一张票').toHaveLength(2);

    harness.tickets.slice(1).forEach((resolve, i) => resolve(`ws://x/${i + 2}`));
    await settle();
    FakeWebSocket.all.slice(1).forEach((socket) => socket.accept());
    await settle();

    expect(FakeWebSocket.all).toHaveLength(2);
    expect(live()).toHaveLength(1);
    expect(current().wsRef.current).toBe(live()[0]);
    expect(current().isConnected).toBe(true);
  });

  it('接管对话:断开再连,同样只留一条连接', async () => {
    await mountConnected();
    const old = FakeWebSocket.all[0];

    current().takeOverConversation();
    await settle();
    old.finishClose();
    await settle();

    harness.tickets.slice(1).forEach((resolve, i) => resolve(`ws://x/${i + 2}`));
    await settle();
    FakeWebSocket.all.slice(1).forEach((socket) => socket.accept());
    await settle();

    expect(harness.tickets).toHaveLength(2);
    expect(live()).toHaveLength(1);
    expect(current().wsRef.current).toBe(live()[0]);
    // 只有新连接发了 init,而且带着接管标志
    const inits = FakeWebSocket.all.map((s) => s.sent.filter((m) => m.type === 'init'));
    expect(inits[0]).toHaveLength(1);
    expect(inits[1]).toEqual([expect.objectContaining({ type: 'init', takeover: true })]);
  });

  it('旧 socket 关闭前收到的输出不再写进终端', async () => {
    const hook = await mountConnected();
    const old = FakeWebSocket.all[0];
    harness.render(hook, { ...baseProps, selectedSession: { id: 's2' } });
    await settle();

    harness.terminal.written.length = 0;
    old.receive({ type: 'output', data: 'stale output' });
    expect(harness.terminal.written).toEqual([]);
  });

  it('旧 socket 晚到的 onclose 不会把当前活连接的界面打成「已断开」', async () => {
    const hook = await mountConnected();
    const old = FakeWebSocket.all[0];
    harness.render(hook, { ...baseProps, selectedSession: { id: 's2' } });
    await settle();
    harness.tickets[1]('ws://x/2');
    await settle();
    FakeWebSocket.all[1].accept();
    await settle();
    expect(current().isConnected).toBe(true);

    old.finishClose();
    await settle();
    expect(current().isConnected).toBe(true);
    expect(harness.tickets).toHaveLength(2);
  });
});

describe('终端连接 · 作废的取票', () => {
  it('取票途中用户点了断开:票回来后不再开连接', async () => {
    const { useShellRuntime } = await import('./useShellRuntime');
    harness.render(useShellRuntime as (p: unknown) => unknown, baseProps);
    await settle();
    expect(harness.tickets).toHaveLength(1);

    current().disconnectFromShell({ suppressAutoConnect: true });
    await settle();
    harness.tickets[0]('ws://x/1');
    await settle();

    expect(FakeWebSocket.all).toHaveLength(0);
    expect(current().isConnecting).toBe(false);
  });

  it('取票途中断开又发起了新的一次:先发的那张票晚回来也不再开第二条', async () => {
    const { useShellRuntime } = await import('./useShellRuntime');
    harness.render(useShellRuntime as (p: unknown) => unknown, baseProps);
    await settle();

    current().disconnectFromShell();
    await settle();
    expect(harness.tickets).toHaveLength(2);

    harness.tickets[1]('ws://x/2');
    await settle();
    harness.tickets[0]('ws://x/1');
    await settle();
    FakeWebSocket.all.forEach((socket) => socket.accept());
    await settle();

    expect(FakeWebSocket.all).toHaveLength(1);
    expect(current().wsRef.current).toBe(FakeWebSocket.all[0]);
    expect(current().isConnected).toBe(true);
  });
});

describe('终端连接 · 终端拆掉重建时的关闭', () => {
  /**
   * 换项目、切 minimal 时 useShellTerminal 只调 closeSocket,不走 disconnectFromShell。
   * 关掉的 socket 回调已经摘掉,连接状态要随关闭一起复位,自动连接才会连到新终端上。
   */
  it('只调 closeSocket 也会复位连接状态并重连一次', async () => {
    await mountConnected();
    const old = FakeWebSocket.all[0];

    harness.terminal.closeSocket!();
    await settle();
    expect(old.closedByClient).toBe(true);
    old.finishClose();
    await settle();

    expect(harness.tickets).toHaveLength(2);
    harness.tickets[1]('ws://x/2');
    await settle();
    FakeWebSocket.all[1].accept();
    await settle();

    expect(live()).toHaveLength(1);
    expect(current().wsRef.current).toBe(FakeWebSocket.all[1]);
    expect(current().isConnected).toBe(true);
  });

  it('关掉的 socket 回调已经摘掉', async () => {
    await mountConnected();
    const old = FakeWebSocket.all[0];
    harness.terminal.closeSocket!();
    expect(old.onopen).toBeNull();
    expect(old.onclose).toBeNull();
    expect(old.onerror).toBeNull();
    expect(old.onmessage).toBeNull();
  });
});

describe('终端连接 · 服务端断开(非主动)', () => {
  it('当前 socket 被服务端关掉:照常复位并带退避重连', async () => {
    await mountConnected();
    const socket = FakeWebSocket.all[0];
    socket.finishClose();
    await settle();
    expect(current().isConnected).toBe(false);
    // 连上过一次退避已清零,首次重连立刻发起
    expect(harness.tickets).toHaveLength(2);
  });
});
