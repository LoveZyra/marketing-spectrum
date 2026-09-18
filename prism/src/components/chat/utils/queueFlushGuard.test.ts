import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { FLUSH_MAX_ATTEMPTS, flushAttemptAllowed, reconcileWithStorageEvent, shouldDispatchClaimed, shouldEchoOnce, shouldRestoreStored } from './queueFlushGuard';

/**
 * gk:排队冲队的判据 —— 对应 2026-09-15 测试环境的三个症状:
 * 取消了照样发出去;同一条命令投了四遍(四个气泡);回复之后多出来的消失。
 */
describe('shouldDispatchClaimed', () => {
  const retired = new Set<string>();

  it('没认领到 → 不投(键已经没了或别的标签页抢走)', () => {
    expect(shouldDispatchClaimed(null, 'cmd_a', retired)).toBe('drop');
  });

  it('认领到的是同一条 → 投', () => {
    expect(shouldDispatchClaimed({ clientMessageId: 'cmd_a' }, 'cmd_a', retired)).toBe('dispatch');
    // 老记录没有幂等键:只能信内存那条
    expect(shouldDispatchClaimed({}, 'cmd_a', retired)).toBe('dispatch');
  });

  it('盘上已经换成另一条 → 不投内存这条,按盘上重装(即使内存那条已作废也先判这个)', () => {
    expect(shouldDispatchClaimed({ clientMessageId: 'cmd_b' }, 'cmd_a', retired)).toBe('resync');
    expect(shouldDispatchClaimed({ clientMessageId: 'cmd_b' }, 'cmd_a', new Set(['cmd_a']))).toBe('resync');
  });

  it('这条已经被取消过 → 不投(这就是"取消了还发出去"的判据)', () => {
    expect(shouldDispatchClaimed({ clientMessageId: 'cmd_a' }, 'cmd_a', new Set(['cmd_a']))).toBe('drop');
  });
});

describe('shouldRestoreStored', () => {
  it('发过的、取消过的都不许回到待发;别的照常', () => {
    expect(shouldRestoreStored('cmd_a', new Set(['cmd_a']), new Set())).toBe(false);
    expect(shouldRestoreStored('cmd_a', new Set(), new Set(['cmd_a']))).toBe(false);
    expect(shouldRestoreStored('cmd_b', new Set(['cmd_a']), new Set(['cmd_c']))).toBe(true);
    expect(shouldRestoreStored(undefined, new Set(['cmd_a']), new Set())).toBe(true);
  });
});

describe('reconcileWithStorageEvent(跨标签页)', () => {
  it('别的标签页删了盘上那条,而这边同一条还在等着发 → 撤', () => {
    expect(reconcileWithStorageEvent('cmd_a', true, null, true)).toBe('drop');
  });
  it('盘上换成另一条 → 重装;同一条被盖了认领戳 → 不动;这边没有在等的 → 不动', () => {
    expect(reconcileWithStorageEvent('cmd_a', true, 'cmd_b', false)).toBe('resync');
    expect(reconcileWithStorageEvent('cmd_a', true, 'cmd_a', false)).toBe('keep');
    expect(reconcileWithStorageEvent('cmd_a', false, null, true)).toBe('keep');
    expect(reconcileWithStorageEvent(null, true, null, true)).toBe('keep');
  });
});

describe('flushAttemptAllowed', () => {
  it('同一条一分钟内最多 5 次;换一条从头数;窗口过了从头数', () => {
    const attempts = new Map<string, { count: number; firstAt: number }>();
    const t0 = 1_000_000;
    for (let i = 0; i < FLUSH_MAX_ATTEMPTS; i += 1) expect(flushAttemptAllowed(attempts, 'cmd_a', t0 + i)).toBe(true);
    expect(flushAttemptAllowed(attempts, 'cmd_a', t0 + 10)).toBe(false);
    expect(flushAttemptAllowed(attempts, 'cmd_b', t0 + 11)).toBe(true);
    expect(flushAttemptAllowed(attempts, 'cmd_a', t0 + 61_000)).toBe(true);
  });
});

describe('shouldEchoOnce', () => {
  it('同一个幂等键第二次不再画气泡', () => {
    const echoed = new Set<string>();
    expect(shouldEchoOnce(echoed, 'cmd_a')).toBe(true);
    expect(shouldEchoOnce(echoed, 'cmd_a')).toBe(false);
    expect(shouldEchoOnce(echoed, 'cmd_b')).toBe(true);
  });
});

const composer = readFileSync(fileURLToPath(new URL('../hooks/useChatComposerState.ts', import.meta.url)), 'utf8');

describe('接线(读源码钉住)', () => {
  it('取消 / 编辑 / 停止并回 三处都当场作废这条命令(清盘 + 记幂等键)', () => {
    expect(composer).toMatch(/const deleteQueuedDraft = useCallback\(\(\) => \{\s*\n\s*retireQueuedCommand\(outboxRef\.current\);/);
    expect(composer).toMatch(/const editQueuedDraft = useCallback\(\(\) => \{[\s\S]*?retireQueuedCommand\(entry\);/);
    expect(composer).toMatch(/const queuedImageCount = queuedDraft\.imageCount;\s*\n\s*retireQueuedCommand\(outboxRef\.current\);/);
    expect(composer).toMatch(/retiredClientMessageIdsRef\.current\.add\(entry\.command\.clientMessageId\);/);
  });

  it('冲队:同一条命令自动投递封顶,超了退回输入框', () => {
    expect(composer).toMatch(/if \(!flushAttemptAllowed\(flushAttemptsRef\.current, pending\.command\.clientMessageId, Date\.now\(\)\)\) \{/);
  });

  it('冲队:锁里 await 投递,认领到的先与内存那条比对', () => {
    expect(composer).toMatch(/void runExclusive\(queueLockName\(sessionKey\), async \(\) => \{\s*\n\s*const claimed = claimQueuedMessage\(sessionKey\)/);
    expect(composer).toMatch(/const verdict = shouldDispatchClaimed\(claimed, pending\.command\.clientMessageId, retiredClientMessageIdsRef\.current\);/);
    expect(composer).toMatch(/await dispatch\(\);/);
    expect(composer).toMatch(/return dispatchSendCommandRef\.current\(pending\.command\)\.then/);
  });

  it('回声按幂等键只画一次;恢复时拒绝已发过 / 已取消的;ACK 身份改读 ref', () => {
    expect(composer).toMatch(/if \(shouldEchoOnce\(echoedClientMessageIdsRef\.current, target\.clientMessageId\)\) \{\s*\n\s*addMessage\(\{/);
    expect(composer).toMatch(/if \(!shouldRestoreStored\(stored\?\.clientMessageId, dispatchedClientMessageIdsRef\.current, retiredClientMessageIdsRef\.current\)\) \{/);
    expect(composer).toMatch(/const acknowledged = Boolean\(current && current\.command\.clientMessageId === clientMessageId\);/);
  });

  /**
   * ACK 清盘要**回读一次**才清。
   *
   * 内存判的是"我这条被确认了",盘上删的却是"这个会话的排队记录" —— 两个标签页
   * 开同一个会话时,B 排进去的新消息就躺在那个键上,而 A 这边旧命令的第二次 accepted
   * (排队收下一次、续发跑起来又一次)一到就把 B 从盘上删掉。这正是 fz 修过的那个坑。
   */
  it('ACK 清盘:盘上不是同一个幂等键就不清', () => {
    expect(composer).toMatch(/const stored = readQueuedMessage\(ackSessionId\) as StoredSendCommand \| null;\s*\n\s*if \(!stored \|\| !stored\.clientMessageId \|\| stored\.clientMessageId === clientMessageId\) \{\s*\n\s*clearQueuedMessage\(ackSessionId\);/);
  });

  it('跨标签页:监听 storage 事件对齐盘上那份', () => {
    expect(composer).toMatch(/window\.addEventListener\('storage', onStorage\);/);
    expect(composer).toMatch(/const verdict = reconcileWithStorageEvent\(/);
  });

  /**
   * 被挤掉 / 被别处撤掉的那条,**正文要退回输入框**。
   * 排队槽一个会话只有一个,两个标签页各排一句时后写的覆盖先写的 ——
   * 先写的那句若连提示都没有,用户看到的就是"我明明排了一条,它自己没了"。
   */
  it('跨标签页 drop / resync,以及投递封顶:三处都把正文退回输入框', () => {
    const returns = composer.match(/returnQueuedTextToInput\(/g) ?? [];
    expect(returns.length).toBeGreaterThanOrEqual(3);
    expect(composer).toMatch(/const merged = mergeQueuedIntoInput\(text, inputValueRef\.current\);/);
    // 封顶那条路也要说清图片退不回来(与「编辑排队草稿」同一口径)
    expect(composer).toMatch(/const abandonedImages = pending\.command\.images\.length;/);
  });

  /** 这几个集合按 mount 活着,页面开一整天会一直涨 —— 插入处都封了顶。 */
  it('记幂等键的集合有容量上限', () => {
    expect(composer).toMatch(/function boundIdSet\(ids: Set<string>, max: number = MAX_TRACKED_IDS\)/);
    expect((composer.match(/boundIdSet\(/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(composer).toMatch(/boundAttemptMap\(flushAttemptsRef\.current\);/);
  });
});
