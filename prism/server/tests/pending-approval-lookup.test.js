import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import { approvalBelongsToSession } from '../claude-sdk.js';

/**
 * 待批审批的归属判定 —— 决定一条审批请求在重连/切回会话时能不能被补发。
 *
 * 这条规则原来只比 provider 原生 id,而那个 id 在一轮对话的开头是 null:
 * `canUseTool` 可以在流里第一条消息回来之前就触发。于是新会话第一轮里产生的
 * 审批请求被永久打上 `_sessionId: null`,而查询方永远拿着非空 id 来问 ——
 * **这条请求此后无论刷新、重连还是切换都不可能再被捞出来**,用户只能看着它
 * 超时,而且从头到尾没有弹窗。
 *
 * 这里钉的就是那个空窗:app 会话 id 从第一轮开始就存在。
 */
describe('待批审批按会话查找', () => {
  test('provider 原生 id 命中', () => {
    const resolver = { _sessionId: 'prov-1', _appSessionId: 'app-1' };
    assert.equal(approvalBelongsToSession(resolver, 'prov-1'), true);
  });

  test('app 会话 id 命中', () => {
    const resolver = { _sessionId: 'prov-1', _appSessionId: 'app-1' };
    assert.equal(approvalBelongsToSession(resolver, 'app-1'), true);
  });

  /** 回归本体:第一轮里 provider id 还不存在,只能靠 app id 找回来。 */
  test('provider id 还是 null 时,靠 app 会话 id 仍然找得到', () => {
    const resolver = { _sessionId: null, _appSessionId: 'app-1' };

    assert.equal(approvalBelongsToSession(resolver, 'app-1'), true);
    // 修复前这里是唯一的查询方式,而它永远返回 false —— 请求就此失联。
    assert.equal(approvalBelongsToSession(resolver, 'prov-1'), false);
  });

  test('别的会话不命中', () => {
    const resolver = { _sessionId: 'prov-1', _appSessionId: 'app-1' };
    assert.equal(approvalBelongsToSession(resolver, 'app-2'), false);
    assert.equal(approvalBelongsToSession(resolver, 'prov-2'), false);
  });

  /**
   * 两边都是 null 时不能互相命中。`null === null` 为真,不显式挡掉的话,
   * 一条还没拿到任何 id 的请求会被当成"属于每一个还没拿到 id 的会话",
   * 于是 A 的审批框弹到 B 的界面上 —— 比丢失更糟。
   */
  test('空 id 一律不命中', () => {
    assert.equal(approvalBelongsToSession({ _sessionId: null, _appSessionId: null }, null), false);
    assert.equal(approvalBelongsToSession({ _sessionId: null, _appSessionId: null }, ''), false);
    assert.equal(approvalBelongsToSession({ _sessionId: null, _appSessionId: null }, 'app-1'), false);
    assert.equal(approvalBelongsToSession(null, 'app-1'), false);
    assert.equal(approvalBelongsToSession(undefined, 'app-1'), false);
  });
});
