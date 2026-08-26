import { connectedClients, WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';
import { readSocketViewer } from '@/shared/project-visibility.js';
import { isRootUser } from '@/shared/root-users.js';
import { userDb } from '@/modules/database/index.js';

/**
 * 把当前「待审批账号数」推给所有在线的 root(设置入口的红色计数)。
 *
 * 触发时机:有人注册(register_pending)、root 批准/驳回。原来这个数字只靠
 * 前端 60 秒轮询 + 窗口聚焦刷新 —— 新注册要等最多一分钟才冒红点,审批完红点
 * 还赖着不走。推送后两端立即同步;轮询保留作兜底(掉线期间发生的注册靠它补)。
 *
 * 只发给 root:非 root 连上的 socket 直接跳过,不发也不显示。
 */
export function broadcastPendingApprovalCount(): void {
  let count = 0;
  try {
    count = userDb.listUsersForAdmin().filter((user) => user.approval_status === 'pending').length;
  } catch {
    return; // 数据库瞬时不可用:这只是个角标,不值得让调用方失败
  }

  const payload = JSON.stringify({
    kind: 'admin_pending_approvals',
    count,
    timestamp: new Date().toISOString(),
  });

  for (const ws of connectedClients) {
    try {
      if ((ws as { readyState?: number }).readyState !== WS_OPEN_STATE) continue;
      const viewer = readSocketViewer(ws);
      if (!viewer?.username || !isRootUser(viewer.username)) continue;
      (ws as { send: (data: string) => void }).send(payload);
    } catch {
      // 单个 socket 出错不影响其余
    }
  }
}
