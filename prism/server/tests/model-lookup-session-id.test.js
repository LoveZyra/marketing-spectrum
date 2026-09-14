import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import { modelLookupSessionId } from '../claude-sdk.js';

/**
 * F32:查"这条会话下一轮用哪个模型"时用哪个 id。
 *
 * 写入那一侧是固定的:`POST /:provider/sessions/:sessionId/active-model`,
 * 路由里的 `sessionId` 是前端给的 **app 会话 id**。而 provider 侧的
 * `options.sessionId` 装的是 `session.provider_session_id` —— 网页会话这两个
 * **必然不同**。用后者去读,覆盖永远命中不了:
 *
 *   用户在模型选择器里换了模型 → 写进 app id 那条记录 → 下一轮按 provider id 去读
 *   → 读不到 → 回落默认模型;而界面读的又是 app id,把待生效的那个报出来 ——
 *   **看着像生效了,实际没有。**
 *
 * fj 修过其中两处(常驻与一次性),`runAgentLoop` 与预热这两处漏了 ——
 * 又一次"改了三处漏了两处"。现在四处共用这一个函数。
 */
describe('modelLookupSessionId', () => {
  test('有 runId(app 会话 id)就用它 —— 写入那一侧就是按它存的', () => {
    assert.equal(
      modelLookupSessionId({ runId: 'app-session-1', sessionId: 'provider-native-9' }),
      'app-session-1',
    );
  });

  test('没有 runId 才退回 provider 原生 id(外部 API / 老调用)', () => {
    assert.equal(modelLookupSessionId({ sessionId: 'provider-native-9' }), 'provider-native-9');
  });

  test('两个都没有 → undefined(resolveResumeModel 会退回请求里那个模型)', () => {
    assert.equal(modelLookupSessionId({}), undefined);
    assert.equal(modelLookupSessionId(), undefined);
  });

  test('空串 / 空白不算数,不会拿一个空 key 去查', () => {
    assert.equal(modelLookupSessionId({ runId: '   ', sessionId: 'provider-9' }), 'provider-9');
    assert.equal(modelLookupSessionId({ runId: '', sessionId: '  ' }), undefined);
  });

  test('runId 不是字符串时忽略它', () => {
    assert.equal(modelLookupSessionId({ runId: 123, sessionId: 'provider-9' }), 'provider-9');
  });
});
