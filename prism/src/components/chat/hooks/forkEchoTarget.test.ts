import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { upsertRealtimeRows, type NormalizedMessage } from '../../../stores/useSessionStore';
import type { ChatMessage } from '../types/types';

import { chatMessageToNormalized, localMessageTargetSession } from './useChatSessionState';

/**
 * 编辑重跑的本地回声要落进刚建的分支会话,不是发起时还在看的原会话。
 *
 * 编辑重跑先建一条新会话再发 `chat.send`,而 `addMessage` 的闭包里还是原会话。按闭包落的话,
 * 改过的那句会追加进原会话的末尾:服务端那边永远不会有这条,刷新也剪不掉,只有 F5 才消失;
 * 若原会话随后继续对话,这条幽灵气泡还会参与回合序号计数。
 */
describe('localMessageTargetSession', () => {
  it('调用方给了会话就用它', () => {
    expect(localMessageTargetSession('branch', 'origin')).toBe('branch');
  });

  it('没给就落进正在看的那条', () => {
    expect(localMessageTargetSession(undefined, 'origin')).toBe('origin');
    expect(localMessageTargetSession(null, 'origin')).toBe('origin');
  });

  it('两者都没有(新会话页还没有 id)→ null,由调用方先暂存', () => {
    expect(localMessageTargetSession(null, null)).toBeNull();
  });
});

describe('分叉发送后原会话槽位不新增用户行', () => {
  /** 与 addMessage 同一条路:选会话 → chatMessageToNormalized → appendRealtime(upsert)。 */
  const addMessage = (
    slots: Map<string, NormalizedMessage[]>,
    activeSessionId: string,
    msg: ChatMessage,
    sessionId?: string | null,
  ) => {
    const target = localMessageTargetSession(sessionId, activeSessionId);
    if (!target) return;
    const normalized = chatMessageToNormalized(msg, target, 'claude');
    if (normalized) slots.set(target, upsertRealtimeRows(slots.get(target) ?? [], [normalized], target));
  };

  it('回声进分支会话,原会话的 realtime 原样不动', () => {
    const slots = new Map<string, NormalizedMessage[]>([['origin', []]]);
    const echo = { type: 'user', content: '改过的提问', timestamp: new Date(), clientMessageId: 'c1' } as ChatMessage;
    addMessage(slots, 'origin', echo, 'branch');
    expect(slots.get('origin')).toEqual([]);
    expect(slots.get('branch')?.map((row) => row.content)).toEqual(['改过的提问']);
    expect(slots.get('branch')?.[0].clientMessageId).toBe('c1');
  });
});

describe('回声打戳时还没有时钟样本的标记', () => {
  it('chatMessageToNormalized 把 clockUnsynced 带进 store 那一行;没标就不带', () => {
    const base = { type: 'user', content: '问一句', timestamp: new Date(), clientMessageId: 'c1' } as ChatMessage;
    expect(chatMessageToNormalized({ ...base, clockUnsynced: true }, 's1', 'claude')?.clockUnsynced).toBe(true);
    expect(chatMessageToNormalized(base, 's1', 'claude')).not.toHaveProperty('clockUnsynced');
  });
});

describe('接线', () => {
  const composer = readFileSync(fileURLToPath(new URL('./useChatComposerState.ts', import.meta.url)), 'utf8');
  const sessionState = readFileSync(fileURLToPath(new URL('./useChatSessionState.ts', import.meta.url)), 'utf8');

  it('发送的回声显式落进这条命令发往的会话(target.sessionId,分叉 / 新建时是刚建的那条)', () => {
    const dispatch = composer.slice(composer.indexOf('const dispatchSendCommand = useCallback'));
    const echoCall = dispatch.slice(dispatch.indexOf('addMessage({'), dispatch.indexOf('} else {'));
    expect(echoCall).toMatch(/\}, target\.sessionId\);\s*$/);
  });

  it('回声在还没有时钟样本时标 clockUnsynced', () => {
    const dispatch = composer.slice(composer.indexOf('const dispatchSendCommand = useCallback'));
    const echoCall = dispatch.slice(dispatch.indexOf('addMessage({'), dispatch.indexOf('} else {'));
    expect(echoCall).toMatch(/timestamp: new Date\(serverNow\(\)\),/);
    expect(echoCall).toMatch(/\.\.\.\(hasServerClockSample\(\) \? \{\} : \{ clockUnsynced: true \}\),/);
  });

  it('addMessage 按 localMessageTargetSession 选会话,写进的是选出来的那条', () => {
    const add = sessionState.slice(sessionState.indexOf('const addMessage = useCallback'));
    const body = add.slice(0, add.indexOf('}, [activeSessionId, sessionStore]);'));
    expect(body).toMatch(/const targetSessionId = localMessageTargetSession\(sessionId, activeSessionId\);/);
    expect(body).toMatch(/sessionStore\.appendRealtime\(targetSessionId, normalized\);/);
    expect(body).not.toMatch(/appendRealtime\(activeSessionId/);
  });
});
