import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import i18next from 'i18next';
import { describe, expect, it } from 'vitest';

import {
  anchorScrollTop,
  buildProgressTimeline,
  edgeFadeMask,
  edgeFadeState,
  findProgressAnchor,
} from './progressTimeline';
import type { TodoItem, TodoStatus } from './taskChecklist';

/**
 * 'ddapp' 这样一串字母造清单:d = completed,a = in_progress,p = pending。
 * 带 `|` 时按回合分段(第几段 = 最后一次被碰到的回合,见 TodoItem.turn);不带 = 没有回合信息。
 */
const list = (spec: string): TodoItem[] => {
  const segments = spec.split('|');
  const withTurns = segments.length > 1;
  const items: TodoItem[] = [];
  segments.forEach((segment, segmentIndex) => {
    for (const code of segment) {
      items.push({
        content: `任务 ${items.length + 1}`,
        status: ({ d: 'completed', a: 'in_progress', p: 'pending' } as Record<string, TodoStatus>)[code],
        ...(withTurns ? { turn: segmentIndex + 1 } : {}),
      });
    }
  });
  return items;
};

const visibleIndexes = (todos: TodoItem[], showEarlier = false) =>
  buildProgressTimeline(todos, { showEarlier }).rows.map((row) => row.index);

describe('锚点(当前步)', () => {
  it('这一轮的第一个 in_progress 就是当前步,已开工;没有回合信息时取最后一个 in_progress', () => {
    expect(findProgressAnchor(list('|ddapa'))).toEqual({ index: 2, started: true });
    expect(findProgressAnchor(list('ddapa'))).toEqual({ index: 4, started: true });
    expect(findProgressAnchor(list('ddapp'))).toEqual({ index: 2, started: true });
    const timeline = buildProgressTimeline(list('ddapp'));
    expect(timeline.anchorIndex).toBe(2);
    expect(timeline.anchorStarted).toBe(true);
    expect(timeline.rows.filter((row) => row.isAnchor).map((row) => row.index)).toEqual([2]);
  });

  it('复审 P1:被停止的老回合留下的 in_progress / pending 不当锚点;之后完成的照样折叠', () => {
    // 第 1 轮:1–2 完成,3 被停在 in_progress,4 pending;第 2 轮:8 条全完成;第 3 轮:13–14 完成,15 进行中,16 pending
    const todos = list('ddap|dddddddd|ddap');
    const timeline = buildProgressTimeline(todos);
    expect(timeline.anchorIndex).toBe(14);
    expect(timeline.stepNumber).toBe(15);
    // 锚点前的已完成只留最近 2 条,其余折起来;老的未完成项(3、4)不折、照样看得见
    const shown = timeline.rows.map((row) => row.index);
    expect(shown).toEqual([2, 3, 12, 13, 14, 15]);
    expect(timeline.foldableCount).toBe(10);
  });

  it('没有进行中的:最后一条已完成之后的第一个 pending 当锚点(老回合剩下的 pending 不算)', () => {
    expect(findProgressAnchor(list('dp|dddd|pp'))).toEqual({ index: 6, started: false });
    // 没有回合信息:最后完成那条之后没有 pending → 第一个 pending
    expect(findProgressAnchor(list('dpdd'))).toEqual({ index: 1, started: false });
    // 有回合信息、同一轮跳着做(先完成了后面的):前面没做的那条当下一步
    expect(findProgressAnchor(list('|dpdd'))).toEqual({ index: 1, started: false });
    // 有回合信息、这一轮做完了:老回合剩下的不算当前步
    expect(findProgressAnchor(list('dp|dd'))).toEqual({ index: -1, started: false });
  });

  it('复审 P1(二轮):老回合停下的 in_progress,在这一轮"两步之间"和"做完之后"都不当锚点,完成的照样折', () => {
    // 两步之间:第 3 轮 13–15 完成、16 还没标开工
    const between = buildProgressTimeline(list('ddap|dddddddd|dddp'));
    expect(between.anchorIndex).toBe(15);
    expect(between.stepNumber).toBe(16);
    expect(between.rows.map((row) => row.index)).toEqual([2, 3, 13, 14, 15]);
    // 这一轮做完了:没有当前步;已完成的只留最近 2 条,老的未完成项照样看得见;不算"全部完成"
    const finished = buildProgressTimeline(list('ddap|dddddddd|dddd'));
    expect(finished.anchorIndex).toBe(-1);
    expect(finished.stepNumber).toBeNull();
    expect(finished.allDone).toBe(false);
    expect(finished.rows.map((row) => row.index)).toEqual([2, 3, 14, 15]);
  });

  it('多轮接着做同一份清单:上一轮建的 pending 在这一轮完成一步之后当下一步', () => {
    // 第 1 轮建了 6 条、做完 2 条被停;第 2 轮把第 3 条开工又完成 —— 第 3 条的回合变成 2,4–6 还是第 1 轮的
    const todos: TodoItem[] = [
      { content: '1', status: 'completed', turn: 1 },
      { content: '2', status: 'completed', turn: 1 },
      { content: '3', status: 'completed', turn: 2 },
      { content: '4', status: 'pending', turn: 1 },
      { content: '5', status: 'pending', turn: 1 },
    ];
    expect(findProgressAnchor(todos)).toEqual({ index: 3, started: false });
  });

  it('跳着做(同一轮先完成了后面的):进行中的那条照样是当前步', () => {
    expect(findProgressAnchor(list('ddddapdpd'))).toEqual({ index: 4, started: true });
    expect(findProgressAnchor(list('|ddddapdpd'))).toEqual({ index: 4, started: true });
  });

  it('复审三轮 P1:刷新后窗口里没有这一轮的用户消息 —— 回合号来自服务端基线,照样认得出老回合', async () => {
    const { extractSessionChecklist } = await import('./taskChecklist');
    const { workFramesToMessages } = await import('./workFrames');
    const create = (id: number, subject: string, turn: number) => ({
      toolName: 'TaskCreate', toolInput: { subject }, resultContent: `Task #${id} created successfully: ${subject}`, resultIsError: false, turn,
    });
    const update = (id: number, status: string, turn: number) => ({
      toolName: 'TaskUpdate', toolInput: { taskId: String(id), status }, resultContent: 'ok', resultIsError: false, turn,
    });
    // 第 1 轮:1 完成、2 停在 in_progress;第 2 轮:3–5 建好,3 完成、4 开工
    const baseline = workFramesToMessages([
      create(1, '甲', 1), create(2, '乙', 1), update(1, 'completed', 1), update(2, 'in_progress', 1),
      create(3, '丙', 2), create(4, '丁', 2), create(5, '戊', 2), update(3, 'completed', 2), update(4, 'in_progress', 2),
    ]);
    // 已加载窗口只有尾部几条工具消息(这一轮的用户消息不在窗口里)
    const windowTail = workFramesToMessages([update(3, 'completed', 2), update(4, 'in_progress', 2)]).map((m) => ({ ...m, taskTurn: undefined }));
    const todos = extractSessionChecklist([...baseline, ...windowTail] as never) ?? [];
    expect(findProgressAnchor(todos)).toEqual({ index: 3, started: true });
  });

  it('复审四轮 P3-1:基线还停在上一轮(这一轮还没有任务帧)时,回合号标记把窗口里的新任务推到这一轮', async () => {
    const { extractSessionChecklist } = await import('./taskChecklist');
    const { turnMarkerMessage, workFramesToMessages } = await import('./workFrames');
    // 基线:第 1 轮建了 1、2,2 停在 in_progress;服务端说一共 2 个用户回合(第 2 轮刚开始,还没有任务帧)
    const baseline = [
      ...workFramesToMessages([
        { toolName: 'TaskCreate', toolInput: { subject: '甲' }, resultContent: 'Task #1 created successfully: 甲', resultIsError: false, turn: 1 },
        { toolName: 'TaskCreate', toolInput: { subject: '乙' }, resultContent: 'Task #2 created successfully: 乙', resultIsError: false, turn: 1 },
        { toolName: 'TaskUpdate', toolInput: { taskId: '1', status: 'completed' }, resultContent: 'ok', resultIsError: false, turn: 1 },
        { toolName: 'TaskUpdate', toolInput: { taskId: '2', status: 'in_progress' }, resultContent: 'ok', resultIsError: false, turn: 1 },
      ]),
      ...turnMarkerMessage(2),
    ];
    // 窗口(第 2 轮的用户消息不在里面):新建 3 并开工
    const live = [
      { type: 'assistant', isToolUse: true, toolName: 'TaskCreate', toolInput: { subject: '丙' }, timestamp: 0, toolResult: { content: 'Task #3 created successfully: 丙' } },
      { type: 'assistant', isToolUse: true, toolName: 'TaskUpdate', toolInput: { taskId: '3', status: 'in_progress' }, timestamp: 0, toolResult: { content: 'ok' } },
    ];
    const todos = extractSessionChecklist([...baseline, ...live] as never) ?? [];
    expect(todos.map((todo) => todo.turn)).toEqual([1, 1, 2]);
    expect(findProgressAnchor(todos)).toEqual({ index: 2, started: true });
    expect(turnMarkerMessage(0)).toEqual([]);
    expect(turnMarkerMessage('x')).toEqual([]);
  });

  it('复审五轮 P1:最近这条用户消息之后还没动过清单 → 没有当前步(上一轮停下的老任务不充数);一动清单锚点回来', async () => {
    const { extractSessionChecklistWithTurn } = await import('./taskChecklist');
    const { turnMarkerMessage, workFramesToMessages } = await import('./workFrames');
    const round1 = workFramesToMessages([
      { toolName: 'TaskCreate', toolInput: { subject: '甲' }, resultContent: 'Task #1 created successfully: 甲', resultIsError: false, turn: 1 },
      { toolName: 'TaskCreate', toolInput: { subject: '乙' }, resultContent: 'Task #2 created successfully: 乙', resultIsError: false, turn: 1 },
      { toolName: 'TaskUpdate', toolInput: { taskId: '1', status: 'completed' }, resultContent: 'ok', resultIsError: false, turn: 1 },
      { toolName: 'TaskUpdate', toolInput: { taskId: '2', status: 'in_progress' }, resultContent: 'ok', resultIsError: false, turn: 1 },
    ]);
    const userMsg = { type: 'user', content: '停,先做别的', timestamp: 0 };
    const anchorOf = (messages: unknown[]) => {
      const { items, currentTurn } = extractSessionChecklistWithTurn(messages as never);
      return buildProgressTimeline(items ?? [], { currentTurn });
    };
    // 当场:基线 + 标记(1) + 刚发出去的用户消息
    const live = anchorOf([...round1, ...turnMarkerMessage(1), userMsg]);
    expect(live.anchorIndex).toBe(-1);
    expect(live.stepNumber).toBeNull();
    expect(live.rows.map((row) => row.state)).toEqual(['done', 'active']);
    // 刷新后:标记(2),窗口里也有这条用户消息 / 窗口里没有
    expect(anchorOf([...round1, ...turnMarkerMessage(2)]).anchorIndex).toBe(-1);
    expect(anchorOf([...round1, ...turnMarkerMessage(2), userMsg]).anchorIndex).toBe(-1);
    // 老服务端(没有标记、基线不带回合号,只有窗口里的用户消息)
    const legacy = [userMsg, ...round1.map((m) => ({ ...m, taskTurn: undefined })), userMsg];
    expect(anchorOf(legacy).anchorIndex).toBe(-1);
    // 这一轮 agent 动了清单(把 2 收掉、新开 3)→ 锚点回来,落在这一轮
    const resumed = anchorOf([
      ...round1, ...turnMarkerMessage(1), userMsg,
      { type: 'assistant', isToolUse: true, toolName: 'TaskCreate', toolInput: { subject: '丙' }, timestamp: 0, toolResult: { content: 'Task #3 created successfully: 丙' } },
      { type: 'assistant', isToolUse: true, toolName: 'TaskUpdate', toolInput: { taskId: '3', status: 'in_progress' }, timestamp: 0, toolResult: { content: 'ok' } },
    ]);
    expect(resumed.anchorIndex).toBe(2);
    expect(resumed.anchorStarted).toBe(true);
    // 插话(并进正在跑的那一轮)不算新回合
    const interjected = anchorOf([...round1, ...turnMarkerMessage(1), { ...userMsg, interjection: true }]);
    expect(interjected.anchorIndex).toBe(1);
    // 不传 currentTurn(老调用方)= 原来的行为
    expect(findProgressAnchor(list('da'))).toEqual({ index: 1, started: true });
  });

  it('复审五轮(二):回合在跑时发出去的本地回声(合流 ACK 未到 / 被排到后面)不算新回合 —— 当前步不消失', async () => {
    const { extractSessionChecklistWithTurn } = await import('./taskChecklist');
    const user = { type: 'user', content: '开始', timestamp: 0 };
    const tool = (name: string, input: Record<string, unknown>, result: string) => ({
      type: 'assistant', isToolUse: true, toolName: name, toolInput: input, timestamp: 0, toolResult: { content: result },
    });
    const running = [
      user,
      tool('TaskCreate', { subject: '甲' }, 'Task #1 created successfully: 甲'),
      tool('TaskCreate', { subject: '乙' }, 'Task #2 created successfully: 乙'),
      tool('TaskUpdate', { taskId: '1', status: 'in_progress' }, 'ok'),
    ];
    const anchorOf = (messages: unknown[]) => {
      const { items, currentTurn } = extractSessionChecklistWithTurn(messages as never);
      return buildProgressTimeline(items ?? [], { currentTurn }).anchorIndex;
    };
    expect(anchorOf(running)).toBe(0);
    // 别人的回合还在跑,协作者点了「立即发送」:回声带 sentDuringTurn —— 当前步还在
    expect(anchorOf([...running, { type: 'user', content: '顺便看下乙', timestamp: 0, sentDuringTurn: true }])).toBe(0);
    // 对照:同一条要是不带这个标记(服务端那份落库行,真起了新回合)→ 新回合还没动清单,没有当前步
    expect(anchorOf([...running, { type: 'user', content: '顺便看下乙', timestamp: 0 }])).toBe(-1);
  });

  it('复审五轮:停靠行 —— 有锚点 = 锚点;没有锚点 = 第一条没完成的(折叠范围不变);全部完成 = -1', () => {
    const between = buildProgressTimeline(list('ddap|dddddddd|dddp'));
    expect(between.focusIndex).toBe(15);
    expect(between.rows.filter((row) => row.isFocus).map((row) => row.index)).toEqual([15]);
    const finished = buildProgressTimeline(list('ddap|dddddddd|dddd'));
    expect(finished.focusIndex).toBe(2);
    expect(finished.rows.map((row) => row.index)).toEqual([2, 3, 14, 15]);
    // 新回合还没动清单:没有锚点,停在第一条没完成的(上一轮停下的那条),折叠照"没有锚点"算
    const fresh = buildProgressTimeline(list('dddddap|dd'), { currentTurn: 3 });
    expect(fresh.anchorIndex).toBe(-1);
    expect(fresh.focusIndex).toBe(5);
    expect(buildProgressTimeline(list('ddd')).focusIndex).toBe(-1);
  });

  it('复审五轮(三):一轮结束时摘掉排队回声的 sentDuringTurn(收尾刷新可能抢在服务端落库之前)—— 源码钉住', () => {
    const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
    const handlers = read('../hooks/useChatRealtimeHandlers.ts');
    const clearAt = handlers.indexOf('sessionStore.clearSentDuringTurn(sid)');
    expect(clearAt).toBeGreaterThan(-1);
    // 中止的那一轮同样要摘(放在 aborted 的 break 之前)
    expect(clearAt).toBeLessThan(handlers.indexOf('if (msg.aborted)', handlers.indexOf("case 'complete'")));
    const store = read('../../../stores/useSessionStore.ts');
    expect(store).toMatch(/if \(!row\.sentDuringTurn \|\| row\.interjection\) return row;/);
  });

  it('复审五轮:TodoWrite 清单没有回合号 → currentTurn 0,照旧按状态认锚点', async () => {
    const { extractSessionChecklistWithTurn } = await import('./taskChecklist');
    const todoWrite = {
      type: 'assistant', isToolUse: true, toolName: 'TodoWrite', timestamp: 0,
      toolInput: { todos: [{ content: '甲', status: 'completed' }, { content: '乙', status: 'in_progress' }] },
    };
    const { items, currentTurn } = extractSessionChecklistWithTurn([{ type: 'user', content: 'x', timestamp: 0 }, todoWrite, { type: 'user', content: 'y', timestamp: 0 }] as never);
    expect(currentTurn).toBe(0);
    expect(buildProgressTimeline(items ?? [], { currentTurn }).anchorIndex).toBe(1);
  });

  it('没有进行中的 → 第一个 pending 当锚点,但算"还没开工"', () => {
    const timeline = buildProgressTimeline(list('ddpp'));
    expect(timeline.anchorIndex).toBe(2);
    expect(timeline.anchorStarted).toBe(false);
    expect(timeline.rows.find((row) => row.isAnchor)?.state).toBe('pending');
  });

  it('全部完成 → 没有锚点,allDone', () => {
    const timeline = buildProgressTimeline(list('ddd'));
    expect(timeline.anchorIndex).toBe(-1);
    expect(timeline.anchorStarted).toBe(false);
    expect(timeline.stepNumber).toBeNull();
    expect(timeline.allDone).toBe(true);
    expect(timeline.rows.some((row) => row.isAnchor)).toBe(false);
  });

  it('空清单 → 什么都没有,也不算全部完成', () => {
    expect(buildProgressTimeline([])).toEqual({
      anchorIndex: -1,
      anchorStarted: false,
      focusIndex: -1,
      foldableCount: 0,
      rows: [],
      stepNumber: null,
      total: 0,
      done: 0,
      allDone: false,
    });
  });

  it('「第 N 步 / 共 M 步」:锚点在完整清单里的 1 起序号,折叠不影响', () => {
    const todos = list('ddddddapppp');
    for (const showEarlier of [false, true]) {
      const timeline = buildProgressTimeline(todos, { showEarlier });
      expect(timeline.stepNumber).toBe(7);
      expect(timeline.total).toBe(11);
      expect(timeline.done).toBe(6);
    }
  });
});

describe('更早的历史折起来,最近的露着', () => {
  it('当前步之前留最近 2 条已完成,其余收进一行', () => {
    const todos = list('dddddapp');
    const timeline = buildProgressTimeline(todos);
    expect(timeline.foldableCount).toBe(3);
    expect(visibleIndexes(todos)).toEqual([3, 4, 5, 6, 7]);
    expect(timeline.rows.map((row) => row.state)).toEqual(['done', 'done', 'active', 'pending', 'pending']);
  });

  it('之前只有 1~2 条已完成 → 不需要折叠行', () => {
    expect(buildProgressTimeline(list('dap')).foldableCount).toBe(0);
    expect(buildProgressTimeline(list('ddap')).foldableCount).toBe(0);
    expect(buildProgressTimeline(list('dddap')).foldableCount).toBe(1);
  });

  it('全部完成 → 除最后 2 条外都折起来', () => {
    const todos = list('dddddd');
    expect(buildProgressTimeline(todos).foldableCount).toBe(4);
    expect(visibleIndexes(todos)).toEqual([4, 5]);
  });

  it('当前步之后的已完成(跳着做的)照常显示,从不折', () => {
    const todos = list('ddddapdpd');
    const timeline = buildProgressTimeline(todos);
    expect(timeline.foldableCount).toBe(2);
    expect(visibleIndexes(todos)).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(timeline.rows.filter((row) => row.index > 4 && row.state === 'done').map((row) => row.index)).toEqual([6, 8]);
  });

  it('当前步之前没完成的(被跳过的)是待办,不能藏', () => {
    const todos = list('dpdddda');
    // 之前的已完成:0,2,3,4,5 → 折 0,2,3,留 4,5;下标 1 的 pending 留着
    expect(buildProgressTimeline(todos).foldableCount).toBe(3);
    expect(visibleIndexes(todos)).toEqual([1, 4, 5, 6]);
  });

  it('showEarlier → 全部画出来,foldableCount 照报(UI 用它显示「收起」那行)', () => {
    const todos = list('dddddapp');
    const timeline = buildProgressTimeline(todos, { showEarlier: true });
    expect(timeline.foldableCount).toBe(3);
    expect(timeline.rows.map((row) => row.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('keepRecent 可调;0 = 之前的已完成全折', () => {
    const todos = list('ddddap');
    expect(buildProgressTimeline(todos, { keepRecent: 0 }).foldableCount).toBe(4);
    expect(buildProgressTimeline(todos, { keepRecent: 3 }).foldableCount).toBe(1);
    expect(buildProgressTimeline(todos, { keepRecent: 10 }).foldableCount).toBe(0);
  });

  it('只折已完成,不改条目本身(进行中的 activeForm 由 UI 取)', () => {
    const todos: TodoItem[] = [
      { content: '写测试', status: 'completed' },
      { content: '实现', status: 'in_progress', activeForm: '正在实现' },
    ];
    const rows = buildProgressTimeline(todos).rows;
    expect(rows[1].item).toBe(todos[1]);
    expect(rows[1].state).toBe('active');
  });
});

describe('默认滚动位置', () => {
  it('锚点上方留出最近两行', () => {
    // 折叠行 28 + 4 行 × 28 → 锚点在 140;上方两行各 28 → 84
    expect(anchorScrollTop({ anchorTop: 140, aboveHeights: [28, 28, 28, 28], snapToTopBelow: 28 })).toBe(84);
  });

  it('上面只剩折叠行/内边距 → 直接回到 0,让「N 个更早的步骤」露出来', () => {
    expect(anchorScrollTop({ anchorTop: 84, aboveHeights: [28, 28], snapToTopBelow: 28 })).toBe(0);
    expect(anchorScrollTop({ anchorTop: 28.3, aboveHeights: [], snapToTopBelow: 28 })).toBe(0);
  });

  it('换行的长条目按实际行高扣;上方不足两行就有几行扣几行', () => {
    expect(anchorScrollTop({ anchorTop: 300, aboveHeights: [48, 28, 28] })).toBe(224);
    expect(anchorScrollTop({ anchorTop: 300, aboveHeights: [48] })).toBe(252);
    expect(anchorScrollTop({ anchorTop: 300, aboveHeights: [48, 28], keepAbove: 1 })).toBe(252);
  });
});

describe('边缘渐隐', () => {
  it('能往上滚淡顶边,能往下滚淡底边', () => {
    expect(edgeFadeState({ scrollTop: 0, scrollHeight: 100, clientHeight: 100 })).toEqual({ top: false, bottom: false });
    expect(edgeFadeState({ scrollTop: 0, scrollHeight: 300, clientHeight: 100 })).toEqual({ top: false, bottom: true });
    expect(edgeFadeState({ scrollTop: 100, scrollHeight: 300, clientHeight: 100 })).toEqual({ top: true, bottom: true });
    expect(edgeFadeState({ scrollTop: 200, scrollHeight: 300, clientHeight: 100 })).toEqual({ top: true, bottom: false });
    // 缩放带来的小数不算"还能滚"
    expect(edgeFadeState({ scrollTop: 199.5, scrollHeight: 300, clientHeight: 100 })).toEqual({ top: true, bottom: false });
  });

  it('mask:哪头需要淡哪头透明;都不用就摘掉', () => {
    expect(edgeFadeMask({ top: false, bottom: false })).toBeNull();
    expect(edgeFadeMask({ top: true, bottom: false })).toBe('linear-gradient(to bottom, transparent 0, #000 20px, #000 100%)');
    expect(edgeFadeMask({ top: false, bottom: true })).toBe('linear-gradient(to bottom, #000 0, #000 calc(100% - 20px), transparent 100%)');
    expect(edgeFadeMask({ top: true, bottom: true }, 16)).toBe(
      'linear-gradient(to bottom, transparent 0, #000 16px, #000 calc(100% - 16px), transparent 100%)',
    );
  });
});

describe('折叠行与计数的文案', () => {
  const load = (lang: string) =>
    JSON.parse(readFileSync(fileURLToPath(new URL(`../../../i18n/locales/${lang}/chat.json`, import.meta.url)), 'utf8'));

  const translator = async () => {
    const instance = i18next.createInstance();
    await instance.init({
      lng: 'en',
      fallbackLng: false,
      ns: ['chat'],
      defaultNS: 'chat',
      interpolation: { escapeValue: false },
      resources: Object.fromEntries(['en', 'ru', 'zh-CN', 'de'].map((lang) => [lang, { chat: load(lang) }])),
    });
    return instance;
  };

  it('en 区分单复数(单数形态是 workPanel.earlierSteps_one,复数走基础键)', async () => {
    const instance = await translator();
    expect(instance.exists('workPanel.earlierSteps_one', { lng: 'en' })).toBe(true);
    const t = instance.getFixedT('en', 'chat');
    expect(t('workPanel.earlierSteps', { count: 1 })).toBe('1 earlier step');
    expect(t('workPanel.earlierSteps', { count: 3 })).toBe('3 earlier steps');
    expect(t('workPanel.stepOf', { current: 4, total: 24 })).toBe('Step 4 of 24');
  });

  it('ru 三种形态;zh-CN 只有一种', async () => {
    const instance = await translator();
    const ru = instance.getFixedT('ru', 'chat');
    expect([1, 3, 5, 21].map((count) => ru('workPanel.earlierSteps', { count }))).toEqual([
      '1 предыдущий шаг',
      '3 предыдущих шага',
      '5 предыдущих шагов',
      '21 предыдущий шаг',
    ]);
    const zh = instance.getFixedT('zh-CN', 'chat');
    expect(zh('workPanel.earlierSteps', { count: 1 })).toBe('1 个更早的步骤');
    expect(zh('workPanel.stepOf', { current: 4, total: 24 })).toBe('第 4 步 / 共 24 步');
    const de = instance.getFixedT('de', 'chat');
    expect(de('workPanel.earlierSteps', { count: 1 })).toBe('1 früherer Schritt');
    expect(de('workPanel.earlierSteps', { count: 2 })).toBe('2 frühere Schritte');
  });
});
