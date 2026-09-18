import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { ChatMessage } from '../types/types';
import { autoSendAttemptAllowed, AUTO_SEND_MAX_ATTEMPTS } from '../../../hooks/useQueuedMessageAutoSend';

import { fromStoredCommand, type StoredSendCommand } from './sendCommand';
import { subagentStillRunning, subagentToolStepCount } from './subagentStatus';
import { summarizeToolRow } from './toolRowSummary';

const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

/**
 * gh:审计报告(gg 后)里前端那几条的回归测试。纯函数走真函数;hook 内部的分支钉整句。
 */
function toolMessage(partial: Partial<ChatMessage>): ChatMessage {
  return {
    type: 'assistant',
    timestamp: new Date('2026-09-14T10:00:00.000Z'),
    isToolUse: true,
    toolName: 'Bash',
    toolInput: { command: 'pytest' },
    ...partial,
  } as ChatMessage;
}

describe('#18 转后台的行,耗时以后台状态为准', () => {
  const backgroundedResult = { content: 'Running in the background', timestamp: '2026-09-14T10:00:00.200Z' };

  it('后台跑着:duration 留空 → 界面显示「运行中」,不是转后台前的 0.2s', () => {
    const row = summarizeToolRow(toolMessage({
      toolResult: backgroundedResult,
      background: { status: 'running' },
    } as unknown as Partial<ChatMessage>));
    expect(row.status).toBe('running');
    expect(row.duration).toBe('');
  });

  it('后台跑完:用 task_notification 带回的 duration_ms,不是那个 tool_result 的时间戳', () => {
    const row = summarizeToolRow(toolMessage({
      toolResult: backgroundedResult,
      background: { status: 'completed', durationMs: 90_000 },
    } as unknown as Partial<ChatMessage>));
    expect(row.status).toBe('done');
    expect(row.duration).toBe('1m 30s');
  });

  it('没有后台状态的普通行:照旧按 tool_result 的时间戳算', () => {
    const row = summarizeToolRow(toolMessage({ toolResult: { content: 'ok', timestamp: '2026-09-14T10:00:02.000Z' } }));
    expect(row.duration).toBe('2.0s');
  });

  it('接线:ActivityTimeline 对 running 一律显示「运行中」,不再被非空 duration 短路', () => {
    const timeline = read('../view/subcomponents/ActivityTimeline.tsx');
    expect(timeline).toMatch(/\{summary\?\.status === 'running'\s*\n\s*\? t\('activity\.running'/);
    expect(timeline).not.toMatch(/summary\?\.status === 'running' && !summary\.duration/);
  });
});

describe('#16 / #17 子代理的"还在跑"与"步数"只有一处定义', () => {
  const child = (kind: 'tool' | 'text' | 'thinking') => ({
    toolId: `c-${kind}-${Math.random()}`, toolName: kind === 'tool' ? 'Read' : kind, toolInput: undefined,
    toolResult: null, timestamp: new Date(), kind,
  });

  it('有后台状态以它为准:转后台的(有 toolResult)在跑;主回合结束了也在跑', () => {
    const backgrounded = toolMessage({
      toolResult: { content: 'Running in the background' },
      subagentState: { childTools: [], isComplete: true, background: { status: 'running' } },
    } as unknown as Partial<ChatMessage>);
    expect(subagentStillRunning(backgrounded, true)).toBe(true);
    expect(subagentStillRunning(backgrounded, false)).toBe(true);
    const settled = toolMessage({
      toolResult: { content: 'x' },
      subagentState: { childTools: [], isComplete: true, background: { status: 'completed' } },
    } as unknown as Partial<ChatMessage>);
    expect(subagentStillRunning(settled, true)).toBe(false);
  });

  it('没有后台状态:回合在跑 + 没交结果 = 在跑;回合结束 = 不在跑', () => {
    const live = toolMessage({ subagentState: { childTools: [], isComplete: false } } as unknown as Partial<ChatMessage>);
    expect(subagentStillRunning(live, true)).toBe(true);
    expect(subagentStillRunning(live, false)).toBe(false);
  });

  it('步数只数工具:5 次工具 + 8 段思考/正文 = 5 步,不是 13', () => {
    const message = toolMessage({
      subagentState: {
        isComplete: false,
        childTools: [
          ...Array.from({ length: 5 }, () => child('tool')),
          ...Array.from({ length: 4 }, () => child('thinking')),
          ...Array.from({ length: 4 }, () => child('text')),
        ],
      },
    } as unknown as Partial<ChatMessage>);
    expect(subagentToolStepCount(message)).toBe(5);
  });

  it('步数取两个来源的最大值(ge 那条不许回归):进展帧说 7、实收 5 → 7', () => {
    const message = toolMessage({
      subagentState: {
        isComplete: false,
        childTools: Array.from({ length: 5 }, () => child('tool')),
        background: { status: 'running', toolUses: 7 },
      },
    } as unknown as Partial<ChatMessage>);
    expect(subagentToolStepCount(message)).toBe(7);
  });
});

describe('#15 后台续发有上限', () => {
  it('同一条消息 60 秒内最多 3 次;窗口外重置;换了消息从头数', () => {
    const attempts = new Map<string, { messageId: string | null; count: number; firstAt: number }>();
    const t0 = 1_000_000;
    expect(autoSendAttemptAllowed(attempts, 'S', t0, 'm1')).toBe(true);
    expect(autoSendAttemptAllowed(attempts, 'S', t0 + 1000, 'm1')).toBe(true);
    expect(autoSendAttemptAllowed(attempts, 'S', t0 + 2000, 'm1')).toBe(true);
    expect(autoSendAttemptAllowed(attempts, 'S', t0 + 3000, 'm1')).toBe(false);
    expect(AUTO_SEND_MAX_ATTEMPTS).toBe(3);
    // 别的会话不受影响
    expect(autoSendAttemptAllowed(attempts, 'T', t0 + 3000, 'm1')).toBe(true);
    // 一分钟之后重新计数
    expect(autoSendAttemptAllowed(attempts, 'S', t0 + 61_000, 'm1')).toBe(true);
  });

  it('**按消息计数,不按会话**:一个后台会话连着几个短回合各排一条,不会被当成死循环', () => {
    const attempts = new Map<string, { messageId: string | null; count: number; firstAt: number }>();
    const t0 = 1_000_000;
    // 四条不同的消息、都在 60 秒内、都要能发
    expect(autoSendAttemptAllowed(attempts, 'S', t0, 'm1')).toBe(true);
    expect(autoSendAttemptAllowed(attempts, 'S', t0 + 5000, 'm2')).toBe(true);
    expect(autoSendAttemptAllowed(attempts, 'S', t0 + 10_000, 'm3')).toBe(true);
    expect(autoSendAttemptAllowed(attempts, 'S', t0 + 15_000, 'm4')).toBe(true);
    // 同一条反复三次之后才拦
    expect(autoSendAttemptAllowed(attempts, 'S', t0 + 16_000, 'm4')).toBe(true);
    expect(autoSendAttemptAllowed(attempts, 'S', t0 + 17_000, 'm4')).toBe(true);
    expect(autoSendAttemptAllowed(attempts, 'S', t0 + 18_000, 'm4')).toBe(false);
  });

  it('接线:超限就清记录、不再 sendMessage;带 forkFrom 的交回 composer', () => {
    const hook = read('../../../hooks/useQueuedMessageAutoSend.ts');
    expect(hook).toMatch(/if \(!autoSendAttemptAllowed\(attemptsRef\.current, sessionId, Date\.now\(\), queued\.clientMessageId \?\? null\)\) \{[\s\S]{0,300}clearQueuedMessage\(sessionId\);[\s\S]{0,120}return;/);
    expect(hook).toMatch(/if \(queued\.forkFrom\) \{\s*\n\s*releaseQueuedMessage\(sessionId\);\s*\n\s*return;/);
    // 两道门都在 sendMessage 之前
    expect(hook.indexOf('if (queued.forkFrom) {')).toBeLessThan(hook.indexOf('const sent = sendMessage({'));
    expect(hook.indexOf('autoSendAttemptAllowed(attemptsRef.current')).toBeLessThan(hook.indexOf('const sent = sendMessage({'));
  });
});

describe('#7 带分叉点的排队命令恢复后不钉回原会话', () => {
  const stored = (forkFrom: StoredSendCommand['forkFrom']): StoredSendCommand => ({
    content: '改一下再跑',
    options: {},
    images: [],
    imageCount: 0,
    forkFrom,
    hiddenContext: null,
  } as unknown as StoredSendCommand);

  it('有 forkFrom → sessionId 为空(由投递路径新开一支);没有 → 照旧钉在原会话', () => {
    const forked = fromStoredCommand(stored({ parentSessionId: 'S', parentMessageId: 'm1' } as never), { sessionKey: 'S', sessionId: 'S', projectId: 'P' });
    expect(forked.command.sessionId).toBeNull();
    expect(forked.command.sessionKey).toBe('S');
    const plain = fromStoredCommand(stored(null), { sessionKey: 'S', sessionId: 'S', projectId: 'P' });
    expect(plain.command.sessionId).toBe('S');
  });
});

describe('#23 / #24 outbox 单槽位不丢东西', () => {
  const composer = read('../hooks/useChatComposerState.ts');

  it('#23A:并进一条 needs_attachment 的记录,结果仍是 needs_attachment', () => {
    expect(composer).toMatch(/const keepWaitingForAttachment = !initial && existing\?\.status === 'needs_attachment';/);
    expect(composer).toMatch(/: keepWaitingForAttachment\s*\n\s*\? \{ command: merged, status: 'needs_attachment' as const, error: existing!\.error, attempts: 0 \}/);
  });

  it('#23B:已有一条 **queued** 在等时,新的一句并进去由冲队发,不直接发(否则 markCommandSent 覆盖掉它)', () => {
    const at = composer.indexOf("if (outboxRef.current?.status === 'queued' && queuedDraftSessionRef.current === submitSessionKey) {");
    expect(at).toBeGreaterThan(0);
    expect(composer.slice(at, at + 300)).toMatch(/enqueueCommand\(dispatchable, submitSessionKey\);[\s\S]{0,120}return;/);
    // 在直接投递之前
    expect(at).toBeLessThan(composer.indexOf('const result = await dispatchSendCommandRef.current(dispatchable);'));
    // gi 自查:**不能**把 needs_attachment 也算进去 —— 那条永远发不出去,回车会被一直吞
    expect(composer).not.toMatch(/if \(isPendingSend\(outboxRef\.current\) && queuedDraftSessionRef\.current === submitSessionKey\) \{/);
  });

  it('gi 自查:直发的消息不覆盖槽位里等图片的那条(也不清它的盘上记录)', () => {
    const at = composer.indexOf('const markCommandSent = useCallback(');
    const body = composer.slice(at, at + 2500);
    expect(body).toMatch(/const parked = outboxRef\.current;\s*\n\s*if \(parked && parked\.status === 'needs_attachment' && parked\.command\.clientMessageId !== command\.clientMessageId\) \{\s*\n\s*return;/);
    // 这一句要在 clearQueuedMessage 之前
    expect(body.indexOf("parked.status === 'needs_attachment'")).toBeLessThan(body.indexOf('if (storageKey) clearQueuedMessage(storageKey);'));
  });

  it('gi 自查:冲队投递之前先标 sending —— 建会话那几百毫秒里用户回车不会并进这条再被覆盖', () => {
    const at = composer.indexOf('const dispatch = () => {');
    // gk 在投递前又加了一段封顶判据,窗口放宽到能盖住 sending 标记与投递两处。
    const body = composer.slice(at, at + 3600);
    expect(body).toMatch(/reduceOutbox\(current, \{ type: 'sending' \}\)/);
    // gk:投递改成 return(锁里 await 到收尾),判据只看"先标 sending 再投递"这个顺序。
    expect(body.indexOf("{ type: 'sending' }")).toBeLessThan(body.indexOf('return dispatchSendCommandRef.current(pending.command)'));
  });

  it('gi 自查:并进去的两条里任一条带分叉点,合并结果也另起一支(sessionId 为空)', () => {
    expect(composer).toMatch(/sessionId: \(command\.forkFrom \?\? existing\.command\.forkFrom\) \? null : command\.sessionId,/);
  });

  it('#24:恢复 effect 不用盘上的空记录抹掉属于这条会话、正在等 ACK 的 sending 条目', () => {
    expect(composer).toMatch(/inFlight && inFlight\.status === 'sending'\s*\n\s*&& \(inFlight\.command\.sessionId === sessionKey \|\| inFlight\.command\.sessionKey === sessionKey\),/);
    expect(composer).toMatch(/if \(!stored && inFlightBelongsHere\) \{\s*\n\s*return;/);
  });
});

describe('#14 「回到底部」在全部已加载时第一次点就有效', () => {
  const state = read('../hooks/useChatSessionState.ts');

  it('砍窗口之前先打开跟底分支,并置一次性强制标记', () => {
    const at = state.indexOf('const scrollToBottomAndReset = useCallback(() => {');
    const body = state.slice(at, at + 1400);
    expect(body).toMatch(/if \(allMessagesLoaded\) \{[\s\S]{0,700}followBottomRef\.current = true;\s*\n\s*forceFollowBottomOnceRef\.current = true;\s*\n\s*setIsUserScrolledUp\(false\);\s*\n\s*setVisibleMessageCount\(INITIAL_VISIBLE_MESSAGES\);/);
  });

  it('gi 自查:控制器里强制标记优先于 userMoved —— 锚点是旧的时 userMoved 必真,否则刚置的跟底又被算回假', () => {
    expect(state).toMatch(/if \(forceFollowBottomOnceRef\.current\) \{\s*\n\s*forceFollowBottomOnceRef\.current = false;\s*\n\s*followBottomRef\.current = true;\s*\n\s*\} else if \(userMoved\) \{/);
  });
});

describe('gi 自查:「最后一条」跳过回执行', () => {
  it('ChatMessagesPane 的 lastItem 从尾部往前找第一条不是 isTaskNotification 的', () => {
    const pane = read('../view/subcomponents/ChatMessagesPane.tsx');
    expect(pane).toMatch(/let lastItem = groupedVisibleMessages\[groupedVisibleMessages\.length - 1\];\s*\n\s*for \(let i = groupedVisibleMessages\.length - 1; i >= 0; i -= 1\) \{[\s\S]{0,200}isTaskNotification\) continue;/);
  });
});

describe('gi 自查:排队卡的占位按 redacted 走,不按空串', () => {
  it('ChatComposer:redacted → 别人的;否则空正文 → 仅图片', () => {
    const composerView = read('../view/subcomponents/ChatComposer.tsx');
    expect(composerView).toMatch(/content=\{serverQueued\.redacted\s*\n\s*\? t\('input\.queue\.othersPreview'/);
    expect(composerView).toMatch(/serverQueued\.preview \|\| t\('input\.queue\.imageOnly'/);
  });
});
