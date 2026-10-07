/**
 * 控制帧的处理:直接驱动 useChatRealtimeHandlers,看回调、store 与服务器时钟取样。
 *
 * `chat_queue_cancelled`:
 * 排队的那条被中止 / 送不出 / 过期时,服务端把正文退回给排它的人。这段话最后必须有个去处:
 * 发出它的标签页填回输入框(填不进就抄进提示);同一个人的别的标签页、刷新过的标签页
 * 不回填,但提示里照样有原文;别人拿到的帧不带正文,提示里只有结论。
 *
 * vitest 这边没有 jsdom,这里用一个只驱动单个自定义 hook 的最小 hooks 运行时替掉 react
 * (与 shell/hooks/shellConnectionLifecycle.test.ts 同一做法),订阅回调拿到之后直接喂帧。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => {
  type Slot = { current?: unknown; deps?: unknown[] | null; cleanup?: (() => void) | void };
  let slots: Slot[] = [];
  let cursor = 0;
  let pendingEffects: Array<() => void> = [];

  const depsEqual = (a?: unknown[] | null, b?: unknown[] | null) =>
    !!a && !!b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));

  const react = {
    useRef(initial: unknown) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { current: initial };
      return slots[index];
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
    render(hook: (props: unknown) => unknown, props: unknown) {
      cursor = 0;
      const result = hook(props);
      const run = pendingEffects;
      pendingEffects = [];
      run.forEach((effect) => effect());
      return result;
    },
    reset() {
      slots = [];
      cursor = 0;
      pendingEffects = [];
    },
  };
});

vi.mock('react', () => harness.react);
vi.mock('../../../i18n/config.js', () => ({ default: { t: (key: string) => key } }));
vi.mock('../../../shared/view/ui/toastBus', () => ({ emitToast: () => {} }));
vi.mock('../../../utils/pageTitleNotification', () => ({ showCompletionTitleIndicator: () => {} }));
vi.mock('../../../utils/notificationSound', () => ({
  playChatCompletionSound: () => {},
  playNotificationSound: () => {},
}));
vi.mock('../utils/chatStorage', () => ({ readQueuedMessage: () => null, clearQueuedMessage: () => {} }));

const { useChatRealtimeHandlers } = await import('./useChatRealtimeHandlers');
const { resetServerClockForTest, serverNow } = await import('../../../stores/serverClock');

type Frame = Record<string, unknown>;

function mount(options: {
  sentHere?: string[];
  /** 输入框收不收得下(输入框里已经有字时回填不成立)。 */
  composerAccepts?: boolean;
  /** 本页里那条没发出去的本地回声(刷新过的标签页没有)。 */
  echo?: { clientMessageId: string; content: string } | null;
}) {
  let listener: ((frame: Frame) => void) | null = null;
  const returned: Array<[string, string]> = [];
  const dropped: Array<[string, string]> = [];
  const appended: Array<{ sessionId: string; row: { kind?: string; content?: string; isLocalNotice?: boolean } }> = [];
  const queueChanges: Array<[string, unknown]> = [];
  let reconnects = 0;
  const echo = options.echo ?? null;

  harness.reset();
  harness.render(useChatRealtimeHandlers as (props: unknown) => unknown, {
    subscribe: (next: (frame: Frame) => void) => {
      listener = next;
      return () => { listener = null; };
    },
    provider: 'claude',
    selectedSession: { id: 's1' },
    currentSessionId: 's1',
    setTokenBudget: () => {},
    pendingPermissionRequests: [],
    setPendingPermissionRequests: () => {},
    streamTimerRef: { current: new Map() },
    accumulatedStreamRef: { current: new Map() },
    lastSeqRef: { current: new Map() },
    statusCheckSentAtRef: { current: new Map() },
    sessionStore: {
      dropUnsentEcho: (sessionId: string, clientMessageId: string) => {
        dropped.push([sessionId, clientMessageId]);
        return echo && echo.clientMessageId === clientMessageId ? { content: echo.content } : null;
      },
      appendRealtime: (sessionId: string, row: { kind?: string; content?: string; isLocalNotice?: boolean }) => {
        appended.push({ sessionId, row });
      },
      refreshFromServer: async () => null,
    },
    onServerQueueChange: (sessionId: string, queued: unknown) => { queueChanges.push([sessionId, queued]); },
    onServerQueueReturned: (sessionId: string, content: string) => {
      returned.push([sessionId, content]);
      return options.composerAccepts ?? true;
    },
    wasSentHere: (clientMessageId: string) => (options.sentHere ?? []).includes(clientMessageId),
    onWebSocketReconnect: () => { reconnects += 1; },
  });
  expect(listener, '处理器没有订阅').not.toBeNull();

  return {
    feed: (frame: Frame) => listener!({ timestamp: new Date().toISOString(), ...frame }),
    returned,
    dropped,
    notices: () => appended.filter((entry) => entry.row.kind === 'error').map((entry) => entry.row),
    queueChanges,
    reconnects: () => reconnects,
  };
}

const ORIGINAL = '把第 3 步改成先跑单测再提交';
const cancelled = (patch: Frame): Frame => ({ kind: 'chat_queue_cancelled', sessionId: 's1', reason: 'aborted', ...patch });

beforeEach(() => {
  harness.reset();
  resetServerClockForTest();
});

describe('chat_queue_cancelled', () => {
  it('本页发过、输入框收得下:正文回填,本地回声撤掉,不留提示', () => {
    const page = mount({ sentHere: ['cm-1'], echo: { clientMessageId: 'cm-1', content: ORIGINAL } });
    page.feed(cancelled({ clientMessageId: 'cm-1', content: ORIGINAL }));
    expect(page.queueChanges).toEqual([['s1', null]]);
    expect(page.returned).toEqual([['s1', ORIGINAL]]);
    expect(page.dropped).toEqual([['s1', 'cm-1']]);
    expect(page.notices()).toEqual([]);
  });

  it('本页发过、输入框里已经有字:回填不成立,原文抄进提示', () => {
    const page = mount({ sentHere: ['cm-1'], composerAccepts: false, echo: { clientMessageId: 'cm-1', content: ORIGINAL } });
    page.feed(cancelled({ clientMessageId: 'cm-1', content: ORIGINAL }));
    expect(page.returned).toEqual([['s1', ORIGINAL]]);
    const [notice] = page.notices();
    expect(notice.content).toContain(`> ${ORIGINAL}`);
    expect(notice.isLocalNotice).toBe(true);
  });

  it('同一个人的另一个标签页(没发过,帧带正文):不回填,提示里有原文', () => {
    const page = mount({ sentHere: ['cm-other'] });
    page.feed(cancelled({ clientMessageId: 'cm-1', content: ORIGINAL }));
    expect(page.returned).toEqual([]);
    expect(page.notices()[0].content).toContain(`> ${ORIGINAL}`);
  });

  it('刷新过的发起人标签页(不记得发过、也没有回声,帧带正文):这段话留在提示里,不会丢', () => {
    const page = mount({ sentHere: [], echo: null });
    page.feed(cancelled({ clientMessageId: 'cm-1', content: ORIGINAL, reason: 'undeliverable' }));
    expect(page.returned).toEqual([]);
    expect(page.dropped).toEqual([['s1', 'cm-1']]);
    expect(page.notices()).toHaveLength(1);
    expect(page.notices()[0].content).toContain(`> ${ORIGINAL}`);
  });

  it('别人拿到的帧(服务端不带正文):不回填,提示里只有结论', () => {
    const page = mount({ sentHere: [] });
    page.feed(cancelled({ clientMessageId: 'cm-1' }));
    expect(page.returned).toEqual([]);
    expect(page.notices().map((row) => row.content)).toEqual(['排队中的那条消息随本轮中止一起取消了,没有发送。']);
  });

  it('老帧(不带 clientMessageId):有正文就回填,认不出是哪条回声所以不撤', () => {
    const page = mount({ sentHere: [] });
    page.feed(cancelled({ content: ORIGINAL }));
    expect(page.returned).toEqual([['s1', ORIGINAL]]);
    expect(page.dropped).toEqual([]);
    expect(page.notices()).toEqual([]);
  });

  it('过期作废(帧上没有正文):不回填,撤掉回声,提示里抄的是回声的原文', () => {
    const page = mount({ sentHere: ['cm-1'], echo: { clientMessageId: 'cm-1', content: ORIGINAL } });
    page.feed(cancelled({ clientMessageId: 'cm-1', reason: 'expired' }));
    expect(page.returned).toEqual([]);
    expect(page.dropped).toEqual([['s1', 'cm-1']]);
    const [notice] = page.notices();
    expect(notice.content).toContain('等待超过 30 分钟');
    expect(notice.content).toContain(`> ${ORIGINAL}`);
  });

  it('用户自己撤销的(cancelled):不提示', () => {
    const page = mount({ sentHere: ['cm-1'], echo: { clientMessageId: 'cm-1', content: ORIGINAL } });
    page.feed(cancelled({ clientMessageId: 'cm-1', reason: 'cancelled', content: ORIGINAL }));
    expect(page.returned).toEqual([]);
    expect(page.dropped).toEqual([['s1', 'cm-1']]);
    expect(page.notices()).toEqual([]);
  });

  it('chat_queue_flushed 只清排队卡', () => {
    const page = mount({ sentHere: ['cm-1'] });
    page.feed({ kind: 'chat_queue_flushed', sessionId: 's1', clientMessageId: 'cm-1', content: ORIGINAL });
    expect(page.queueChanges).toEqual([['s1', null]]);
    expect(page.returned).toEqual([]);
    expect(page.dropped).toEqual([]);
    expect(page.notices()).toEqual([]);
  });
});

describe('服务器时钟取样', () => {
  const browserFastBy = 60_000;
  const serverStamp = () => new Date(Date.now() - browserFastBy).toISOString();

  it('订阅回执 chat_subscribed 也取样:切会话 / 重连之后不用等用户发消息', () => {
    // 冻住浏览器时间:打戳、收帧、读"现在"之间跨过毫秒边界会让差值多出或少掉 1 毫秒
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-07T08:00:00.000Z'));
    try {
      const page = mount({});
      page.feed({ kind: 'chat_subscribed', sessionId: 's1', isProcessing: false, timestamp: serverStamp() });
      // 浏览器表快 60 秒:校正后的"现在"正好比浏览器时间早 60 秒
      expect(Date.now() - serverNow()).toBe(browserFastBy);
    } finally {
      now.mockRestore();
    }
  });

  it('运行帧不取样(可能是断线后补发的旧帧)', () => {
    const page = mount({});
    page.feed({ kind: 'thinking', sessionId: 's1', content: '想', timestamp: serverStamp() });
    expect(Math.abs(Date.now() - serverNow())).toBeLessThan(1_000);
  });
});

describe('重连', () => {
  it('websocket_reconnected 交给重连回调(补订与补拉的顺序见 utils/reconnectSubscribe.test.ts)', () => {
    const page = mount({});
    page.feed({ kind: 'websocket_reconnected' });
    expect(page.reconnects()).toBe(1);
  });
});
