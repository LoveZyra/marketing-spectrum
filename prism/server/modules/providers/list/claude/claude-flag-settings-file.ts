import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { createLogger } from '@/shared/logger.js';
import { getDataDir } from '@/utils/runtime-paths.js';

const log = createLogger('providers');

/**
 * flag 层设置走文件,不走命令行。
 *
 * SDK 把对象形式的 `options.settings` 序列化成 `--settings <json>` 塞进 CLI 的命令行,网关 key 就在里面,
 * `ps -eo args` / `/proc/<pid>/cmdline` 谁都看得到(常驻进程能活半小时;模型在 Bash 工具里随手 `ps aux`
 * 就会把别人的 key 带进自己的对话)。CLI 的相关行为:
 * - `settings` 给成文件路径时,命令行里只有路径;CLI 启动时读一次;
 * - 之后 `applyFlagSettings({ effortLevel })` 不会冲掉文件里的 env;
 * - 启动后文件被删,进程照旧用已读入的那份;但不依赖这一点,文件留到进程收尾再删。
 *
 * 文件在数据目录下的 `flag-settings/`(0700),文件 0600。同一个系统账号(jovyan)下的人本来就读得到
 * 数据库与 settings.json,这里挡的是"随手一个 ps 就看见"。
 * 只有带网关补丁(含 key)时才写文件;其余情况仍直接传对象。
 */

const DIR_NAME = 'flag-settings';
/**
 * 这一个 Prism 进程的随机前缀。不用 pid:容器里 node 每次启动都是同一个小 pid,
 * 按 pid 认"自己的"会让上一次崩溃留下的 key 文件永远删不掉。
 */
const BOOT_ID = randomUUID().slice(0, 8);
const flagSettingsDir = (): string => path.join(getDataDir(), DIR_NAME);

/** 写一份 flag 设置文件,返回路径。写不出来就抛 —— 宁可这一轮失败,也不退回命令行传 key。 */
export function writeFlagSettingsFile(settings: Record<string, unknown>): string {
  const dir = flagSettingsDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // 目录不归这个进程管(极少见)—— 文件本身还是 0600
  }
  const file = path.join(dir, `${BOOT_ID}-${randomUUID()}.json`);
  fs.writeFileSync(file, JSON.stringify(settings), { mode: 0o600, flag: 'wx' });
  return file;
}

/** 删掉(不存在也算成功)。 */
export function removeFlagSettingsFile(file: string | null | undefined): void {
  if (!file) return;
  try {
    fs.unlinkSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      log.warn('[网关] flag 设置文件删不掉:', (error as Error)?.message || error);
    }
  }
}

/**
 * 启动时清掉上一个 Prism 进程留下的(文件名以本进程的随机前缀开头的才是自己的;其余一律删 —— 上一个进程的
 * CLI 子进程早已随它退出,文件没人用了)。
 */
export function sweepStaleFlagSettingsFiles(): number {
  let removed = 0;
  let names: string[] = [];
  try {
    names = fs.readdirSync(flagSettingsDir());
  } catch {
    return 0;
  }
  const mine = `${BOOT_ID}-`;
  for (const name of names) {
    if (!name.endsWith('.json') || name.startsWith(mine)) continue;
    try {
      fs.unlinkSync(path.join(flagSettingsDir(), name));
      removed += 1;
    } catch {
      // 删不掉就留给下次启动再清
    }
  }
  return removed;
}
