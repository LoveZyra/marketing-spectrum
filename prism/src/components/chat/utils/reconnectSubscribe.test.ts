import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { reconnectSubscribeTargets, resubscribeAfterReconnect } from './reconnectSubscribe';

/**
 * 断线重连后的补订。
 *
 * 在会话 A 里起一个长回合,回到项目首页 / 点「新建会话」(没有选中会话),这时 WebSocket 重连:
 * 新 socket 对 A 不是 viewer,不补订就收不到 A 的实时帧和 complete,完成提示不响。
 */
describe('reconnectSubscribeTargets', () => {
  const cursors = new Map([['A', { runId: 'r1', seq: 41 }]]);
  const cursorOf = (sessionId: string) => cursors.get(sessionId);

  it('停在首页 / 新会话页(没有正在看的会话):后台在跑的照样补订', () => {
    expect(reconnectSubscribeTargets(null, ['A', 'B'], cursorOf)).toEqual([
      { sessionId: 'A', lastSeq: 41, lastRunId: 'r1' },
      { sessionId: 'B', lastSeq: 0, lastRunId: null },
    ]);
  });

  it('正在看的那条排在最前,与在跑的重复时只订一次', () => {
    expect(reconnectSubscribeTargets('B', ['A', 'B'], cursorOf).map((t) => t.sessionId)).toEqual(['B', 'A']);
  });

  it('什么都没有就是空的', () => {
    expect(reconnectSubscribeTargets(null, [], cursorOf)).toEqual([]);
  });
});

describe('resubscribeAfterReconnect', () => {
  const cursors = new Map([['A', { runId: 'r1', seq: 41 }]]);

  function run(viewedSessionId: string | null, processing: string[], options: { delivered?: boolean } = {}) {
    const log: string[] = [];
    const sent: unknown[] = [];
    const marked: Array<[string, number]> = [];
    let finishRefresh: () => void = () => {};
    const done = resubscribeAfterReconnect({
      viewedSessionId,
      processingSessionIds: processing,
      cursorOf: (sessionId) => cursors.get(sessionId),
      sendMessage: (message) => {
        log.push('subscribe');
        sent.push(message);
        return options.delivered ?? true;
      },
      markSubscribed: (sessionId, at) => { marked.push([sessionId, at]); },
      refresh: (sessionId) => {
        log.push(`refresh:${sessionId}`);
        return new Promise<void>((resolve) => { finishRefresh = resolve; });
      },
      now: () => 1_000,
    });
    return { done, log, sent, marked, finishRefresh: () => finishRefresh() };
  }

  it('先发 chat.subscribe,再补拉正在看的那条;订阅不等补拉的往返', async () => {
    const reconnect = run('B', ['A']);
    // 补拉还没回来,订阅已经发出去了
    expect(reconnect.log).toEqual(['subscribe', 'refresh:B']);
    expect(reconnect.sent).toEqual([{
      type: 'chat.subscribe',
      sessions: [
        { sessionId: 'B', lastSeq: 0, lastRunId: null },
        { sessionId: 'A', lastSeq: 41, lastRunId: 'r1' },
      ],
    }]);
    expect(reconnect.marked).toEqual([['B', 1_000], ['A', 1_000]]);
    reconnect.finishRefresh();
    await reconnect.done;
  });

  it('停在首页 / 新会话页(没有正在看的会话):后台在跑的照样补订,不补拉', async () => {
    const reconnect = run(null, ['A']);
    await reconnect.done;
    expect(reconnect.log).toEqual(['subscribe']);
    expect(reconnect.sent).toEqual([{ type: 'chat.subscribe', sessions: [{ sessionId: 'A', lastSeq: 41, lastRunId: 'r1' }] }]);
  });

  it('订阅没送出去:不记发送时刻(否则在等一个不会来的回执),正在看的照样补拉', async () => {
    const reconnect = run('B', [], { delivered: false });
    expect(reconnect.marked).toEqual([]);
    expect(reconnect.log).toEqual(['subscribe', 'refresh:B']);
    reconnect.finishRefresh();
    await reconnect.done;
  });

  it('什么都没在跑、也没在看:不发空订阅', async () => {
    const reconnect = run(null, []);
    await reconnect.done;
    expect(reconnect.log).toEqual([]);
  });
});

describe('handleWebSocketReconnect 的接线', () => {
  const source = readFileSync(fileURLToPath(new URL('../view/ChatInterface.tsx', import.meta.url)), 'utf8');

  // 顺序与范围由上面的 resubscribeAfterReconnect 用例钉住;ChatInterface 只负责把 ref 接进去
  it('ChatInterface 的重连回调交给 resubscribeAfterReconnect,并挂到实时处理器上', () => {
    expect(source).toMatch(/const handleWebSocketReconnect = useCallback\(\(\) => resubscribeAfterReconnect\(\{/);
    expect(source).toMatch(/onWebSocketReconnect: handleWebSocketReconnect,/);
  });
});
