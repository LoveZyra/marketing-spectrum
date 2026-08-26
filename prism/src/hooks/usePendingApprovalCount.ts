import { useCallback, useEffect, useState } from 'react';

import { authenticatedFetch } from '../utils/api';
import { useWebSocket } from '../contexts/WebSocketContext';

/**
 * 待审批账号数,给设置入口上的红色计数用。
 *
 * 只有 root 会拿到数字。审批入口本身就是 root 专属的（设置 → 账号），非 root
 * 请求 `/api/admin/users` 会被 `requireRoot` 挡掉，所以对他们直接返回 0，
 * 连请求都不发。
 *
 * 三路更新,谁先到听谁的:
 * 1. **服务端推送**(admin_pending_approvals 帧):有人注册、root 批准/驳回时
 *    服务端立即广播最新数 —— 红点实时出现、审批完实时消失;
 * 2. **本地事件** `prism:approvals-changed`:本浏览器里自己点了批准/驳回,
 *    不等推送直接刷一次(推送丢了也兜得住);
 * 3. **轮询 60s + 窗口聚焦**:掉线期间发生的注册靠它补。
 */

const POLL_INTERVAL_MS = 60_000;

type AdminUserRow = { approval_status?: string };

export function usePendingApprovalCount(isRoot: boolean): number {
  const [count, setCount] = useState(0);
  const { subscribe } = useWebSocket();

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
    // 本浏览器里自己点了批准/驳回(useAccountApprovals 派发)。
    const onApprovalsChanged = () => void refresh();
    window.addEventListener('prism:approvals-changed', onApprovalsChanged);
    // 服务端实时推送:注册/审批发生时直接带来最新数。
    const unsubscribe = subscribe((event) => {
      const frame = event as { kind?: string; count?: number };
      if (frame?.kind === 'admin_pending_approvals' && typeof frame.count === 'number') {
        setCount(frame.count);
      }
    });
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('prism:approvals-changed', onApprovalsChanged);
      unsubscribe();
    };
  }, [isRoot, refresh, subscribe]);

  return count;
}
