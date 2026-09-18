/**
 * gk:最近删除(会话回收站)—— 文件搬运、清扫与恢复。
 *
 * 永久删除不再 unlink transcript:它和旁边的 `<provider id>/` 目录(子代理 transcript、
 * 大工具输出)一起搬到 `<数据目录>/trash/<YYYY-MM-DD>/<app session id>/` 下;
 * 库里的行与显示日志搬进 `session_trash` 两张表(见 session-trash.db.ts)。
 * `PRISM_TRASH_RETENTION_DAYS`(默认 30,0 = 永不自动清)之后由清扫器真删。
 *
 * ## 为什么搬走而不是留在原地
 *
 * transcript 留在 `~/.claude/projects` 里,监视器下一次扫到它就会重新索引成一条
 * "CLI 自己开的"新会话 —— 删了又冒出来。搬走之后原目录里就没有它了。
 * 监视器另有一道门:provider id 在回收站里的 transcript 一律不索引(见 createSession),
 * 两道门一起挡,少一道都会在某个时序下漏。
 *
 * ## 空壳复活
 *
 * 2026-09-14 那次事故里,transcript 删掉之后半小时,常驻 CLI 进程被回收,退出时按
 * 老路径写了两行收尾记录(`last-prompt` / `mode`),同名文件"复活"成 362 字节的空壳。
 * 所以删除路径先收 runtime(sessions.service),搬完文件再**晚几秒回头看一眼**
 * (`scheduleStrayCheck`):老路径上又冒出来的、没有 `cwd` 行的小文件一律收进回收站目录。
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { auditLogDb, sessionTrashDb, type SessionTrashRow } from '@/modules/database/index.js';
import { createLogger } from '@/shared/logger.js';
import { getDataDir } from '@/utils/runtime-paths.js';

const log = createLogger('providers');

const SWEEP_BATCH = 200;
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** 搬完 transcript 之后多久回头查一次"空壳复活"。CLI 收到 stdin 关闭后 2 秒内退出,5 秒后 SIGKILL。 */
export const STRAY_CHECK_DELAY_MS = 8_000;
/** 空壳的上限:两行收尾记录几百字节;正常 transcript 第一行就带 cwd,远不止这个数。 */
const STRAY_MAX_BYTES = 4096;

export const DEFAULT_TRASH_RETENTION_DAYS = 30;

/**
 * 保留天数。未配置 = 30;显式 `0` = 永不自动清扫。
 *
 * **写不成数的值按默认 30 处理,并喊一声。** 上一版把它和显式 0 归成一类,
 * 于是 `PRISM_TRASH_RETENTION_DAYS=30d` 这种手滑会静默关掉整个清扫器
 * (`startTrashSweeper` 在 `<= 0` 时连定时器都不建),回收站无声无息地长到满盘 ——
 * 而配置看上去是"设了 30 天"的。关掉自动清扫是一个需要明写 `0` 的决定。
 */
export function getTrashRetentionDays(): number {
  const raw = process.env.PRISM_TRASH_RETENTION_DAYS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_TRASH_RETENTION_DAYS;
  const trimmed = raw.trim();
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || String(parsed) !== trimmed || parsed < 0) {
    log.warn(
      `[trash] PRISM_TRASH_RETENTION_DAYS="${trimmed}" 不是一个非负整数,按默认 ${DEFAULT_TRASH_RETENTION_DAYS} 天处理`
      + '(要永不自动清扫请显式写 0)',
    );
    return DEFAULT_TRASH_RETENTION_DAYS;
  }
  return parsed;
}

export function trashRootDir(): string {
  return path.join(getDataDir(), 'trash');
}

/**
 * 回收站桶名里那一段 session id —— **不能直接拿 id 当路径段**。
 *
 * `session_id` 不全是我们自己生成的:监视器索引磁盘上的 transcript 时,
 * 这个值是从 jsonl 里读出来的(`data.sessionId`),而路由的校验正则允许点号
 * (`/^[a-zA-Z0-9._-]{1,120}$/`)。也就是说 `".."` 是一个能走完全程的合法 id:
 * `path.join(trash, '2026-09-15', '..')` = `trash`,随后 `purgeTrashFiles` 的
 * `rm -rf` 就会端掉**所有人**的回收站。
 *
 * 所以这里只放 `[A-Za-z0-9_-]`,其余一律换成 `_`;换过字符的再缀一段原 id 的
 * 短哈希,免得 `a.b` 与 `a_b` 这类不同 id 落进同一个桶。
 */
export function trashBucketSegment(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, '_');
  if (safe === sessionId && safe.length > 0) return safe;
  const digest = createHash('sha1').update(sessionId).digest('hex').slice(0, 12);
  return `${safe.slice(0, 64)}-${digest}`;
}

/**
 * 这个路径是不是一个**货真价实的回收站桶**(`<trash>/<日期>/<段>`)。
 *
 * 判两件事:在 trash 根目录**之内**(用 `path.relative` 而不是 `startsWith` ——
 * 后者会把 `<dataDir>/trash-old` 也算进来),且深度正好两级 ——
 * 根目录本身和单独一个日期目录都不许删。
 */
function isSafeTrashBucket(bucket: string): boolean {
  const root = path.resolve(trashRootDir());
  const relative = path.relative(root, path.resolve(bucket));
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return false;
  return relative.split(path.sep).filter((segment) => segment.length > 0).length === 2;
}

function dayStamp(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

/** transcript 旁边的同名目录(子代理 transcript / 大工具输出落在这里)。 */
export function transcriptSiblingDir(jsonlPath: string): string {
  const dir = path.dirname(jsonlPath);
  const base = path.basename(jsonlPath, '.jsonl');
  return path.join(dir, base);
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * 搬一个文件或目录。同一文件系统上是一次 rename;跨设备(EXDEV)退回复制 + 删除。
 * 目标已存在的**文件**会被 rename 原子覆盖(那正是"空壳复活"要覆盖掉的东西);
 * 目标已存在的**目录**rename 会失败(ENOTEMPTY/EEXIST),退回合并复制。
 */
async function movePath(source: string, destination: string): Promise<void> {
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  try {
    await fsp.rename(source, destination);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EXDEV' && code !== 'ENOTEMPTY' && code !== 'EEXIST') throw error;
  }
  const stat = await fsp.stat(source);
  if (stat.isDirectory()) {
    await fsp.cp(source, destination, { recursive: true, force: true });
    await fsp.rm(source, { recursive: true, force: true });
  } else {
    await fsp.copyFile(source, destination);
    await fsp.unlink(source);
  }
}

/**
 * 老路径上是不是一个"空壳":很小、且没有任何一行带 `cwd`(正常 transcript 第一行就有)。
 * 判据刻意保守 —— 拿不准的一律不算空壳,宁可留下也不能把真 transcript 当垃圾收走。
 */
export async function isStrayShellTranscript(filePath: string): Promise<boolean> {
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile() || stat.size === 0 || stat.size > STRAY_MAX_BYTES) return false;
    const text = await fsp.readFile(filePath, 'utf8');
    return !/"cwd"\s*:/.test(text);
  } catch {
    return false;
  }
}

export type TrashedFiles = {
  trashJsonlPath: string | null;
  trashDirPath: string | null;
};

/** 还没跑的空壳回查,按 app session id 存;恢复时要能撤掉(见 cancelStrayCheck)。 */
const pendingStrayChecks = new Map<string, NodeJS.Timeout>();

/**
 * 把 transcript(和同名目录)搬进回收站目录。任何一步失败都只记日志、不抛 ——
 * 库里的行已经进回收站了,文件搬不动不该让删除"失败一半"。
 */
export async function moveTranscriptToTrash(
  row: Pick<SessionTrashRow, 'session_id' | 'jsonl_path'>,
  now = new Date(),
): Promise<TrashedFiles> {
  const result: TrashedFiles = { trashJsonlPath: null, trashDirPath: null };
  const jsonlPath = row.jsonl_path?.trim();
  if (!jsonlPath) return result;

  const bucket = path.join(trashRootDir(), dayStamp(now), trashBucketSegment(row.session_id));
  const targetJsonl = path.join(bucket, path.basename(jsonlPath));
  if (await pathExists(jsonlPath)) {
    try {
      await movePath(jsonlPath, targetJsonl);
      result.trashJsonlPath = targetJsonl;
    } catch (error) {
      log.error('[trash] transcript 搬入回收站失败(库里的行已进回收站,文件留在原地)', {
        sessionId: row.session_id, jsonlPath, error: (error as Error)?.message,
      });
    }
  }

  const sibling = transcriptSiblingDir(jsonlPath);
  if (await pathExists(sibling)) {
    const targetDir = path.join(bucket, path.basename(sibling));
    try {
      await movePath(sibling, targetDir);
      result.trashDirPath = targetDir;
    } catch (error) {
      log.error('[trash] transcript 同名目录搬入回收站失败', {
        sessionId: row.session_id, sibling, error: (error as Error)?.message,
      });
    }
  }

  return result;
}

/**
 * 删除后几秒回头看一眼老路径:常驻 CLI 退出时可能又写出一个空壳。
 * 收进回收站目录(`stray-<时间>.jsonl`),不 unlink —— 判错了也还找得回来。
 */
export function scheduleStrayCheck(
  row: Pick<SessionTrashRow, 'session_id' | 'jsonl_path'>,
  files: TrashedFiles,
  delayMs = STRAY_CHECK_DELAY_MS,
): NodeJS.Timeout | null {
  const jsonlPath = row.jsonl_path?.trim();
  if (!jsonlPath) return null;
  const bucket = files.trashJsonlPath
    ? path.dirname(files.trashJsonlPath)
    : path.join(trashRootDir(), dayStamp(), trashBucketSegment(row.session_id));
  cancelStrayCheck(row.session_id);
  const timer = setTimeout(() => {
    pendingStrayChecks.delete(row.session_id);
    void (async () => {
      /**
       * **这八秒里会话可能已经被恢复了。** 那时老路径上的文件是刚搬回去的真
       * transcript(或它上面正在续写),不是空壳;`isStrayShellTranscript` 对
       * 正常 transcript 会返回 false,但"刚恢复的一条本来就只剩壳"这种情况
       * 判不出来 —— 于是把刚恢复的东西又搬进一个没有回收站行指向的桶里,
       * 那才是真的找不回来。所以先确认这条**还在回收站里**。
       */
      if (!sessionTrashDb.get(row.session_id)) return;
      if (!(await isStrayShellTranscript(jsonlPath))) return;
      try {
        await movePath(jsonlPath, path.join(bucket, `stray-${Date.now()}.jsonl`));
        log.info(`[trash] 收走了删除后复活的空壳 transcript:${jsonlPath}`);
      } catch (error) {
        log.warn('[trash] 收空壳失败:', (error as Error)?.message || error);
      }
    })();
  }, delayMs);
  if (typeof timer.unref === 'function') timer.unref();
  pendingStrayChecks.set(row.session_id, timer);
  return timer;
}

/** 恢复时撤掉还没跑的空壳回查(它的目标路径已经不该被动了)。 */
export function cancelStrayCheck(sessionId: string): void {
  const timer = pendingStrayChecks.get(sessionId);
  if (!timer) return;
  clearTimeout(timer);
  pendingStrayChecks.delete(sessionId);
}

/**
 * 恢复:把 transcript 与目录搬回原路径。老路径上若有空壳,rename 直接覆盖。
 *
 * `failed` 区分"回收站里本来就没有文件"(搬不搬都对)与"有文件但搬不动"
 * (原目录被删了、只读盘、权限)。调用方**必须先看 `failed`**:库里的行一旦搬回
 * 活表,回收站行就没了,那份文件也就再没有任何东西指向它 —— 连清扫器都找不到。
 */
export async function restoreTranscriptFromTrash(
  row: SessionTrashRow,
): Promise<{ transcriptRestored: boolean; failed: boolean }> {
  let transcriptRestored = false;
  let failed = false;
  const jsonlPath = row.jsonl_path?.trim();
  if (jsonlPath && row.trash_jsonl_path && await pathExists(row.trash_jsonl_path)) {
    try {
      await movePath(row.trash_jsonl_path, jsonlPath);
      transcriptRestored = true;
    } catch (error) {
      failed = true;
      log.error('[trash] transcript 恢复失败', { sessionId: row.session_id, error: (error as Error)?.message });
    }
  }
  if (jsonlPath && row.trash_dir_path && await pathExists(row.trash_dir_path)) {
    try {
      await movePath(row.trash_dir_path, transcriptSiblingDir(jsonlPath));
    } catch (error) {
      failed = true;
      log.error('[trash] transcript 目录恢复失败', { sessionId: row.session_id, error: (error as Error)?.message });
    }
  }
  return { transcriptRestored, failed };
}

/** 真删回收站目录(整个 `<日期>/<桶名>/`),以及老路径上残留的空壳。 */
export async function purgeTrashFiles(row: SessionTrashRow): Promise<void> {
  const bucket = row.trash_jsonl_path
    ? path.dirname(row.trash_jsonl_path)
    : row.trash_dir_path ? path.dirname(row.trash_dir_path) : null;
  if (bucket) {
    if (isSafeTrashBucket(bucket)) {
      try {
        await fsp.rm(bucket, { recursive: true, force: true });
      } catch (error) {
        log.warn('[trash] 清扫回收站目录失败:', (error as Error)?.message || error);
      }
    } else {
      // 走到这里说明库里记下的回收站路径不是一个正常的桶 —— 宁可留着占盘,也不 rm。
      log.error('[trash] 拒绝清扫:回收站路径不在 <trash>/<日期>/<桶> 这一层', {
        sessionId: row.session_id, bucket,
      });
    }
  }
  const jsonlPath = row.jsonl_path?.trim();
  if (jsonlPath && await isStrayShellTranscript(jsonlPath)) {
    try {
      await fsp.unlink(jsonlPath);
    } catch {
      // 空壳删不掉不影响清扫本身
    }
  } else if (jsonlPath && !row.trash_jsonl_path && await pathExists(jsonlPath)) {
    /**
     * 删除时 transcript **没搬成**(只读盘 / 权限 / 满盘),文件还在原地。
     * 清扫把回收站行删掉之后,监视器那道"在回收站里就不索引"的门也跟着没了 ——
     * 下一次扫到这个文件,这段已经永久删除的对话会作为一条新会话重新出现。
     * 这里不代替运维做删除决定(判错就没了),但必须留下一行指名文件的日志。
     */
    log.warn(
      `[trash] 清扫了回收站记录,但原路径上的 transcript 当初没搬成、仍在:${jsonlPath}`
      + '(监视器可能把它重新索引成一条新会话,确认后请手工处理)',
      { sessionId: row.session_id },
    );
  }
}

/** 清扫:超过保留期的真删。返回删了几条。 */
export async function sweepExpiredTrash(now = new Date()): Promise<number> {
  const retentionDays = getTrashRetentionDays();
  if (retentionDays <= 0) return 0;
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const expired = sessionTrashDb.listExpired(cutoff, SWEEP_BATCH);
  let purged = 0;
  const names: string[] = [];
  for (const row of expired) {
    try {
      const removed = sessionTrashDb.purge(row.session_id);
      if (!removed) continue;
      await purgeTrashFiles(removed);
      purged += 1;
      if (names.length < 20) names.push(removed.custom_name?.trim() || removed.session_id);
    } catch (error) {
      log.warn('[trash] 清扫单条失败(下一轮再试):', (error as Error)?.message || error);
    }
  }
  if (purged > 0) {
    log.info(`[trash] 清理了 ${purged} 条超过 ${retentionDays} 天的已删除会话`);
    auditLogDb.record({
      userId: null,
      username: null,
      event: 'session_trash_purged',
      detail: JSON.stringify({ entry: 'retention', count: purged, retentionDays, names }),
    });
  }
  return purged;
}

/**
 * 启动跑一次,之后每 6 小时一轮。
 *
 * **必须在库初始化之后调用** —— 它第一件事就是查 `session_trash`。
 * 失败不再静默吞掉:清扫是"到点真删",它一直失败而没人知道,回收站就会
 * 一边长一边看着像在工作。
 */
export function startTrashSweeper(): NodeJS.Timeout | null {
  if (getTrashRetentionDays() <= 0) return null;
  const runOnce = (): void => {
    void sweepExpiredTrash().catch((error) => {
      log.error('[trash] 清扫失败', { error: (error as Error)?.message || String(error) });
    });
  };
  runOnce();
  const timer = setInterval(runOnce, SWEEP_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

/** 测试用:回收站根目录存不存在(不建)。 */
export function trashRootExistsSync(): boolean {
  return fs.existsSync(trashRootDir());
}
