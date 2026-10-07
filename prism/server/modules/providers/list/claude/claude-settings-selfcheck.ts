import fsSync, { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CROSS_SESSION_TOOLS, PRISM_OWNED_CLI_ENV_KEYS } from '@/shared/claude-runtime-env.js';

/**
 * `~/.claude/settings.json` 的启动自检:只在日志里报告,不替运维改这份文件。
 *
 * 这份文件属于运维(里面有网关 token),而它同时影响 Prism 起的每个 claude 与终端里、cron 里
 * 的 claude。Prism 能做的是启动时看一眼,把会出事的几项在日志里说清楚:
 *
 * 1. `crossSessionInbound: "refuse"` 与 `permissions.deny` 里的 `SendMessage` / `ListAgents`:
 *    这是覆盖所有读用户设置的 claude(终端、SkillWhet、ma-api)的第一层;
 *    Prism 自己起的进程另有两层,所以缺了只是 warn;
 * 2. `env` 块里不许有 Prism 按 runtime 传的变量:settings 的 env 优先于进程 env,
 *    写在这里会把按模型给的窗口等静默盖掉;
 * 3. `cleanupPeriodDays`:不设时 CLI 默认 30 天清 transcript,
 *    30 天前的会话在 Prism 里就续不上了(部署文档建议 3650)。
 */
export type ClaudeSettingsFinding = { level: 'error' | 'warn' | 'info'; message: string };

/**
 * settings.json 不是合法 JSON 时,CLI 会整份忽略它:env 里的网关地址 / 令牌都不生效,请求直接打向官方 API,
 * 表现为「Not logged in · Please run /login」,别名映射全空。最常见的来源是从部署文档抄了带 `//` 注释的
 * 片段(那是 jsonc 说明写法)。这句人话在自检、模型映射接口、实测失败里共用。
 */
export function describeSettingsParseError(raw: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  // 去掉字符串字面量再找 `//`,别把 URL 里的 https:// 当成注释
  const withoutStrings = raw.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  const hasComments = /(^|[^:])\/\/|\/\*/.test(withoutStrings);
  return `~/.claude/settings.json 不是合法 JSON(${detail})—— CLI 会整份忽略它:env 里的网关地址、令牌、别名映射、`
    + `permissions 全部不生效(对话 / 实测会报 Not logged in)。`
    + (hasComments ? '文件里有 // 注释:JSON 不允许注释,删掉注释(部署文档里的注释只是说明)即可。' : '先把它改回合法 JSON(可用 python3 -m json.tool 检查)。');
}

export type ClaudeSettingsShape = {
  env?: Record<string, unknown>;
  permissions?: { deny?: unknown };
  crossSessionInbound?: unknown;
  cleanupPeriodDays?: unknown;
};

/** 纯函数,单测钉规则。`settings === null` 表示文件不存在或读不出来。 */
export function checkClaudeUserSettings(settings: ClaudeSettingsShape | null): ClaudeSettingsFinding[] {
  const findings: ClaudeSettingsFinding[] = [];
  if (!settings) {
    findings.push({
      level: 'warn',
      message: '没有读到 ~/.claude/settings.json(或解析失败)—— 部署文档要求的 cleanupPeriodDays / crossSessionInbound / permissions.deny 三项都不在',
    });
    return findings;
  }

  const env = settings.env && typeof settings.env === 'object' ? settings.env : {};
  const owned = PRISM_OWNED_CLI_ENV_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(env, key));
  if (owned.length > 0) {
    findings.push({
      level: 'warn',
      message: `settings.json 的 env 里有 ${owned.join(' / ')} —— 这几个由 Prism 按会话 / 模型传,写在这里会把 Prism 给的值静默盖掉(settings 的 env 优先),请删掉`,
    });
  }

  if (settings.crossSessionInbound !== 'refuse') {
    findings.push({
      level: 'warn',
      message: `settings.json 没有 "crossSessionInbound": "refuse"(现在是 ${JSON.stringify(settings.crossSessionInbound ?? null)})—— 终端 / SkillWhet / cron 里的 claude 会接收别的会话投来的消息`,
    });
  }

  const deny = Array.isArray(settings.permissions?.deny) ? (settings.permissions!.deny as unknown[]) : [];
  const missing = CROSS_SESSION_TOOLS.filter((tool) => !deny.includes(tool));
  if (missing.length > 0) {
    findings.push({
      level: 'warn',
      message: `settings.json 的 permissions.deny 里缺 ${missing.join(' / ')} —— 终端 / SkillWhet / cron 里的 claude 能给别的会话发消息(所有人同在 jovyan 下)`,
    });
  }

  const days = typeof settings.cleanupPeriodDays === 'number' ? settings.cleanupPeriodDays : null;
  if (days === null) {
    findings.push({
      level: 'warn',
      message: 'settings.json 没设 cleanupPeriodDays —— CLI 默认 30 天清掉 transcript,更早的会话在 Prism 里续不上;部署文档建议 3650',
    });
  } else if (days < 365) {
    findings.push({
      level: 'info',
      message: `settings.json 的 cleanupPeriodDays 是 ${days} —— 超过这么多天的会话 transcript 会被 CLI 清掉`,
    });
  }
  return findings;
}

export async function readClaudeUserSettingsForCheck(
  settingsPath: string = path.join(os.homedir(), '.claude', 'settings.json'),
): Promise<ClaudeSettingsShape | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(settingsPath, 'utf8')) as ClaudeSettingsShape;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** 文件在、但解析不了 → 返回那句人话;不存在 / 能解析 → null。 */
export async function readClaudeSettingsParseProblem(
  settingsPath: string = path.join(os.homedir(), '.claude', 'settings.json'),
): Promise<string | null> {
  let raw: string;
  try {
    raw = await fs.readFile(settingsPath, 'utf8');
  } catch {
    return null;
  }
  try {
    JSON.parse(raw);
    return null;
  } catch (error) {
    return describeSettingsParseError(raw, error);
  }
}

/**
 * 子进程环境清洗(`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`)的依赖自检。
 *
 * 这一轮用的网关 key(settings.json 的 token、共享网关的默认 key、个人 key)都在 CLI 自己的进程环境里,
 * Bash 工具里 `echo $ANTHROPIC_AUTH_TOKEN` 就能看到。开了清洗之后 Bash / hook / MCP 子进程里
 * 不再有这些变量(文件读写、联网、用户都不变),但 CLI 在 Linux 上要 bubblewrap + socat,
 * 缺一个就每个回合都起不来(缺 bwrap:进程直接退出;缺 socat:每轮回一句 "Sandbox is required but failed")。
 * 所以开了却缺依赖时启动就用 error 级说清楚。Prism 把进程环境原样转给 CLI,开关就是 .env 里这一行。
 */
export function checkSubprocessScrubDeps(
  env: NodeJS.ProcessEnv = process.env,
  which: (bin: string) => boolean = commandOnPath,
): ClaudeSettingsFinding | null {
  if (env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB !== '1') return null;
  const missing = ['bwrap', 'socat'].filter((bin) => !which(bin));
  if (missing.length === 0) return null;
  return {
    level: 'error',
    message: `开了 CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1,但 PATH 里没有 ${missing.join(' / ')} —— CLI 每个回合都会起不来。`
      + '装上 bubblewrap 与 socat(apt-get install -y bubblewrap socat),或去掉这一行。',
  };
}

function commandOnPath(bin: string): boolean {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  return dirs.some((dir) => {
    try {
      fsSync.accessSync(path.join(dir, bin), fsSync.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/** 启动时跑一次,把结论打进日志(前缀「claude 设置自检」,部署文档按它 grep)。 */
export async function runClaudeSettingsSelfCheck(logger: {
  warn: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
}): Promise<ClaudeSettingsFinding[]> {
  const scrubProblem = checkSubprocessScrubDeps();
  if (scrubProblem) (logger.error ?? logger.warn)(`[claude 设置自检] ${scrubProblem.message}`);
  // 文件在但不是合法 JSON:这比"缺哪几项"严重得多(CLI 整份忽略),单独说、用 error 级
  const parseProblem = await readClaudeSettingsParseProblem();
  if (parseProblem) {
    (logger.error ?? logger.warn)(`[claude 设置自检] ${parseProblem}`);
    return [{ level: 'error', message: parseProblem }];
  }
  const findings = checkClaudeUserSettings(await readClaudeUserSettingsForCheck());
  if (findings.length === 0) {
    logger.info('[claude 设置自检] ~/.claude/settings.json 三项(跨会话拒收 / 两个工具禁用 / transcript 保留期)都在,env 里没有 Prism 自己传的变量');
  }
  for (const finding of findings) {
    const write = finding.level === 'error' ? (logger.error ?? logger.warn) : logger[finding.level];
    write(`[claude 设置自检] ${finding.message}`);
  }
  return findings;
}
