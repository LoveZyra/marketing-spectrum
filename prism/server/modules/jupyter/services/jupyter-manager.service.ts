/**
 * JupyterLab 进程管理:Prism 惰性拉起一个共享的 jupyter lab 实例,只绑回环,
 * 用随机 token 鉴权,base_url 固定 /jupyter 以便整棵 URL 树都走 Prism 的反代。
 *
 * 为什么是"一个共享实例"而不是每用户一个:这台部署本来就是所有登录用户共享
 * root 终端的模式(IS_SANDBOX 取舍),按用户隔离 kernel 在这里不提供真实的
 * 安全边界,只会成倍吃内存。root_dir 指向工作区根,所有项目都能打开。
 *
 * 环境变量(都有默认值,不配也能用):
 *   PRISM_JUPYTER_PORT      内部端口,默认 8890(只监听 127.0.0.1)
 *   PRISM_JUPYTER_BIN       可执行文件,默认 jupyter(子命令固定 lab)
 *   PRISM_JUPYTER_DISABLED  设为 1 整个功能下线(状态接口报 disabled)
 */

import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';

import { createTicketStore } from '@/shared/ticket-store.js';
import { WORKSPACES_ROOT } from '@/shared/utils.js';

export const JUPYTER_BASE_PATH = '/jupyter';

const DEFAULT_PORT = 8890;
const READY_TIMEOUT_MS = 90_000;
const READY_POLL_INTERVAL_MS = 700;
const STDERR_TAIL_LIMIT = 4_000;
// 连续快速崩溃就停手,别无限重拉。
const CRASH_WINDOW_MS = 15_000;
const CRASH_LIMIT = 3;

/** 浏览器端会话 cookie:入口票据换出来,之后 iframe 的所有请求都靠它。 */
export const JUPYTER_COOKIE_NAME = 'prism_jupyter';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

// 入口一次性票据(iframe 的第一跳带在查询串里,用一次即作废)。
const ENTRY_TICKET_TTL_MS = 60_000;

export type JupyterRuntime = { port: number; token: string };

export type JupyterStatus = {
  enabled: boolean;
  running: boolean;
  starting: boolean;
  ready: boolean;
  port: number;
  /** null = 还没试过;false = 上次启动确认命令不存在。 */
  installed: boolean | null;
  lastError: string | null;
};

export type EnsureResult =
  | { ok: true; runtime: JupyterRuntime }
  | { ok: false; reason: 'disabled' | 'not_installed' | 'start_failed'; detail: string };

/** jupyter lab 的启动参数。纯函数,单测直接盯参数形态。 */
export function buildJupyterArgs(options: { port: number; token: string; rootDir: string }): string[] {
  const { port, token, rootDir } = options;
  return [
    'lab',
    '--no-browser',
    // Prism 常以 root 跑,jupyter 默认拒绝 root,这里放开与整体部署一致。
    '--allow-root',
    '--ServerApp.ip=127.0.0.1',
    `--ServerApp.port=${port}`,
    '--ServerApp.port_retries=0',
    `--ServerApp.token=${token}`,
    `--ServerApp.base_url=${JUPYTER_BASE_PATH}`,
    `--ServerApp.root_dir=${rootDir}`,
    '--ServerApp.open_browser=False',
    // 闲置 kernel 两小时自动回收,lab 服务器本身常驻。
    '--MappingKernelManager.cull_idle_timeout=7200',
    '--MappingKernelManager.cull_interval=300',
  ];
}

/**
 * iframe 的入口地址:有目标文件就深链到 /lab/tree/<相对路径>,没有(或路径
 * 越出工作区根)就落在 /lab。逐段 encode,目录名里带空格/中文都安全。
 */
export function buildJupyterEntryUrl(options: { rootDir: string; targetPath?: string | null; ticket: string }): string {
  const { rootDir, targetPath, ticket } = options;
  const base = `${JUPYTER_BASE_PATH}/lab`;
  const suffix = `?prism_ticket=${encodeURIComponent(ticket)}`;

  if (typeof targetPath === 'string' && targetPath.trim()) {
    const normalizedRoot = rootDir.replace(/\\/g, '/').replace(/\/+$/, '');
    const normalizedTarget = targetPath.replace(/\\/g, '/');
    if (normalizedTarget === normalizedRoot) {
      return `${base}${suffix}`;
    }
    if (normalizedTarget.startsWith(`${normalizedRoot}/`)) {
      const relative = normalizedTarget.slice(normalizedRoot.length + 1);
      // ".." 段一律不深链 —— 防构造路径,退回 lab 根不损失功能。
      if (relative.split('/').every((segment) => segment !== '' && segment !== '..')) {
        const encoded = relative.split('/').map((segment) => encodeURIComponent(segment)).join('/');
        return `${base}/tree/${encoded}${suffix}`;
      }
    }
  }
  return `${base}${suffix}`;
}

/** Cookie 头里取一个值。没有就 null。 */
export function readCookieValue(cookieHeader: string | undefined, name: string): string | null {
  if (typeof cookieHeader !== 'string' || !cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return part.slice(eq + 1).trim() || null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 运行时状态(模块级单例;composition root 直接用导出的函数)
// ---------------------------------------------------------------------------

type ManagerState = {
  child: ChildProcess | null;
  runtime: JupyterRuntime | null;
  ready: boolean;
  starting: Promise<EnsureResult> | null;
  installed: boolean | null;
  lastError: string | null;
  stderrTail: string;
  deliberateStop: boolean;
  crashTimes: number[];
};

const state: ManagerState = {
  child: null,
  runtime: null,
  ready: false,
  starting: null,
  installed: null,
  lastError: null,
  stderrTail: '',
  deliberateStop: false,
  crashTimes: [],
};

const configuredPort = (): number => {
  const parsed = Number.parseInt(process.env.PRISM_JUPYTER_PORT ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : DEFAULT_PORT;
};

const configuredBin = (): string => process.env.PRISM_JUPYTER_BIN?.trim() || 'jupyter';

const isDisabled = (): boolean => process.env.PRISM_JUPYTER_DISABLED === '1';

/** 探活:base_url 下的 /api/status 用 token 打一发。 */
function probeReady(runtime: JupyterRuntime): Promise<boolean> {
  return new Promise((resolve) => {
    const request = http.get(
      {
        host: '127.0.0.1',
        port: runtime.port,
        path: `${JUPYTER_BASE_PATH}/api/status`,
        headers: { authorization: `token ${runtime.token}` },
        timeout: 3_000,
      },
      (response) => {
        response.resume();
        resolve(response.statusCode === 200);
      },
    );
    request.on('timeout', () => request.destroy(new Error('probe timeout')));
    request.on('error', () => resolve(false));
  });
}

function recordCrash(): void {
  const now = Date.now();
  state.crashTimes = state.crashTimes.filter((at) => now - at < CRASH_WINDOW_MS);
  state.crashTimes.push(now);
}

function crashLooping(): boolean {
  const now = Date.now();
  return state.crashTimes.filter((at) => now - at < CRASH_WINDOW_MS).length >= CRASH_LIMIT;
}

async function startJupyter(): Promise<EnsureResult> {
  const port = configuredPort();
  const token = crypto.randomBytes(24).toString('hex');
  const runtime: JupyterRuntime = { port, token };
  const bin = configuredBin();
  const args = buildJupyterArgs({ port, token, rootDir: WORKSPACES_ROOT });

  state.stderrTail = '';
  state.deliberateStop = false;

  const child = spawn(bin, args, {
    cwd: WORKSPACES_ROOT,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  state.child = child;
  state.runtime = runtime;
  state.ready = false;

  let spawnFailed: string | null = null;

  child.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      state.installed = false;
      spawnFailed = `${bin} 不存在(未安装 JupyterLab?)`;
    } else {
      spawnFailed = error.message;
    }
  });

  const collectTail = (chunk: Buffer) => {
    state.stderrTail = (state.stderrTail + chunk.toString()).slice(-STDERR_TAIL_LIMIT);
  };
  child.stderr?.on('data', collectTail);
  // jupyter 把启动日志写 stderr,stdout 基本安静;都收着,出错时一起看。
  child.stdout?.on('data', collectTail);

  child.on('exit', (code) => {
    if (state.child === child) {
      state.child = null;
      state.runtime = null;
      state.ready = false;
    }
    if (!state.deliberateStop) {
      recordCrash();
      const tail = state.stderrTail.trim().split('\n').slice(-8).join('\n');
      state.lastError = `jupyter 进程退出(code ${code ?? 'null'})${tail ? `:\n${tail}` : ''}`;
      console.warn(`[jupyter] 进程退出 code=${code ?? 'null'}`);
    }
  });

  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    if (spawnFailed !== null || state.child !== child) {
      const detail = spawnFailed ?? state.lastError ?? 'jupyter 启动失败';
      state.lastError = detail;
      return {
        ok: false,
        reason: state.installed === false ? 'not_installed' : 'start_failed',
        detail,
      };
    }
    if (await probeReady(runtime)) {
      state.ready = true;
      state.lastError = null;
      console.log(`[jupyter] lab 就绪:127.0.0.1:${port}${JUPYTER_BASE_PATH}`);
      return { ok: true, runtime };
    }
    if (Date.now() > deadline) {
      const detail = `jupyter ${READY_TIMEOUT_MS / 1000}s 内没有就绪`;
      state.lastError = detail;
      state.deliberateStop = true;
      child.kill('SIGTERM');
      return { ok: false, reason: 'start_failed', detail };
    }
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_INTERVAL_MS));
  }
}

/** 确保 lab 在跑并就绪。并发调用共享同一次启动。 */
export async function ensureJupyterRunning(): Promise<EnsureResult> {
  if (isDisabled()) {
    return { ok: false, reason: 'disabled', detail: 'PRISM_JUPYTER_DISABLED=1' };
  }
  if (state.ready && state.runtime && state.child) {
    return { ok: true, runtime: state.runtime };
  }
  if (state.starting) {
    return state.starting;
  }
  if (crashLooping()) {
    return {
      ok: false,
      reason: 'start_failed',
      detail: state.lastError ?? 'jupyter 连续崩溃,先看服务器日志再重试',
    };
  }
  state.starting = startJupyter().finally(() => {
    state.starting = null;
  });
  return state.starting;
}

/** 只读状态,给 /api/jupyter/status。 */
export function getJupyterStatus(): JupyterStatus {
  return {
    enabled: !isDisabled(),
    running: state.child !== null,
    starting: state.starting !== null,
    ready: state.ready,
    port: configuredPort(),
    installed: state.installed,
    lastError: state.lastError,
  };
}

/** 当前运行时(代理转发用)。没就绪返回 null。 */
export function getJupyterRuntime(): JupyterRuntime | null {
  return state.ready && state.runtime ? state.runtime : null;
}

/** 优雅收尾(index.js 的 shutdown 链调用)。 */
export function stopJupyter(): void {
  if (state.child) {
    state.deliberateStop = true;
    state.child.kill('SIGTERM');
    state.child = null;
    state.runtime = null;
    state.ready = false;
  }
}

// ---------------------------------------------------------------------------
// 鉴权:入口票据(一次性) + 会话 cookie(12h 滑动)
// ---------------------------------------------------------------------------

const entryTickets = createTicketStore({ ttlMs: ENTRY_TICKET_TTL_MS });

const sessions = new Map<string, { expiresAt: number }>();

function sweepSessions(): void {
  const now = Date.now();
  for (const [id, entry] of sessions) {
    if (entry.expiresAt <= now) sessions.delete(id);
  }
}

/** 铸一张 iframe 入口票(调用方必须已过 Prism JWT 鉴权)。 */
export function issueJupyterEntryTicket(userId: string | number): string {
  return entryTickets.issue({ userId });
}

/** 消费入口票,换一个会话 cookie 值。无效返回 null。 */
export function redeemJupyterEntryTicket(ticket: unknown): string | null {
  const payload = entryTickets.consume(ticket);
  if (!payload) return null;
  sweepSessions();
  const id = crypto.randomBytes(32).toString('hex');
  sessions.set(id, { expiresAt: Date.now() + SESSION_TTL_MS });
  return id;
}

/** 会话是否有效;命中顺延 TTL(用户一直在用就不掉线)。 */
export function isJupyterSessionValid(sessionId: string | null): boolean {
  if (!sessionId) return false;
  const entry = sessions.get(sessionId);
  if (!entry) return false;
  if (entry.expiresAt <= Date.now()) {
    sessions.delete(sessionId);
    return false;
  }
  entry.expiresAt = Date.now() + SESSION_TTL_MS;
  return true;
}

/** 仅供测试。 */
export function __resetJupyterAuthForTest(): void {
  entryTickets.reset?.();
  sessions.clear();
}
