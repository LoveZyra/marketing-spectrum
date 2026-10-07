import assert from 'node:assert/strict';

import { beforeEach, describe, test, vi } from 'vitest';

/**
 * 回合失败通知里的那句原因:有中文说明(`prismUserMessage`)就用它,与聊天里那条一致;
 * 英文内部原文只进服务端日志。去重键也按这句算。
 *
 * 投递通道换成一个记账的假通道(真的 webhook 要发 HTTP)。
 */
const sent = [];

vi.mock('@/modules/notifications/services/webhook-channel.service.js', () => ({
  webhookChannel: {
    id: 'test-channel',
    isEnabled: () => true,
    send: (delivery) => { sent.push(delivery); },
  },
}));

vi.mock('@/modules/database/index.js', () => ({
  notificationPreferencesDb: { getPreferences: () => ({ events: { actionRequired: true, stop: true, error: true } }) },
  sessionsDb: { getSessionById: () => null, getSessionByProviderSessionId: () => null, getSessionName: () => null },
}));

const { notifyRunFailed } = await import('@/modules/notifications/services/notification-orchestrator.service.js');

/** 造一个 claude-sdk 那种带中文说明的内部错误(见 describeForUser)。 */
function describedError(message, code, userMessage) {
  return Object.assign(new Error(message), { code, prismUserMessage: userMessage });
}

let sessionCounter = 0;
const nextSessionId = () => {
  sessionCounter += 1;
  return `session-run-failed-${sessionCounter}`;
};

beforeEach(() => {
  sent.length = 0;
});

describe('回合失败通知的原因', () => {
  test('带中文说明的内部错误:通知里是中文说明,不是英文原文', () => {
    const error = describedError(
      'Claude turn produced no output for 600s; the session runtime was restarted',
      'TURN_IDLE_TIMEOUT',
      '这一轮超过 10 分钟没有任何输出,已结束这一轮并重启这段对话的 CLI。直接再发一条即可接着聊。',
    );
    notifyRunFailed({ userId: 7, provider: 'claude', sessionId: nextSessionId(), error });

    assert.equal(sent.length, 1);
    const [delivery] = sent;
    assert.equal(delivery.event.meta.error, error.prismUserMessage);
    assert.match(delivery.payload.body, /超过 10 分钟没有任何输出/);
    assert.doesNotMatch(delivery.payload.body, /produced no output/);
    assert.match(delivery.event.dedupeKey, /超过 10 分钟没有任何输出/, '去重键按中文说明算');
  });

  test('同一件事连报两次:按中文说明去重,只发一次', () => {
    const sessionId = nextSessionId();
    const first = describedError('Claude SDK runtime ended unexpectedly (code 1)', 'RUNTIME_GONE', '这段对话的 CLI 意外退出了。直接再发一条即可接着聊。');
    const second = describedError('Claude SDK runtime ended unexpectedly (code 137)', 'RUNTIME_GONE', '这段对话的 CLI 意外退出了。直接再发一条即可接着聊。');
    notifyRunFailed({ userId: 7, provider: 'claude', sessionId, error: first });
    notifyRunFailed({ userId: 7, provider: 'claude', sessionId, error: second });
    assert.equal(sent.length, 1);
  });

  test('没有中文说明的错误(CLI / 网关原样报出来的)与字符串:照旧用原文', () => {
    notifyRunFailed({ userId: 7, provider: 'claude', sessionId: nextSessionId(), error: new Error('API Error: 529 overloaded') });
    notifyRunFailed({ userId: 7, provider: 'system', sessionId: nextSessionId(), error: '定时任务「周报」执行失败:网关 500' });
    notifyRunFailed({ userId: 7, provider: 'claude', sessionId: nextSessionId(), error: Object.assign(new Error('raw text'), { prismUserMessage: '  ' }) });
    assert.deepEqual(sent.map((delivery) => delivery.event.meta.error), [
      'API Error: 529 overloaded',
      '定时任务「周报」执行失败:网关 500',
      'raw text',
    ]);
  });
});
