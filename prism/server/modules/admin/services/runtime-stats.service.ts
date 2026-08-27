/**
 * 运行时资源快照(F6 管理面,root 只读)。
 *
 * 服务器状态面板原来只答"这台机器怎么样"(负载/内存/磁盘)。真正会把 Prism
 * 拖垮的却是**进程内的池子**:常驻 Claude 子进程、在飞的回合、挂着的 PTY、
 * 历史缓存。这些之前一个都看不见 —— 名额满了只表现为"某人发消息很慢",
 * 内存涨了只能猜是谁。这里把它们一次性摊开。
 *
 * 全部是只读快照:不 dispose、不清缓存、不中断任何回合。管理面看得见但动不了,
 * 是刻意的 —— 一个能一键杀别人回合的按钮,风险远大于它省下的那点事。
 *
 * 账号维度带上用户名(池子里只有 id),否则 root 看到的是一串数字。
 *
 * 常驻池的数据由**注入**进来(组合根 index.js 从 claude-sdk.js 取):模块不直接
 * import claude-sdk.js,与 shell 模块的 `releaseConversation` 同一套约定。
 */

import { userDb } from '@/modules/database/index.js';
import { getHistoryCacheStats } from '@/modules/providers/index.js';
import { chatRunRegistry, getPtyPoolStats } from '@/modules/websocket/index.js';

/** 一个账号占了多少(runtime 用 total/busy,PTY 只有 count)。 */
export type OwnerUsage = {
  userId: number | null;
  username: string | null;
  total?: number;
  busy?: number;
  count?: number;
};

export type RuntimePoolSnapshot = {
  max: number;
  size: number;
  busy: number;
  idle: number;
  idleReapMs: number;
  oneShotOverflow: { active: number; max: number };
  byOwner: Array<{ userId: number | null; total: number; busy: number }>;
};

export type RuntimeStatsDependencies = {
  /** 常驻池快照来源。缺省时(没注入)按空池处理,面板照样出得来。 */
  runtimePool?: () => RuntimePoolSnapshot;
};

const EMPTY_POOL: RuntimePoolSnapshot = {
  max: 0, size: 0, busy: 0, idle: 0, idleReapMs: 0,
  oneShotOverflow: { active: 0, max: 0 },
  byOwner: [],
};

export type RuntimeStats = {
  now: string;
  runtimes: {
    max: number;
    size: number;
    busy: number;
    idle: number;
    idleReapMs: number;
    oneShotOverflow: { active: number; max: number };
    byOwner: OwnerUsage[];
  };
  runs: { running: number; oldestStartedAt: string | null };
  approvals: { pending: number };
  pty: {
    count: number;
    attached: number;
    detached: number;
    takeover: number;
    bufferedBytes: number;
    byOwner: OwnerUsage[];
  };
  caches: { history: { entries: number; bytes: number } };
};

/** id → 用户名的一次性查表。用户少,全量读一次比逐个查便宜。 */
function usernameLookup(): Map<number, string> {
  const lookup = new Map<number, string>();
  try {
    for (const user of userDb.listUsersForAdmin()) lookup.set(user.id, user.username);
  } catch {
    // 面板是只读诊断,查不到名字就只显示 id,不该让整个接口失败。
  }
  return lookup;
}

export function collectRuntimeStats(dependencies: RuntimeStatsDependencies = {}): RuntimeStats {
  const lookup = usernameLookup();
  const named = <T extends { userId: number | null }>(rows: T[]): Array<T & { username: string | null }> =>
    rows.map((row) => ({
      ...row,
      username: row.userId == null ? null : lookup.get(row.userId) ?? null,
    }));

  let pool = EMPTY_POOL;
  try {
    pool = dependencies.runtimePool?.() ?? EMPTY_POOL;
  } catch {
    pool = EMPTY_POOL;
  }
  const running = chatRunRegistry.listRunningRuns();
  const pty = getPtyPoolStats();

  let pendingApprovals = 0;
  try {
    pendingApprovals = userDb.listUsersForAdmin().filter((user) => user.approval_status === 'pending').length;
  } catch {
    pendingApprovals = 0;
  }

  const oldestStartedAt = running.length > 0
    ? new Date(Math.min(...running.map((run) => run.startedAt))).toISOString()
    : null;

  return {
    now: new Date().toISOString(),
    runtimes: { ...pool, byOwner: named(pool.byOwner) },
    runs: { running: running.length, oldestStartedAt },
    approvals: { pending: pendingApprovals },
    pty: { ...pty, byOwner: named(pty.byOwner) },
    caches: { history: getHistoryCacheStats() },
  };
}
