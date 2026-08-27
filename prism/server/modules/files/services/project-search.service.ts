/**
 * 跨文件全局搜索(F10)。
 *
 * 文件树的搜索框只匹配**文件名**,而人真正想找的往往是内容 —— "那个函数叫什么来着"、
 * "这个常量还有谁在用"。之前唯一的办法是打开终端自己 grep。
 *
 * 用 ripgrep 而不是自己遍历:它已经是依赖(会话搜索在用),尊重 .gitignore,
 * 跳过二进制,而且比任何 JS 实现快一到两个数量级。
 *
 * 三道闸,都是为了让"一次搜索"不可能变成"一次拒绝服务":
 *   - 搜索根**必须**是调用者可见的项目目录(路由层用 resolveVisibleProjectRoot 解析,
 *     这里只接受已解析好的绝对路径);
 *   - 结果数、单行长度、超时都有硬上限,截断如实上报(而不是悄悄少给);
 *   - 模式与 glob 都走 `--` 之后,不可能被当成 rg 的参数。
 */

import { spawn } from 'node:child_process';
import path from 'node:path';

import { RIPGREP_MISSING_MESSAGE, resolveRipgrepPath } from '@/shared/ripgrep-path.js';

export type SearchMatch = {
  /** 相对项目根的路径 —— 绝对路径既没用又泄漏服务器目录结构。 */
  path: string;
  line: number;
  column: number;
  /** 命中所在行(已截断)。 */
  text: string;
};

export type SearchResult = {
  matches: SearchMatch[];
  /** 命中数超过上限被截断。 */
  truncated: boolean;
  /** 搜索本身失败(超时/rg 起不来),此时 matches 为空。 */
  error: string | null;
};

export type SearchOptions = {
  caseSensitive?: boolean;
  /** 正则搜索;默认按字面量(多数人搜的是字面量,而正则里的 . * ( ) 会让结果莫名其妙)。 */
  regex?: boolean;
  wholeWord?: boolean;
  /** 只搜匹配这些 glob 的文件,例如 `*.ts`。 */
  glob?: string;
  maxMatches?: number;
  timeoutMs?: number;
};

const DEFAULT_MAX_MATCHES = 300;
const DEFAULT_TIMEOUT_MS = 15_000;
/** 单行截断长度:压缩过的 JS 一行能有几百 KB,原样回传只会撑爆前端。 */
const MAX_LINE_LENGTH = 400;

/** 解析 rg 的 `--vimgrep` 行:`path:line:col:text`(路径里可能含冒号,所以从左边切三次)。 */
export function parseVimgrepLine(line: string): SearchMatch | null {
  // 从右往左找不行(text 里全是冒号);从左往右也不行(Windows 盘符)。
  // rg 在这里拿到的是**相对路径**(cwd = 项目根),所以左切三次是安全的。
  const first = line.indexOf(':');
  if (first < 0) return null;
  const second = line.indexOf(':', first + 1);
  if (second < 0) return null;
  const third = line.indexOf(':', second + 1);
  if (third < 0) return null;

  // rg 的搜索路径是 `.`,于是每条结果都带一个 `./` 前缀 —— 那是我们传给它的
  // 参数的残留,不是路径的一部分,界面上显示出来只是噪音。
  const filePath = line.slice(0, first).replace(/^\.\//, '');
  const lineNumber = Number.parseInt(line.slice(first + 1, second), 10);
  const column = Number.parseInt(line.slice(second + 1, third), 10);
  if (!Number.isFinite(lineNumber) || !Number.isFinite(column)) return null;

  const text = line.slice(third + 1);
  return {
    path: filePath,
    line: lineNumber,
    column,
    text: text.length > MAX_LINE_LENGTH ? `${text.slice(0, MAX_LINE_LENGTH)}…` : text,
  };
}

export async function searchProjectFiles(
  projectRoot: string,
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult> {
  const pattern = query.trim();
  if (!pattern) return { matches: [], truncated: false, error: null };

  const maxMatches = Math.min(Math.max(1, options.maxMatches ?? DEFAULT_MAX_MATCHES), 1000);
  const timeoutMs = Math.min(Math.max(1000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS), 60_000);

  const args = [
    '--vimgrep',
    '--no-messages',
    '--hidden',              // 隐藏文件也搜(.env.example 这类经常正是要找的)
    '--glob', '!.git/*',     // 但 .git 里面永远不是用户要找的
    '--max-count', String(maxMatches),
    '--max-filesize', '2M',  // 单文件上限:锁文件、打包产物搜进去只有噪音
  ];
  if (!options.caseSensitive) args.push('--ignore-case');
  if (!options.regex) args.push('--fixed-strings');
  if (options.wholeWord) args.push('--word-regexp');
  if (options.glob) args.push('--glob', options.glob);
  // `--` 之后的一切都是模式/路径,不会被当成参数 —— 用户输入以 `-` 开头时也安全。
  args.push('--', pattern, '.');

  return new Promise<SearchResult>((resolve) => {
    const rg = spawn(resolveRipgrepPath() ?? 'rg', args, {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const matches: SearchMatch[] = [];
    let truncated = false;
    let buffer = '';
    let settled = false;

    const finish = (error: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { rg.kill(); } catch { /* 已经退了 */ }
      resolve({ matches, truncated, error });
    };

    const timer = setTimeout(() => {
      // 超时不是"没找到" —— 如实说,否则用户会以为项目里真的没有。
      finish(`搜索超过 ${Math.round(timeoutMs / 1000)} 秒仍未结束,已中止。缩小范围(加文件类型过滤)再试。`);
    }, timeoutMs);

    rg.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');

        const parsed = parseVimgrepLine(line);
        if (parsed) matches.push(parsed);
        if (matches.length >= maxMatches) {
          truncated = true;
          finish(null);
          return;
        }
      }
    });

    rg.on('error', (error) => {
      // ENOENT 只有一个原因:这台机器上没有 rg。给能照着做的一句话,
      // 而不是把 spawn 的原文抛给用户。
      const code = (error as NodeJS.ErrnoException).code;
      finish(code === 'ENOENT' ? RIPGREP_MISSING_MESSAGE : `搜索启动失败:${(error as Error).message}`);
    });

    rg.on('close', (code) => {
      // rg 的退出码:0 有命中、1 无命中、2 出错。1 不是错误。
      finish(code === 2 ? '搜索过程中出错(可能是无效的正则)。' : null);
    });
  });
}

/** 给调用方拼绝对路径用(不进 API 返回值)。 */
export function resolveMatchPath(projectRoot: string, relativePath: string): string {
  return path.resolve(projectRoot, relativePath);
}
