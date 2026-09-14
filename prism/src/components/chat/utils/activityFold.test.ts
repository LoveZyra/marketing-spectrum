import { describe, expect, it } from 'vitest';

import type { ChatMessage } from '../types/types';

import type { MessageListItem, SubagentGroupItem, ToolGroupItem } from './toolGrouping';
import { activityItemRole } from './turnBoundary';
import {
  ACTIVITY_TAIL_ROWS,
  NARRATION_FOLD_CHARS,
  collapsedVisibleCount,
  focusActivityGroup,
  planActivityFold,
  shouldFoldNarration,
  shouldKeepActivityTailOpen,
  type ActivityItemRole,
} from './toolRowSummary';

/**
 * fw 起的折叠规则(用户定的三条):
 *
 * 1. **只要有一行就渲染抬头**;
 * 2. 这一轮的**正文还没出现**时,最新三行不折、其余折起;
 * 3. **正式回复一出现,整段全部折起**。
 */
describe('planActivityFold', () => {
  it('**只要有一行就出抬头**,而且抬头一定可点', () => {
    for (const total of [1, 2, 3, 10]) {
      for (const keepTail of [true, false]) {
        const plan = planActivityFold(total, keepTail);
        expect(plan.showSummary).toBe(true);
        expect(plan.canFold).toBe(true);
      }
    }
  });

  it('一行都没有 → 不出抬头', () => {
    const plan = planActivityFold(0, true);
    expect(plan.showSummary).toBe(false);
    expect(plan.canFold).toBe(false);
    expect(plan.visibleCount).toBe(0);
  });

  it('正文还没出现:留最新三行,其余折起', () => {
    const plan = planActivityFold(17, true);
    expect(plan.visibleCount).toBe(ACTIVITY_TAIL_ROWS);
    expect(plan.foldedCount).toBe(14);
  });

  it('正文还没出现且不足三行:全露,没什么可折的', () => {
    for (const total of [1, 2]) {
      const plan = planActivityFold(total, true);
      expect(plan.visibleCount).toBe(total);
      expect(plan.foldedCount).toBe(0);
      // 抬头照样出现(规则 1),点它就是手动收起
      expect(plan.showSummary).toBe(true);
    }
  });

  it('正文出现之后:无论几行都整段收起', () => {
    for (const total of [1, 2, 3, 16]) {
      const plan = planActivityFold(total, false);
      expect(plan.visibleCount).toBe(0);
      expect(plan.foldedCount).toBe(total);
    }
  });

  it('露出的 + 折起的 == 总数', () => {
    for (const total of [0, 1, 2, 3, 4, 10, 40]) {
      for (const keepTail of [true, false]) {
        const plan = planActivityFold(total, keepTail);
        expect(plan.visibleCount + plan.foldedCount).toBe(total);
      }
    }
  });
});

describe('shouldKeepActivityTailOpen', () => {
  it('这一轮的那一段、正文还没出现 → 留尾部三行', () => {
    expect(shouldKeepActivityTailOpen(true, false)).toBe(true);
  });

  it('**正文一出现就全折**(用户要的第 3 条)', () => {
    expect(shouldKeepActivityTailOpen(true, true)).toBe(false);
  });

  it('不是这一轮的段 → 一律折起', () => {
    expect(shouldKeepActivityTailOpen(false, false)).toBe(false);
    expect(shouldKeepActivityTailOpen(false, true)).toBe(false);
  });
});

/**
 * `focusActivityGroup` 一次倒扫回答两件事:
 * - `index`:哪一段属于正在跑的这一轮(决定行状态:运行中 / 已中断);
 * - `replyStarted`:这一轮的正文开始写了没有(决定折不折)。
 *
 * 拆成两个判据就是下一次"只改了一半"的温床 —— 这一轮已经因此付了三个包
 * (ft / fu / fw)。
 */
describe('focusActivityGroup', () => {
  const at = (roles: readonly ActivityItemRole[], replyInFlight = false) =>
    focusActivityGroup(roles.length, (i) => roles[i], replyInFlight);

  it('活动段在末尾、正文还没写 → 它就是当前段', () => {
    expect(at(['turn-boundary', 'other', 'activity'])).toEqual({ index: 2, replyStarted: false });
  });

  it('**正文已经落地 → 仍是当前段,但 replyStarted 为真**(所以会收起)', () => {
    expect(at(['turn-boundary', 'activity', 'reply'])).toEqual({ index: 1, replyStarted: true });
  });

  it('**正文正在流式打字 → 同样算已出现**(它不在列表里)', () => {
    expect(at(['turn-boundary', 'activity'], true)).toEqual({ index: 1, replyStarted: true });
  });

  it('写完一段正文又接着调工具 → 新那段是当前段,replyStarted 归位', () => {
    expect(at(['turn-boundary', 'activity', 'reply', 'activity'])).toEqual({ index: 3, replyStarted: false });
  });

  it('**活动段后面又来了一条用户消息 → 谁都不是当前段**(fu 修的那一半)', () => {
    expect(at(['activity', 'reply', 'turn-boundary'])).toEqual({ index: -1, replyStarted: false });
  });

  it('错误行同样是回合边界', () => {
    expect(at(['activity', 'turn-boundary']).index).toBe(-1);
  });

  it('子代理卡 / 通知这类不改变归属', () => {
    expect(at(['turn-boundary', 'activity', 'other', 'other']).index).toBe(1);
  });

  it('一段活动都没有 / 空列表 → -1', () => {
    expect(at(['turn-boundary', 'other']).index).toBe(-1);
    expect(at([]).index).toBe(-1);
  });
});

/**
 * 端到端:把真实形状的列表项喂进 `activityItemRole`(组件用的那一份真身),
 * 再走 focus → keepTail → planActivityFold,验完整条链路。
 */
describe('三条规则端到端', () => {
  const toolGroup = (count: number, key = 'g'): ToolGroupItem => ({
    _isGroup: true, _key: key, toolName: 'Bash',
    messages: Array.from({ length: count }, () => ({ type: 'assistant', content: '', isToolUse: true }) as ChatMessage),
    timestamp: 0,
  });
  const subagents = (): SubagentGroupItem => ({ _isSubagentGroup: true, _key: 's1', messages: [], timestamp: 0 });
  const msg = (type: ChatMessage['type'], extra: Partial<ChatMessage> = {}): ChatMessage =>
    ({ type, content: 'x', ...extra }) as ChatMessage;

  const plan = (items: readonly MessageListItem[], target: MessageListItem, replyInFlight = false) => {
    const focus = focusActivityGroup(items.length, (i) => activityItemRole(items[i]), replyInFlight);
    const isCurrent = items.indexOf(target) === focus.index;
    const rows = (target as ToolGroupItem).messages.length;
    return planActivityFold(rows, shouldKeepActivityTailOpen(isCurrent, focus.replyStarted));
  };

  it('**前端的本地提示(附件太大之类)不是回合边界**', () => {
    // fz:这九处红字与正在跑的那一轮毫无关系,时间戳却排在它最后。
    expect(activityItemRole(msg('error', { isLocalNotice: true } as Partial<ChatMessage>))).toBe('other');
    // provider 报的错照旧终结回合
    expect(activityItemRole(msg('error'))).toBe('turn-boundary');
  });

  it('**拖错一个附件,不许把正在跑的那段折掉**(用户实际会遇到的那一幕)', () => {
    const run = toolGroup(5);
    const items: MessageListItem[] = [
      msg('user'), run,
      msg('error', { isLocalNotice: true } as Partial<ChatMessage>),   // 「附件超过 20MB」
    ];
    const focus = focusActivityGroup(items.length, (i) => activityItemRole(items[i]));
    expect(focus.index).toBe(1);          // 还是当前段(行状态照旧是「运行中」)
    expect(focus.replyStarted).toBe(false);
    expect(planActivityFold(5, shouldKeepActivityTailOpen(true, focus.replyStarted)).visibleCount)
      .toBe(ACTIVITY_TAIL_ROWS);          // 清单照旧摊着最新三行
  });

  it('activityItemRole 认得四类项', () => {
    expect(activityItemRole(toolGroup(1))).toBe('activity');
    expect(activityItemRole(subagents())).toBe('other');
    expect(activityItemRole(msg('user'))).toBe('turn-boundary');
    expect(activityItemRole(msg('error'))).toBe('turn-boundary');
    expect(activityItemRole(msg('assistant'))).toBe('reply');
    // 工具行 / 思考 / 交互式提示 / 通知虽然也是 assistant,但不是"正式回复"
    expect(activityItemRole(msg('assistant', { isThinking: true }))).toBe('other');
    expect(activityItemRole(msg('assistant', { isToolUse: true }))).toBe('other');
    expect(activityItemRole(msg('assistant', { isInteractivePrompt: true } as Partial<ChatMessage>))).toBe('other');
    expect(activityItemRole(msg('assistant', { isStreaming: true }))).toBe('other');
  });

  it('规则 2:回合刚跑出一步 → 抬头就有了,那一行摊着', () => {
    const run = toolGroup(1);
    const result = plan([msg('user'), run], run);
    expect(result.showSummary).toBe(true);
    expect(result.visibleCount).toBe(1);
  });

  it('规则 2:跑到第五步 → 露最新三行,右端「+2」', () => {
    const run = toolGroup(5);
    const result = plan([msg('user'), run], run);
    expect(result.visibleCount).toBe(ACTIVITY_TAIL_ROWS);
    expect(result.foldedCount).toBe(2);
  });

  it('**规则 3:正文一开始流式打字,整段就收起**', () => {
    const run = toolGroup(5);
    expect(plan([msg('user'), run], run, true).visibleCount).toBe(0);
  });

  it('规则 3:正文落地之后仍然收着', () => {
    const run = toolGroup(5);
    expect(plan([msg('user'), run, msg('assistant')], run).visibleCount).toBe(0);
  });

  it('发完下一条消息,上一轮那段照旧收着(fu 的回归)', () => {
    const previous = toolGroup(5, 'prev');
    expect(plan([msg('user'), previous, msg('assistant'), msg('user')], previous).visibleCount).toBe(0);
  });

  it('正文之后又开了新一段工具流 → 新那段摊开、旧那段收着', () => {
    const previous = toolGroup(5, 'prev');
    const current = toolGroup(4, 'cur');
    const items = [msg('user'), previous, msg('assistant'), current];
    expect(plan(items, previous).visibleCount).toBe(0);
    expect(plan(items, current).visibleCount).toBe(ACTIVITY_TAIL_ROWS);
  });
});

/**
 * gb:**收起 ≠ 清空。**
 *
 * 现象:一轮跑到 33 步时点抬头收起,**正在跑的那几步也一起没了** —— 屏幕上只剩
 * 一条「执行 33 条命令 · 思考 17 次 · 运行中」的光杆抬头,底下什么都没有;
 * 而 `manualFold` 一旦定下就压过自动规则(fw 有意为之),这一轮**剩下的全程**
 * 都不再露出来。
 *
 * 病根是这一段有**两个"收起"**:自动规则(`planActivityFold`)在回合还在跑时
 * 收到尾部三行,而组件里手动收起写死的是 `0`。同一个动作两种含义。
 *
 * 现在两条路共用 `collapsedVisibleCount`。
 */
describe('collapsedVisibleCount', () => {
  it('回合还在跑:收起 = 留尾部三行(这就是那条 bug)', () => {
    expect(collapsedVisibleCount(33, true)).toBe(ACTIVITY_TAIL_ROWS);
    expect(collapsedVisibleCount(4, true)).toBe(ACTIVITY_TAIL_ROWS);
  });

  it('回合已结束:收起 = 收干净', () => {
    expect(collapsedVisibleCount(33, false)).toBe(0);
    expect(collapsedVisibleCount(1, false)).toBe(0);
  });

  it('段内 ≤3 行且还在跑:真的收干净 —— 否则那个按钮就是死键', () => {
    // fw 专门修过"两行的段点了没反应";留三行的话这里又会变成没反应。
    for (const total of [1, 2, 3]) {
      expect(collapsedVisibleCount(total, true)).toBe(0);
    }
  });

  it('**"会话完成后才全部折叠"是白送的**:同一份记忆,keepTail 一翻假就自己收干净', () => {
    // 用户在回合中途手动收起 → 露三行
    expect(collapsedVisibleCount(20, true)).toBe(ACTIVITY_TAIL_ROWS);
    // 回合结束(keepTail 由 focusActivityGroup 翻假)→ 同一个手动状态,收干净
    expect(collapsedVisibleCount(20, false)).toBe(0);
  });

  it('与自动规则在"回合结束"这一点上必须一致 —— 两条路一个判据', () => {
    for (const total of [0, 1, 3, 4, 33]) {
      expect(collapsedVisibleCount(total, false)).toBe(planActivityFold(total, false).visibleCount);
    }
  });
});

/**
 * gg:**子代理叙述的折叠判据。**
 *
 * 用户原话:「子 agent 的思考输出,折叠掉,不要全部放上显得太多」。
 * 判据刻意是「一行放不放得下」而不是「是不是思考」—— 撑墙的是长度,不是种类。
 */
describe('shouldFoldNarration', () => {
  it('一行放得下的原样铺开 —— 加个箭头只是多一次点击', () => {
    // 实测里那些一句话说完的叙述
    expect(shouldFoldNarration("I'll start by exploring the directory to understand the existing code style.")).toBe(false);
    expect(shouldFoldNarration('Let me look at existing scripts to match the style.')).toBe(false);
    expect(shouldFoldNarration('先看看目录结构')).toBe(false);
    expect(shouldFoldNarration('')).toBe(false);
  });

  it('带换行的多段思考一律折起来', () => {
    expect(shouldFoldNarration('第一段\n\n第二段')).toBe(true);
    // 短但换行了也折 —— 换行本身就意味着它要占好几行
    expect(shouldFoldNarration('甲\n乙')).toBe(true);
  });

  it('单行但超长的也折 —— 长正文和长思考一视同仁', () => {
    expect(shouldFoldNarration('x'.repeat(NARRATION_FOLD_CHARS))).toBe(false);
    expect(shouldFoldNarration('x'.repeat(NARRATION_FOLD_CHARS + 1))).toBe(true);
  });
});
