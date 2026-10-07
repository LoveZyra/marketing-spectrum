import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  SENT_CLIENT_MESSAGE_IDS_STORAGE_KEY,
  chatSendClientMessageId,
  createSentClientMessageIds,
  rememberSentClientMessageId,
} from './sentClientMessageIds';

/**
 * 这个标签页发出过哪些 `chat.send`(按幂等键记)。
 *
 * 排队被中止时服务端会把正文退回给排它的那个人的所有连接;只有真正发出这条消息的标签页
 * 才该把正文填回输入框。所有 `chat.send` 都从 WebSocketContext 的 `sendMessage` 出去,在那里记。
 */
describe('chatSendClientMessageId', () => {
  it('只认 chat.send 帧上的字符串幂等键', () => {
    expect(chatSendClientMessageId({ type: 'chat.send', clientMessageId: 'c1', content: 'x' })).toBe('c1');
    expect(chatSendClientMessageId({ type: 'chat.subscribe', clientMessageId: 'c1' })).toBeNull();
    expect(chatSendClientMessageId({ type: 'chat.send' })).toBeNull();
    expect(chatSendClientMessageId({ type: 'chat.send', clientMessageId: '' })).toBeNull();
    expect(chatSendClientMessageId(null)).toBeNull();
    expect(chatSendClientMessageId('chat.send')).toBeNull();
  });
});

describe('rememberSentClientMessageId', () => {
  it('记下来,封顶时丢最旧的', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 5; i += 1) rememberSentClientMessageId(ids, `c${i}`, 3);
    expect([...ids]).toEqual(['c2', 'c3', 'c4']);
  });

  it('同一个键重投一次就挪到最新,不会因为发得早被先挤掉', () => {
    const ids = new Set<string>(['a', 'b', 'c']);
    rememberSentClientMessageId(ids, 'a', 3);
    rememberSentClientMessageId(ids, 'd', 3);
    expect([...ids]).toEqual(['c', 'a', 'd']);
  });
});

/** 一个只活在内存里的 sessionStorage 替身。 */
const memoryStorage = () => {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    raw: map,
  };
};

const send = (clientMessageId: string) => ({ type: 'chat.send', clientMessageId, content: 'x' });

describe('createSentClientMessageIds', () => {
  it('只记送出去的 chat.send;别的帧不记', () => {
    const sent = createSentClientMessageIds(memoryStorage());
    sent.noteSent(send('c1'));
    sent.noteSent({ type: 'chat.subscribe', sessions: [] });
    expect(sent.has('c1')).toBe(true);
    expect(sent.has('c2')).toBe(false);
  });

  it('刷新之后还认得:同一个标签页的 sessionStorage 里读回来', () => {
    const storage = memoryStorage();
    createSentClientMessageIds(storage).noteSent(send('c1'));
    const afterReload = createSentClientMessageIds(storage);
    expect(afterReload.has('c1')).toBe(true);
  });

  it('封顶照旧:内存与存储里都只留最近的那些', () => {
    const storage = memoryStorage();
    const sent = createSentClientMessageIds(storage, 3);
    for (let i = 0; i < 5; i += 1) sent.noteSent(send(`c${i}`));
    expect(JSON.parse(storage.raw.get(SENT_CLIENT_MESSAGE_IDS_STORAGE_KEY) ?? '[]')).toEqual(['c2', 'c3', 'c4']);
    const afterReload = createSentClientMessageIds(storage, 3);
    expect(['c0', 'c1', 'c2', 'c3', 'c4'].map((id) => afterReload.has(id))).toEqual([false, false, true, true, true]);
  });

  it('存储不可用(读写都抛)时退回只记在内存', () => {
    const broken = {
      getItem: () => { throw new Error('SecurityError'); },
      setItem: () => { throw new Error('QuotaExceededError'); },
    };
    const sent = createSentClientMessageIds(broken);
    sent.noteSent(send('c1'));
    expect(sent.has('c1')).toBe(true);
    expect(createSentClientMessageIds(null).has('c1')).toBe(false);
  });

  it('存储里的内容坏了就从空集开始', () => {
    const storage = memoryStorage();
    storage.setItem(SENT_CLIENT_MESSAGE_IDS_STORAGE_KEY, '{oops');
    expect(createSentClientMessageIds(storage).has('c1')).toBe(false);
    storage.setItem(SENT_CLIENT_MESSAGE_IDS_STORAGE_KEY, JSON.stringify(['c1', 42, '']));
    expect(createSentClientMessageIds(storage).has('c1')).toBe(true);
  });
});

describe('sendMessage 的接线', () => {
  const source = readFileSync(fileURLToPath(new URL('./WebSocketContext.tsx', import.meta.url)), 'utf8');

  it('真的送出去之后才记(没送出去的,服务端不会有任何帧提到它)', () => {
    const sendBody = source.slice(source.indexOf('const sendMessage = useCallback'));
    const sent = sendBody.indexOf('socket.send(JSON.stringify(message));');
    const remember = sendBody.indexOf('sentClientMessageIds.noteSent(message);');
    expect(sent).toBeGreaterThan(0);
    expect(remember).toBeGreaterThan(sent);
    expect(remember).toBeLessThan(sendBody.indexOf('return true;'));
  });

  it('wasSentHere 进了 context 的值', () => {
    expect(source).toMatch(/\(\{ sendMessage, subscribe, isConnected, wasSentHere \}\)/);
  });
});
