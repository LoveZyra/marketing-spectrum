import assert from 'node:assert/strict';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

/**
 * 没有启用的投递通道时,通知编排不做任何工作。
 *
 * 应用内提示由前端从 chat websocket 自己驱动;服务端唯一的通道是 webhook,只在配了
 * PRISM_NOTIFY_WEBHOOK_URL 时启用。没启用时,每个 permission_request / run.stopped /
 * run.failed 若照样归一化会话 id、读用户偏好、算 payload,就是最多五次白扔的查询,
 * 而权限请求在一轮里能出现几十次。
 *
 * 这个测试钉的就是"没有启用的通道时一次库都不查"。webhook 通道每次调用时读环境变量,
 * 所以测试期间自己清掉 PRISM_NOTIFY_WEBHOOK_URL、结束后恢复,不受外部环境影响。
 */
const PREV_WEBHOOK_URL = process.env.PRISM_NOTIFY_WEBHOOK_URL;
beforeAll(() => {
  delete process.env.PRISM_NOTIFY_WEBHOOK_URL;
});
afterAll(() => {
  if (PREV_WEBHOOK_URL === undefined) delete process.env.PRISM_NOTIFY_WEBHOOK_URL;
  else process.env.PRISM_NOTIFY_WEBHOOK_URL = PREV_WEBHOOK_URL;
});

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
