import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { createLogger } from './logger.js';

const log = createLogger('claude-cli');
const DEFAULT_CLAUDE_COMMAND = 'claude';
const CLAUDE_SCRIPT_EXTENSIONS = new Set(['.cjs', '.js', '.jsx', '.mjs', '.ts', '.tsx']);
const CLAUDE_WRAPPER_SEGMENTS = ['node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'] as const;

export type ResolveClaudeCodeExecutablePathDependencies = {
  execFileSync?: typeof execFileSync;
  existsSync?: typeof fs.existsSync;
  platform?: NodeJS.Platform;
  readFileSync?: typeof fs.readFileSync;
};

function getPathApi(platform: NodeJS.Platform) {
  return platform === 'win32' ? path.win32 : path;
}

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function isPathLike(value: string): boolean {
  return value.includes('/') || value.includes('\\');
}

function resolveClaudeWrapperBinary(
  wrapperPath: string,
  deps: Required<ResolveClaudeCodeExecutablePathDependencies>,
): string | null {
  const pathApi = getPathApi(deps.platform);
  const directCandidate = pathApi.resolve(pathApi.dirname(wrapperPath), ...CLAUDE_WRAPPER_SEGMENTS);

  if (deps.existsSync(directCandidate)) {
    return directCandidate;
  }

  let content: string;
  try {
    content = deps.readFileSync(wrapperPath, 'utf8');
  } catch {
    return null;
  }

  const matches = content.matchAll(/["']([^"'\\\r\n]*claude\.exe)["']/gi);
  for (const match of matches) {
    const rawTarget = match[1]
      .replace(/^\$basedir[\\/]/i, '')
      .replace(/^%dp0%[\\/]/i, '')
      .replace(/^%~dp0[\\/]/i, '');
    const normalizedTarget = rawTarget.replace(/[\\/]/g, pathApi.sep);
    const candidate = pathApi.isAbsolute(normalizedTarget)
      ? normalizedTarget
      : pathApi.resolve(pathApi.dirname(wrapperPath), normalizedTarget);

    if (deps.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function resolveWindowsClaudeExecutablePath(
  configuredPath: string,
  deps: Required<ResolveClaudeCodeExecutablePathDependencies>,
): string {
  const pathApi = getPathApi(deps.platform);
  const extension = pathApi.extname(configuredPath).toLowerCase();
  const explicitPath = isPathLike(configuredPath) || pathApi.isAbsolute(configuredPath);

  if (CLAUDE_SCRIPT_EXTENSIONS.has(extension)) {
    return configuredPath;
  }

  if (explicitPath && extension === '.exe') {
    return configuredPath;
  }

  if (explicitPath) {
    return resolveClaudeWrapperBinary(configuredPath, deps) ?? configuredPath;
  }

  try {
    const stdout = deps.execFileSync('where.exe', [configuredPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const candidates = stdout
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter(Boolean);

    for (const candidate of candidates) {
      if (pathApi.extname(candidate).toLowerCase() === '.exe') {
        return candidate;
      }
    }

    for (const candidate of candidates) {
      const resolved = resolveClaudeWrapperBinary(candidate, deps);
      if (resolved) {
        return resolved;
      }
    }
  } catch {
    return configuredPath;
  }

  return configuredPath;
}

export function resolveClaudeCodeExecutablePath(
  configuredPath: string | undefined = process.env.CLAUDE_CLI_PATH,
  dependencies: ResolveClaudeCodeExecutablePathDependencies = {},
): string {
  const deps: Required<ResolveClaudeCodeExecutablePathDependencies> = {
    execFileSync: dependencies.execFileSync ?? execFileSync,
    existsSync: dependencies.existsSync ?? fs.existsSync,
    platform: dependencies.platform ?? process.platform,
    readFileSync: dependencies.readFileSync ?? fs.readFileSync,
  };

  const normalizedPath = stripWrappingQuotes(configuredPath || DEFAULT_CLAUDE_COMMAND);
  if (deps.platform !== 'win32') {
    return normalizedPath;
  }

  return resolveWindowsClaudeExecutablePath(normalizedPath, deps);
}

/* ------------------------------------------------------------------ */
/*  hm(A2):Prism 起的所有 claude 统一用 SDK 随包的那一份               */
/* ------------------------------------------------------------------ */

/**
 * `CLAUDE_CLI_PATH` 有没有**显式**配。
 *
 * 配了(哪怕写的是 `claude`)= 运维要自己指定,所有入口(对话、终端、接管、登录、
 * SkillWhet)一起听它的;没配 = 用 SDK 随包的二进制。想临时退回全局 CLI 就写
 * `CLAUDE_CLI_PATH=claude`。
 */
export function configuredClaudeCliPath(
  configuredPath: string | undefined = process.env.CLAUDE_CLI_PATH,
): string | null {
  if (typeof configuredPath !== 'string') return null;
  const normalized = stripWrappingQuotes(configuredPath);
  return normalized ? normalized : null;
}

let missingBundledWarned = false;

/**
 * SDK 的 `pathToClaudeCodeExecutable` 该传什么。
 *
 * - 配了 `CLAUDE_CLI_PATH` → 它;
 * - 没配 → **随包二进制的绝对路径**(与 SDK 自己挑的是同一个文件,见 resolveBundledClaudeBinary)。
 *   hm 初版没配就不传、让 SDK 自己挑 —— 复审发现 SDK 每次 `query()` 挑的时候都跑一遍
 *   `process.report.getReport()`(不缓存,同步,还会对每个 TCP 句柄做反向 DNS),解析慢的机器上
 *   每起一个 runtime 都卡一下事件循环。这里挑一次、缓存,直接传;
 * - 随包的也找不到(`npm install --omit=optional`、拷来的 node_modules 平台不对)→ `'claude'`(PATH 上的全局),
 *   并打一行错误日志。hm 初版此时不传,SDK 直接抛 "Native CLI binary … not found",对话全挂而登录检查还显示已安装。
 */
export function sdkExecutableOption(
  configuredPath: string | undefined = process.env.CLAUDE_CLI_PATH,
  dependencies: ResolveClaudeCodeExecutablePathDependencies & BundledClaudeBinaryDependencies = {},
): string {
  const configured = configuredClaudeCliPath(configuredPath);
  if (configured) return resolveClaudeCodeExecutablePath(configured, dependencies);
  const { platform, arch, preferMusl, resolve, exists } = dependencies;
  const binaryDeps: BundledClaudeBinaryDependencies = Object.fromEntries(
    Object.entries({ platform, arch, preferMusl, resolve, exists }).filter(([, value]) => value !== undefined),
  );
  const bundled = resolveBundledClaudeBinary(binaryDeps);
  if (bundled) return bundled;
  if (!missingBundledWarned) {
    missingBundledWarned = true;
    log.error('找不到 SDK 随包的 claude 二进制(平台包没装?),退回 PATH 上的 claude —— 版本不受 Prism 控制。'
      + '检查 node_modules/@anthropic-ai/claude-agent-sdk-<平台>/claude,或用 CLAUDE_CLI_PATH 指定。');
  }
  return DEFAULT_CLAUDE_COMMAND;
}

const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';

export type BundledClaudeBinaryDependencies = {
  platform?: NodeJS.Platform | string;
  arch?: string;
  /** Linux 上是不是 musl(SDK 用 `process.report` 判:没有 glibcVersionRuntime = musl)。 */
  preferMusl?: boolean;
  /** 模块解析 —— 默认锚在 SDK 自己的入口文件上,与 SDK 内部 `createRequire(sdk.mjs).resolve` 同一个起点。 */
  resolve?: (id: string) => string;
  exists?: (candidate: string) => boolean;
};

let muslProbe: boolean | undefined;
/** 与 SDK 同一个判据(sdk.mjs:`process.report.getReport().header.glibcVersionRuntime === undefined`)。 */
function detectMusl(platform: string): boolean {
  if (platform !== 'linux') return false;
  if (muslProbe !== undefined) return muslProbe;
  try {
    const report = typeof process.report?.getReport === 'function'
      ? (process.report.getReport() as { header?: { glibcVersionRuntime?: string } })
      : null;
    muslProbe = report != null && report.header?.glibcVersionRuntime === undefined;
  } catch {
    muslProbe = false;
  }
  return muslProbe;
}

/**
 * 随包二进制的候选顺序 —— **逐字照抄 SDK 0.3.285 的 `SV()`**:
 * linux 上 musl 优先时先 `-musl` 后 glibc,否则反过来;其它平台只有一个;android 单列。
 * `claude-cli-path.test.ts` 对着 sdk.mjs 断言这段逻辑没变,SDK 换版改了顺序就会变红。
 */
export function bundledClaudeBinaryCandidates(platform: string, arch: string, preferMusl: boolean): string[] {
  const exe = platform === 'win32' ? '.exe' : '';
  let packages: string[];
  if (platform === 'android') {
    packages = [`${SDK_PACKAGE}-linux-${arch}-android`];
  } else if (platform === 'linux') {
    packages = preferMusl
      ? [`${SDK_PACKAGE}-linux-${arch}-musl`, `${SDK_PACKAGE}-linux-${arch}`]
      : [`${SDK_PACKAGE}-linux-${arch}`, `${SDK_PACKAGE}-linux-${arch}-musl`];
  } else {
    packages = [`${SDK_PACKAGE}-${platform}-${arch}`];
  }
  return packages.map((pkg) => `${pkg}/claude${exe}`);
}

function sdkAnchoredResolver(): ((id: string) => string) | null {
  try {
    const localRequire = createRequire(import.meta.url);
    const sdkEntry = localRequire.resolve(SDK_PACKAGE);
    const anchored = createRequire(sdkEntry);
    return (id: string) => anchored.resolve(id);
  } catch {
    return null;
  }
}

let bundledCache: { value: string | null } | null = null;

/**
 * SDK 随包的那个 claude 在哪 —— 与 SDK 不传 `pathToClaudeCodeExecutable` 时选中的是
 * **同一个文件**(同样的候选顺序、同样的解析起点)。只有终端里的命令串与
 * SkillWhet 这类"自己起进程"的入口要用它;SDK 那两条路直接不传路径。
 *
 * 找不到返回 null(调用方回落 `'claude'` 并 warn)。不带依赖注入时结果缓存 ——
 * 进程生命周期里包不会变。
 */
export function resolveBundledClaudeBinary(dependencies: BundledClaudeBinaryDependencies = {}): string | null {
  const injected = Object.keys(dependencies).length > 0;
  if (!injected && bundledCache) return bundledCache.value;

  const platform = String(dependencies.platform ?? process.platform);
  const arch = String(dependencies.arch ?? process.arch);
  const preferMusl = dependencies.preferMusl ?? detectMusl(platform);
  const resolve = dependencies.resolve ?? sdkAnchoredResolver();
  const exists = dependencies.exists ?? ((candidate: string) => fs.existsSync(candidate));

  let found: string | null = null;
  if (resolve) {
    for (const candidate of bundledClaudeBinaryCandidates(platform, arch, preferMusl)) {
      try {
        const resolved = resolve(candidate);
        if (exists(resolved)) {
          found = resolved;
          break;
        }
      } catch {
        // 这个平台包没装 —— 试下一个
      }
    }
  }
  if (!injected) bundledCache = { value: found };
  return found;
}

/** 单测用:清掉随包路径与 musl 探测的缓存。 */
export function resetBundledClaudeBinaryCacheForTests(): void {
  bundledCache = null;
  muslProbe = undefined;
}

export type ShellClaudeCommand = {
  /** 拼进命令串的可执行文件(已按需加引号)。 */
  command: string;
  source: 'configured' | 'bundled' | 'path';
};

/** POSIX shell 单引号转义 —— 路径进 `bash -c` 串之前必须过这一道。 */
export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * 终端里(接管、登录)要敲的那个 claude。
 *
 * 顺序:`CLAUDE_CLI_PATH` 显式配了 → 用它;否则随包二进制;都没有 → `claude`(PATH),
 * 由调用方 warn。返回的 `command` 已经可以直接拼进 `bash -c` 串。
 */
export function resolveClaudeCommandForShell(
  configuredPath: string | undefined = process.env.CLAUDE_CLI_PATH,
  dependencies: BundledClaudeBinaryDependencies = {},
): ShellClaudeCommand {
  const configured = configuredClaudeCliPath(configuredPath);
  if (configured) {
    return { command: isPathLike(configured) ? shellQuote(configured) : configured, source: 'configured' };
  }
  const bundled = resolveBundledClaudeBinary(dependencies);
  if (bundled) return { command: shellQuote(bundled), source: 'bundled' };
  return { command: DEFAULT_CLAUDE_COMMAND, source: 'path' };
}

/**
 * 把 Prism 用的那个 claude 所在目录放到 PATH 最前(普通终端、接管、SkillWhet 的 `whet serve` 用)。
 *
 * - 没配 `CLAUDE_CLI_PATH` → 随包二进制的目录;
 * - 配成**绝对路径**(如 `/opt/claude/bin/claude`)→ 它所在的目录 —— 复审:原来配了就不动 PATH,
 *   结果对话 / 接管 / 登录用配置的那个,普通终端与 SkillWhet 的 `claude -p` 却还是 PATH 上的全局,
 *   与 `.env.example` 写的"所有入口一起"不符;
 * - 配成**裸命令名**(如 `claude`)或相对路径 → 不动 PATH:运维要退回全局 CLI,终端里敲的 `claude` 也跟着退回。
 *   注意:配成 `/usr/bin/claude` 这类系统目录会把整个目录提到最前(`.env.example` 里写明了,建议指到只放 claude 的目录)。
 * 随包目录里只有 `claude` / README / LICENSE / package.json。
 */
export function withBundledClaudeOnPath(
  env: NodeJS.ProcessEnv,
  dependencies: BundledClaudeBinaryDependencies & { configuredPath?: string | undefined } = {},
): NodeJS.ProcessEnv {
  const { configuredPath = env.CLAUDE_CLI_PATH, ...binaryDeps } = dependencies;
  const platform = String(binaryDeps.platform ?? process.platform);
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const configured = configuredClaudeCliPath(configuredPath);
  let binary: string | null;
  if (configured) {
    // 只认绝对路径:相对路径进 PATH 会让每个项目的 node_modules/.bin 之类盖住系统命令(复审)
    if (!isPathLike(configured) || !pathApi.isAbsolute(configured)) return { ...env };
    binary = configured;
  } else {
    binary = resolveBundledClaudeBinary(binaryDeps);
  }
  if (!binary) return { ...env };
  const dir = pathApi.dirname(binary);
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'PATH';
  const delimiter = platform === 'win32' ? ';' : ':';
  const rest = String(env[pathKey] ?? '').split(delimiter).filter((entry) => entry && entry !== dir);
  return { ...env, [pathKey]: [dir, ...rest].join(delimiter) };
}
