/**
 * 分级日志。
 *
 * ## 为什么需要它
 *
 * `prism.log` 是生产上唯一的排障入口,而它此前是**一条不分级、不带时间、不带来源
 * 的流** —— 453 处 `console.*` 直接往里写。三个后果:
 *
 * 1. **关不掉噪音。** 浏览一次文件树会打两行 `[API] Browse filesystem request` +
 *    `WORKSPACES_ROOT is: ...`;git clone 每收到一块 stderr 打一行。真正的报错就
 *    埋在这些里面。想安静下来只能改代码重新部署。
 * 2. **没有时间。** 绝大多数行不带时间戳。用户报"下午三点左右出问题了",
 *    grep 出来的行根本对不上时刻。
 * 3. **没有来源。** 分不清一行是数据库、WebSocket 还是文件路由打的,
 *    没法按子系统缩小范围。
 *
 * ## 设计上刻意保守的几点
 *
 * - **默认档位 `info`,行为与升级前一致。** 这不是一次"顺便让日志变少"的改动 ——
 *   降级到 `debug` 的那些是逐条挑的(见各调用点),其余原样。
 * - **底层仍然走 `console.*`。** 不接管 stdout、不自己写文件。`prism.sh` 的
 *   `nohup ... > prism.log 2>&1` 因此完全不用改,测试里的 spy 也照常有效。
 * - **warn/error 走 stderr,info/debug 走 stdout。** 这样 `2> err.log` 能把
 *   两类分开收,而合并重定向(现在这样)行为不变。
 * - **CLI 的横幅输出不归它管。** `server/cli.js` 打的是 `prism status` 给人看的
 *   对齐表格,给每行加时间戳只会把它毁掉。那 32 处刻意保留 `console.log`。
 *
 * ## 用法
 *
 * ```ts
 * import { createLogger } from '@/shared/logger.js';
 * const log = createLogger('files');
 * log.debug('浏览目录', dirPath);   // 默认档位下不输出
 * log.error('读文件失败', error);   // 永远输出,走 stderr
 * ```
 */

export const LOG_LEVELS = ['silent', 'error', 'warn', 'info', 'debug', 'trace'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_RANK: Record<LogLevel, number> = {
  silent: 0, error: 1, warn: 2, info: 3, debug: 4, trace: 5,
};

export const DEFAULT_LOG_LEVEL: LogLevel = 'info';

/**
 * 解析档位。**认不出来的值不静默吞掉** —— 把 `PRISM_LOG_LEVEL=verbose` 当成
 * "那就默认吧"意味着部署方以为自己开了详细日志、实际没开,而且没有任何提示。
 * 所以退回默认的同时往 stderr 说一声。
 */
export const parseLogLevel = (raw: string | undefined | null): LogLevel | null => {
  if (raw === undefined || raw === null) return null;
  const normalized = raw.trim().toLowerCase();
  if (normalized === '') return null;
  return (LOG_LEVELS as readonly string[]).includes(normalized) ? (normalized as LogLevel) : null;
};

let cachedLevel: LogLevel | null = null;
let warnedAboutBadLevel = false;

const resolveLevel = (): LogLevel => {
  if (cachedLevel !== null) return cachedLevel;
  const raw = process.env.PRISM_LOG_LEVEL;
  const parsed = parseLogLevel(raw);
  if (parsed === null && raw !== undefined && raw.trim() !== '' && !warnedAboutBadLevel) {
    warnedAboutBadLevel = true;
    console.error(
      `[logger] 认不出 PRISM_LOG_LEVEL="${raw}",退回 ${DEFAULT_LOG_LEVEL}。`
      + ` 可选:${LOG_LEVELS.join(' / ')}`,
    );
  }
  cachedLevel = parsed ?? DEFAULT_LOG_LEVEL;
  return cachedLevel;
};

/** 当前生效档位。 */
export const getLogLevel = (): LogLevel => resolveLevel();

/**
 * 改档位。**只给测试和启动早期用** —— 运行中途改会让同一份日志前后两种详细度,
 * 事后读的人对不上。传 `null` 表示"忘掉缓存,下次重新读环境变量"。
 */
export const setLogLevel = (level: LogLevel | null): void => {
  cachedLevel = level;
  if (level === null) warnedAboutBadLevel = false;
};

/** 本地时间到毫秒。用本地时区而不是 UTC:读日志的人对的是自己手表上的时刻。 */
const timestamp = (): string => {
  const d = new Date();
  const p = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
};

const LEVEL_LABEL: Record<Exclude<LogLevel, 'silent'>, string> = {
  error: 'ERROR', warn: 'WARN ', info: 'INFO ', debug: 'DEBUG', trace: 'TRACE',
};

export type Logger = {
  readonly tag: string;
  error: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  trace: (...args: unknown[]) => void;
  /** 这一档现在会不会真的输出。用来跳过昂贵的字符串拼接。 */
  isEnabled: (level: Exclude<LogLevel, 'silent'>) => boolean;
  /** 不加任何前缀原样输出。给横幅/表格这类"排版本身就是内容"的场合。 */
  raw: (...args: unknown[]) => void;
};

/**
 * 建一个带来源标签的 logger。
 *
 * `tag` 会原样出现在每行里(`[files]`),所以取名按**能 grep 的子系统**来,
 * 不要按文件名 —— 文件会改名,子系统不会。
 */
export const createLogger = (tag: string): Logger => {
  const prefix = tag ? `[${tag}]` : '';

  const emit = (level: Exclude<LogLevel, 'silent'>, args: unknown[]): void => {
    if (LEVEL_RANK[resolveLevel()] < LEVEL_RANK[level]) return;
    const head = `${timestamp()} ${LEVEL_LABEL[level]}${prefix ? ` ${prefix}` : ''}`;
    // warn/error 走 stderr:合并重定向下行为不变,分开收时能只留住要紧的那半。
    if (level === 'error' || level === 'warn') console.error(head, ...args);
    else console.log(head, ...args);
  };

  return {
    tag,
    error: (...args: unknown[]) => emit('error', args),
    warn: (...args: unknown[]) => emit('warn', args),
    info: (...args: unknown[]) => emit('info', args),
    debug: (...args: unknown[]) => emit('debug', args),
    trace: (...args: unknown[]) => emit('trace', args),
    isEnabled: (level: Exclude<LogLevel, 'silent'>) => LEVEL_RANK[resolveLevel()] >= LEVEL_RANK[level],
    raw: (...args: unknown[]) => console.log(...args),
  };
};

/** 没有明确子系统时的兜底。新代码请自己 `createLogger('<子系统>')`。 */
export const logger = createLogger('prism');
