import { useCallback, useEffect, useState } from 'react';

import { authenticatedFetch } from '../utils/api';

/**
 * 待审批账号数,给设置入口上的红色计数用。
 *
 * 只有 root 会拿到数字。审批入口本身就是 root 专属的（设置 → 账号），非 root
 * 请求 `/api/admin/users` 会被 `requireRoot` 挡掉，所以对他们直接返回 0，
 * 连请求都不发。
 *
 * 用轮询而不是推送：审批状态由另一个人（注册者）的动作改变，而当前没有任何
 * 一条实时事件承载"有人注册了"。轮询 60 秒一次是个折中——比"只在打开设置页时
 * 才知道"好得多，又不至于让一个每天变动几次的数字占着一条长连接。
 *
 * 每次窗口重新获得焦点时也刷一次：从别的标签页切回来通常正是想看它。
 */

const POLL_INTERVAL_MS = 60_000;

type AdminUserRow = { approval_status?: string };

export function usePendingApprovalCount(isRoot: boolean): number {
  const [count, setCount] = useState(0);

  const refresh = useCallback(async () => {
    if (!isRoot) {
      setCount(0);
      return;
    }

    try {
      const response = await authenticatedFetch('/api/admin/users');
      if (!response.ok) return;
      const payload = (await response.json()) as { users?: AdminUserRow[] };
      const pending = (payload.users ?? []).filter((user) => user.approval_status === 'pending');
      setCount(pending.length);
    } catch {
      // 读不到就保持上一次的数字。这是个提示,不该因为一次网络抖动清零或报错。
    }
  }, [isRoot]);

  useEffect(() => {
    if (!isRoot) {
      setCount(0);
      return;
    }

    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_INTERVAL_MS);
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [isRoot, refresh]);

  return count;
}
