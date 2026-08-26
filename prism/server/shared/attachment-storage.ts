import fs from 'node:fs';
import path from 'node:path';

import { attachmentsDb, type AttachmentKind } from '@/modules/database/index.js';
import { getGlobalImageAssetsDir } from '@/shared/image-attachments.js';

/**
 * 聊天附件落在哪、能占多少、留多久。
 *
 * **落在会话所属项目的工作目录下的 `attachments/`**,而不是一个全局目录。
 * 全局目录的问题不是不好看,是**归属没法验**:目录是全局的,取文件时只能验
 * "你登录了",没法验"这个附件是你的" —— 任一登录用户都能读到别人的聊天图片。
 * 放进项目目录之后走 `files/content`,那条路自带项目可见性校验,归属问题
 * 自然消失;附件也随项目一起被删、一起被共享,生命周期终于对上了。
 *
 * 会话还没落到任何项目上时回落到全局目录 —— 不能因为"还没选项目"就不让人传图。
 */

/** 项目工作目录下的附件子目录名。明放,用户在文件树里看得见、也能自己删。 */
export const ATTACHMENT_DIR_NAME = 'attachments';

const DEFAULT_TTL_DAYS = 30;
const DEFAULT_QUOTA_MB = 10 * 1024;

function readPositiveEnvNumber(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** 附件保留天数,超过就被清扫器收走。`PRISM_ATTACHMENT_TTL_DAYS` 可覆盖。 */
export function getAttachmentTtlDays(): number {
  return readPositiveEnvNumber('PRISM_ATTACHMENT_TTL_DAYS', DEFAULT_TTL_DAYS);
}

/** 每个用户的附件总量上限(字节)。`PRISM_ATTACHMENT_QUOTA_MB` 可覆盖。 */
export function getAttachmentQuotaBytes(): number {
  return readPositiveEnvNumber('PRISM_ATTACHMENT_QUOTA_MB', DEFAULT_QUOTA_MB) * 1024 * 1024;
}

/**
 * 自忽略的 `.gitignore`。
 *
 * 附件目录是明放的,项目又常常是个 git 仓库 —— 一次 `git add .` 就会把几十兆
 * 截图提交进去。在附件目录里自带一个只管自己的 `.gitignore`,比去改项目根上
 * 那个 `.gitignore` 干净得多:不碰用户的文件,用户想提交时把它删了即可。
 */
const SELF_IGNORE = '# Prism 聊天附件目录 —— 默认不进版本库。想提交就删掉这个文件。\n*\n!.gitignore\n';

/**
 * 确保附件目录存在(并带上自忽略文件),返回绝对路径。
 *
 * `projectRoot` 为空时回落到全局目录 —— 那条路上不写 `.gitignore`,全局目录
 * 不在任何仓库里。
 */
export function ensureAttachmentDir(projectRoot: string | null | undefined): {
  dir: string;
  projectPath: string | null;
} {
  if (!projectRoot) {
    const globalDir = getGlobalImageAssetsDir();
    fs.mkdirSync(globalDir, { recursive: true });
    return { dir: globalDir, projectPath: null };
  }

  const dir = path.join(projectRoot, ATTACHMENT_DIR_NAME);
  fs.mkdirSync(dir, { recursive: true });
  const ignorePath = path.join(dir, '.gitignore');
  if (!fs.existsSync(ignorePath)) {
    try {
      fs.writeFileSync(ignorePath, SELF_IGNORE, 'utf8');
    } catch {
      // 写不进去(只读挂载之类)不该让上传失败 —— 附件本身还是能落。
    }
  }
  return { dir, projectPath: projectRoot };
}

export type QuotaVerdict = {
  ok: boolean;
  usedBytes: number;
  quotaBytes: number;
  /** 这次要写入的字节数(调用方声明的)。 */
  incomingBytes: number;
};

/**
 * 配额检查。**只在拿得到 userId 时才拦** —— 匿名/内部调用一律放行,
 * 宁可漏拦也不能因为拿不到用户就把上传堵死。
 */
export function checkQuota(userId: number | null | undefined, incomingBytes: number): QuotaVerdict {
  const quotaBytes = getAttachmentQuotaBytes();
  const usedBytes = attachmentsDb.totalBytesForUser(userId);
  const incoming = Math.max(0, Math.trunc(incomingBytes) || 0);
  const ok = userId == null || usedBytes + incoming <= quotaBytes;
  return { ok, usedBytes, quotaBytes, incomingBytes: incoming };
}

/** 人话版的容量,给报错和设置页用。 */
export function formatBytes(bytes: number): string {
  const value = Math.max(0, Number(bytes) || 0);
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
}

/** 超配额时给用户看的那句话。只读 usedBytes / quotaBytes,两种 verdict 都能传。 */
export function quotaExceededMessage(verdict: { usedBytes: number; quotaBytes: number }): string {
  return `附件空间不够了:已用 ${formatBytes(verdict.usedBytes)} / 上限 ${formatBytes(verdict.quotaBytes)}。`
    + `请先在设置里清理一些附件,或让管理员调高上限。`;
}

/** 记一笔台账。配额和过期清理都只认台账,不认目录扫描。 */
export function recordAttachment(params: {
  userId: number | null | undefined;
  sessionId?: string | null;
  projectPath: string | null;
  kind: AttachmentKind;
  absPath: string;
  bytes: number;
}): void {
  attachmentsDb.record({
    userId: params.userId ?? null,
    sessionId: params.sessionId ?? null,
    projectPath: params.projectPath,
    kind: params.kind,
    absPath: params.absPath,
    bytes: params.bytes,
  });
}

export type CommitVerdict = { ok: boolean; reason?: 'quota' | 'error'; usedBytes: number; quotaBytes: number };

/**
 * 落盘**之后**的最终把关:在一个同步临界区里「求和 + 判断 + 记账」一气呵成。
 *
 * 为什么不能只信开传前那道 Content-Length 预检:
 *   - chunked 传输不带 Content-Length,预检看到 0,一律放行;
 *   - 并发多个上传都读到同一份"上传前用量",预检全过,合计可远超上限。
 * 预检只当"开传前快速失败"的优化,真正守死账面的是这里。
 *
 * 为什么这段是原子的:better-sqlite3 是同步 API、Node 又是单线程 —— 从
 * `totalBytesForUser` 到 `record` 之间**没有 await**,并发请求走到这里天然串行,
 * 不会两个都读到旧总量再各自放行。(落盘发生在临界区之外,所以磁盘峰值可能
 * 短暂超标,但被拒的文件由调用方立即删除,**最终入账绝不超配额**。)
 *
 * userId 拿不到时一律放行并照常记账 —— 与 checkQuota 一致,不因身份缺失堵上传。
 */
export function commitAttachmentWithinQuota(params: {
  userId: number | null | undefined;
  sessionId?: string | null;
  projectPath: string | null;
  kind: AttachmentKind;
  absPath: string;
  bytes: number;
}): CommitVerdict {
  const quotaBytes = getAttachmentQuotaBytes();
  const bytes = Math.max(0, Math.trunc(params.bytes) || 0);
  const usedBytes = attachmentsDb.totalBytesForUser(params.userId);
  if (params.userId != null && usedBytes + bytes > quotaBytes) {
    return { ok: false, reason: 'quota', usedBytes, quotaBytes };
  }
  // record() 永不抛,失败只回 false。落盘成功但记账失败时必须让调用方知道 ——
  // 一个不在台账里的文件既不计配额、也逃过 TTL 清扫,会永久占盘。调用方据此删文件。
  const recorded = attachmentsDb.record({
    userId: params.userId ?? null,
    sessionId: params.sessionId ?? null,
    projectPath: params.projectPath,
    kind: params.kind,
    absPath: params.absPath,
    bytes,
  });
  return recorded ? { ok: true, usedBytes, quotaBytes } : { ok: false, reason: 'error', usedBytes, quotaBytes };
}

/**
 * 过期附件清扫器。
 *
 * 启动后先跑一次(进程可能停了很久,重启那一刻正是积压最多的时候),之后每小时一轮。
 * `unref()` 保证这个定时器不会把进程钉在事件循环里。
 *
 * **只删台账里记过的文件** —— `attachments/` 在文件树里是明放的,用户自己也会
 * 往里放东西,扫目录会连人家的东西一起删。
 */
export function startAttachmentSweeper(): NodeJS.Timeout {
  const runOnce = () => {
    const ttlDays = getAttachmentTtlDays();
    const { removed, bytes } = attachmentsDb.sweepExpired(ttlDays);
    if (removed > 0) {
      console.log(`[attachments] 清理了 ${removed} 个超过 ${ttlDays} 天的附件,释放 ${formatBytes(bytes)}`);
    }
  };

  runOnce();
  const timer = setInterval(runOnce, 60 * 60 * 1000);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}
