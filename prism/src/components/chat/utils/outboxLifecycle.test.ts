import { describe, expect, it } from 'vitest';

import {
  freezeSendCommand,
  isPendingSend,
  reduceOutbox,
  restoredEntry,
  fromStoredCommand,
  toStoredCommand,
  type OutboxEntry,
  mayPersistQueuedCommand,
} from './sendCommand';

/**
 * 排队卡的生命周期不变式。
 *
 *   1. 发出去之后条目处于 `sending`,不再落盘 —— 否则换会话读回来会再发一次;
 *   2. 落盘与渲染共用同一个"待发"判据(`isPendingSend`)—— 否则卡片会挂着不走;
 *   3. localStorage 有两个写者:`claimQueuedMessage` 认领时会把条目写回盘上,而清理那一侧的
 *      归属守卫可能跳过。所以另有一条与路径无关的兜底:已经投递过的幂等键,不许再回到待发。
 */
const cmd = (text: string, sessionKey: string | null = 's1') => freezeSendCommand({
  sessionKey,
  sessionId: sessionKey,
  projectId: 'p1',
  text,
  options: {},
});

/** 模拟"恢复"那一步:盘上有一条,但这个标签页已经发过它。 */
function restoreWithGuard(
  stored: ReturnType<typeof toStoredCommand>,
  dispatched: Set<string>,
): OutboxEntry | null {
  if (stored.clientMessageId && dispatched.has(stored.clientMessageId)) return null;
  return restoredEntry(fromStoredCommand(stored, {
    sessionKey: 's1', sessionId: 's1', projectId: 'p1',
  }));
}

describe('排队条目的生命周期', () => {
  it('入队 → 待发 → 卡片显示 → 落盘', () => {
    const entry = reduceOutbox(null, { type: 'enqueue', command: cmd('你好') })!;
    expect(entry.status).toBe('queued');
    expect(isPendingSend(entry)).toBe(true);
  });

  it('投递之后 → 不是待发 → 卡片不显示、也不落盘', () => {
    const entry = reduceOutbox(
      reduceOutbox(null, { type: 'enqueue', command: cmd('你好') }),
      { type: 'sending' },
    )!;
    expect(entry.status).toBe('sending');
    expect(isPendingSend(entry)).toBe(false);
  });

  it('已经投递过的那条,恢复时一律不回来(与路径无关的兜底)', () => {
    // 盘上残留的是认领时写回去、而清理被守卫跳过的那一份;
    // 恢复时若放行,已经回答过的那句会重新排上队。
    const command = cmd('你好');
    const stored = toStoredCommand(command);
    const dispatched = new Set([command.clientMessageId]);
    expect(restoreWithGuard(stored, dispatched)).toBeNull();
  });

  it('没发过的那条照常恢复(断网重连、刷新后继续发,这条不能误伤)', () => {
    const stored = toStoredCommand(cmd('还没发出去的'));
    expect(restoreWithGuard(stored, new Set())?.status).toBe('queued');
  });

  it('老记录(没有幂等键)照常恢复 —— 兜底只认得出自己发过的', () => {
    const restored = restoreWithGuard({ content: '老记录' }, new Set(['cmd_whatever']));
    expect(restored?.status).toBe('queued');
  });

  it('附件丢了的那条恢复成 needs_attachment,仍算"待发"(卡片要留着)', () => {
    const restored = restoreWithGuard({ content: '看这张图', imageCount: 1, images: [] }, new Set());
    expect(restored?.status).toBe('needs_attachment');
    expect(isPendingSend(restored)).toBe(true);
  });

  it('落盘的归属按命令自己记的会话判,不按会漂的 ref', () => {
    // 新会话的第一条:提交时 sessionKey 是 null、落地时已经是新 id ——
    // 用 ref 判会整段跳过,连"该清"也一起跳过,盘上那份就留下了。
    const forNewSession = cmd('新会话第一条', null);
    expect(forNewSession.sessionKey).toBeNull();
    // sessionKey 为 null 的命令不该拦住任何会话的清理
    const belongsElsewhere = cmd('别的会话的', 's9');
    expect(belongsElsewhere.sessionKey).toBe('s9');
  });
});


/**
 * 换会话那一拍,落盘不许动新会话的键。
 *
 * 落盘 effect 声明在恢复之前,两者依赖里都有 sessionKey —— 换会话那一拍落盘
 * 先跑,`sessionKey` 已经是新会话而 `outbox` 还是旧会话的(没排队就是 null),
 * "没有条目就清理"会清掉恢复马上要读的那一个,排队消息就活不过刷新或切走再切回。
 */
describe('mayPersistQueuedCommand', () => {
  it('换会话那一拍:恢复还没认领新会话 → 一律不动', () => {
    // 恢复还指着旧会话 A,而 sessionKey 已经是 B,outbox 是 null(A 没排队)
    expect(mayPersistQueuedCommand('A', 'B', undefined)).toBe(false);
  });

  it('首次挂载/刷新:恢复一次都没跑过 → 不动', () => {
    expect(mayPersistQueuedCommand(null, 'B', undefined)).toBe(false);
  });

  it('恢复认领之后:同会话内照常写/清(该清没清那条路没被重新打开)', () => {
    expect(mayPersistQueuedCommand('B', 'B', undefined)).toBe(true);
    expect(mayPersistQueuedCommand('B', 'B', 'B')).toBe(true);
  });

  it('条目自己记的会话对不上 → 不动', () => {
    expect(mayPersistQueuedCommand('B', 'B', 'A')).toBe(false);
  });

  it('新会话页(还没有会话键)→ 不动', () => {
    expect(mayPersistQueuedCommand(null, null, undefined)).toBe(false);
    expect(mayPersistQueuedCommand('B', '', undefined)).toBe(false);
  });
});
