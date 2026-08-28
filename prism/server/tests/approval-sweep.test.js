import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import {
  cancelPendingApprovalsForSession,
  getPendingApprovalsForSession,
  resolveToolApproval,
  waitForToolApproval,
} from '../claude-sdk.js';

/**
 * dc:待批审批必须有一条按会话清扫的路径。
 *
 * 事故形状:`pendingToolApprovals` 全局只有一处 delete(waitForToolApproval 自己的
 * cleanup),而常驻路径的审批超时是**关的**(要等人来点),唯一出口是 SDK 的
 * `context.signal`;而回合/运行时的死亡路径都不碰这个 Map。signal 一旦没触发,
 * resolver 就永久留着,并且因为补发按 app 会话 id 匹配(该 id 对整段对话稳定),
 * 这条会话**以后每次订阅**都会把这个死请求当"待批"推给用户 —— 点了没反应。
 */
describe('按会话清扫待批审批', () => {
  test('清扫后不再出现在待批列表里', async () => {
    const pending = waitForToolApproval('req-sweep-1', {
      timeoutMs: 0,
      metadata: { _appSessionId: 'app-1', _toolName: 'Bash' },
    });
    assert.equal(getPendingApprovalsForSession('app-1').length, 1, '前提:它确实在待批列表里');

    assert.equal(cancelPendingApprovalsForSession('app-1'), 1);
    assert.deepEqual(await pending, { cancelled: true }, '等待方要拿到"已取消",而不是永远挂着');
    assert.equal(getPendingApprovalsForSession('app-1').length, 0, '清扫后不该再被当成待批推给用户');
  });

  test('清扫会通知前端撤掉那个框 —— 否则留下一个点不动的确认框', async () => {
    const cancels = [];
    const pending = waitForToolApproval('req-sweep-2', {
      timeoutMs: 0,
      metadata: { _appSessionId: 'app-2' },
      onCancel: (reason) => cancels.push(reason),
    });
    cancelPendingApprovalsForSession('app-2', 'cancelled');
    await pending;
    assert.deepEqual(cancels, ['cancelled'], 'onCancel 必须走到,它负责发 permission_cancelled');
  });

  test('只清扫指定会话,不误伤别人的', async () => {
    const mine = waitForToolApproval('req-sweep-3', {
      timeoutMs: 0, metadata: { _appSessionId: 'app-3' },
    });
    const other = waitForToolApproval('req-sweep-4', {
      timeoutMs: 0, metadata: { _appSessionId: 'app-4' },
    });

    assert.equal(cancelPendingApprovalsForSession('app-3'), 1);
    await mine;
    assert.equal(getPendingApprovalsForSession('app-4').length, 1, '别人的待批不该被连累');

    resolveToolApproval('req-sweep-4', { allow: true });
    assert.deepEqual(await other, { allow: true });
  });

  test('已经回答过的不会被重复取消', async () => {
    const cancels = [];
    const pending = waitForToolApproval('req-sweep-5', {
      timeoutMs: 0,
      metadata: { _appSessionId: 'app-5' },
      onCancel: (reason) => cancels.push(reason),
    });
    resolveToolApproval('req-sweep-5', { allow: true });
    assert.deepEqual(await pending, { allow: true });

    assert.equal(cancelPendingApprovalsForSession('app-5'), 0);
    assert.deepEqual(cancels, [], '回答过之后不该再发取消帧');
  });

  test('会话 id 为空时什么都不做(别把所有人的待批一锅端)', () => {
    assert.equal(cancelPendingApprovalsForSession(null), 0);
    assert.equal(cancelPendingApprovalsForSession(''), 0);
  });
});
