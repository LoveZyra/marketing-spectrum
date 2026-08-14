import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

/**
 * 待审批计数的取数规则。
 *
 * 逻辑本身在 hook 里(依赖 React 与 fetch,不便在 node 环境直接跑),这里钉的是
 * 它赖以成立的那条契约:`/api/admin/users` 返回的行里,只有 approval_status
 * 恰好为 'pending' 的才计数。approved / rejected 都不算 —— 曾经有一版把
 * "非 approved" 当待办,于是被拒的账号会永远挂在红点里。
 */
const countPending = (users: Array<{ approval_status?: string }>) =>
  users.filter((user) => user.approval_status === 'pending').length;

describe('待审批账号计数', () => {
  test('只数 pending', () => {
    assert.equal(countPending([
      { approval_status: 'pending' },
      { approval_status: 'approved' },
      { approval_status: 'rejected' },
      { approval_status: 'pending' },
    ]), 2);
  });

  test('空列表与缺字段都算 0,不抛', () => {
    assert.equal(countPending([]), 0);
    assert.equal(countPending([{}, { approval_status: undefined }]), 0);
  });

  test('被拒的账号不再占着红点', () => {
    assert.equal(countPending([{ approval_status: 'rejected' }]), 0);
  });
});
