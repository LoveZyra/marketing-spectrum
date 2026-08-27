import assert from 'node:assert/strict';

import { describe, expect, test, vi } from 'vitest';

/**
 * E11:通知编排现在是**零通道**的。
 *
 * 服务端推送通道(Web Push / Electron)随 web-only 重构一起去掉了,在应用内的
 * 提示改成前端从 chat websocket 自己驱动。留下来的编排代码于是变成一根死管道:
 * 每个 permission_request / run.stopped / run.failed 都照样归一化会话 id、读用户
 * 偏好、算 payload —— 最多五次查询,然后交给一个空数组。权限请求在一轮里能出现
 * 几十次,这些查询全是白扔。
 *
 * 这个测试钉的就是"零通道时一次库都不查"。哪天真接上通道(F6 那批),把它 push
 * 进 notificationChannels 之后这条会红 —— 那时候把它改成"接了通道就该查库"的
 * 断言,而不是悄悄删掉。
 */
const getPreferences = vi.fn(() => ({ events: { actionRequired: true, stop: true, error: true } }));
const getSessionById = vi.fn(() => null);
const getSessionByProviderSessionId = vi.fn(() => null);
const getSessionName = vi.fn(() => null);

vi.mock('@/modules/database/index.js', () => ({
  notificationPreferencesDb: { getPreferences },
  sessionsDb: { getSessionById, getSessionByProviderSessionId, getSessionName },
}));

const {
  createNotificationEvent,
  notifyRunFailed,
  notifyRunStopped,
  notifyUserIfEnabled,
} = await import('@/modules/notifications/services/notification-orchestrator.service.js');

const dbCalls = () =>
  getPreferences.mock.calls.length
  + getSessionById.mock.calls.length
  + getSessionByProviderSessionId.mock.calls.length
  + getSessionName.mock.calls.length;

describe('零通道时通知编排不做任何工作', () => {
  test('三种事件都不读偏好、不查会话', () => {
    notifyUserIfEnabled({
      userId: 7,
      event: createNotificationEvent({
        provider: 'claude',
        sessionId: 'session-1',
        kind: 'action_required',
        code: 'permission.required',
        meta: { toolName: 'Bash' },
      }),
    });
    notifyRunStopped({ userId: 7, provider: 'claude', sessionId: 'session-1' });
    notifyRunFailed({ userId: 7, provider: 'claude', sessionId: 'session-1', error: new Error('boom') });

    assert.equal(dbCalls(), 0, '零通道时不该有任何一次数据库查询');
  });

  test('缺 userId / 缺 event 也一样安静', () => {
    notifyUserIfEnabled({ userId: null, event: createNotificationEvent({ provider: 'claude' }) });
    notifyUserIfEnabled({ userId: 7, event: null });

    assert.equal(dbCalls(), 0);
  });

  test('createNotificationEvent 仍是纯构造:不查库,字段原样带上', () => {
    const event = createNotificationEvent({
      provider: 'claude',
      sessionId: 'session-9',
      kind: 'stop',
      code: 'run.stopped',
      meta: { stopReason: 'completed' },
      dedupeKey: 'k',
    });

    assert.equal(event.provider, 'claude');
    assert.equal(event.sessionId, 'session-9');
    assert.equal(event.code, 'run.stopped');
    assert.equal(event.meta.stopReason, 'completed');
    assert.equal(event.dedupeKey, 'k');
    assert.ok(typeof event.createdAt === 'string' && event.createdAt.length > 0);
    expect(dbCalls()).toBe(0);
  });
});
