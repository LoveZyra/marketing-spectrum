import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import pty, { type IPty } from 'node-pty';
import { WebSocket, type RawData } from 'ws';

import { projectsDb } from '@/modules/database/index.js';
import { claimForShell, releaseShellClaim } from '@/modules/websocket/services/conversation-ownership.service.js';
import { pushReplayChunk } from '@/modules/websocket/services/shell-replay-buffer.js';
import { readSocketViewer, stampSocketViewer } from '@/shared/project-visibility.js';
import type { AuthenticatedWebSocketRequest } from '@/shared/types.js';
import { parseIncomingJsonObject } from '@/shared/utils.js';

type ShellIncomingMessage = {
  type?: string;
  /** 显式请求在终端里接管这段对话(默认 false = 普通终端)。 */
  takeover?: boolean;
  data?: string;
  cols?: number;
  rows?: number;
  projectPath?: string;
  sessionId?: string;
  hasSession?: boolean;
  provider?: string;
  initialCommand?: string;
  isPlainShell?: boolean;
  forceRestart?: boolean;
  /** F10:多标签时每个终端一个 id;不传则与改动前行为逐字一致。 */
  terminalId?: string;
};

type PtySessionEntry = {
  pty: IPty;
  ws: WebSocket | null;
  buffer: string[];
  /** buffer 里所有 chunk 的字节数合计 —— 回放缓冲的预算按字节收,不按条数。 */
  bufferedBytes: number;
  timeoutId: NodeJS.Timeout | null;
  projectPath: string;
  sessionId: string | null;
  /**
   * 这个 PTY 是不是"接管"起来的。两个地方要用:
   *
   * 1. 复用判定 —— 普通终端和接管终端的键是同一个(都带 sessionId),所以先开了
   *    普通终端、再点接管时,会命中复用分支直接 return,接管逻辑一次都不执行。
   *    这就是"点接管有时不生效"。模式不同就不能复用。
   * 2. 断开处理 —— 接管终端断开必须立刻收掉,不能留 30 分钟。
   */
  isTakeover: boolean;
  /** 被接管的 app 会话 id,断开时用它释放占用。 */
  claimedSessionId: string | null;
};

const ptySessionsMap = new Map<string, PtySessionEntry>();
const PTY_SESSION_TIMEOUT = 30 * 60 * 1000;
const SHELL_URL_PARSE_BUFFER_LIMIT = 32768;
/**
 * 回放缓冲的字节预算。老的上限只数**条数**(5000 chunk),而 chunk 大小不设限 ——
 * 终端里 `cat` 一个大文件,单个 PTY 的缓冲能挂住几十 MB 直到 30 分钟超时回收
 * (chat 侧的 run registry 早改成字节预算了,这里当时漏掉)。2MiB 足够回放一屏
 * 滚动历史;超预算从头部裁,行为与旧的 shift 一致。
 */
const PTY_REPLAY_BUFFER_MAX_BYTES = 2 * 1024 * 1024;
const PTY_REPLAY_BUFFER_MAX_CHUNKS = 5000;

type ShellWebSocketDependencies = {
  /**
   * 释放 chat 那边的常驻 runtime,把对话让给终端。由组合根注入 —— 模块不直接
   * import claude-sdk.js。
   */
  releaseConversation?: (providerSessionId: string) => Promise<{ released: boolean; reason: string }>;
  resolveProviderSessionId: (
    sessionId: string,
    provider: string,
  ) => string | null | undefined;
  stripAnsiSequences: (content: string) => string;
  normalizeDetectedUrl: (url: string) => string | null;
  extractUrlsFromText: (content: string) => string[];
  shouldAutoOpenUrlFromOutput: (content: string) => boolean;
};

/**
 * Reads a string field from untyped payloads and falls back when absent.
 */
function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/**
 * Reads a boolean field from untyped payloads and falls back when absent.
 */
function readBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Reads a finite number field from untyped payloads and falls back when absent.
 */
function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Parses incoming websocket shell messages and keeps processing safe when
 * malformed payloads are received.
 */
function parseShellMessage(rawMessage: RawData): ShellIncomingMessage | null {
  const payload = parseIncomingJsonObject(rawMessage);
  if (!payload) {
    return null;
  }

  return payload as ShellIncomingMessage;
}

const SAFE_SESSION_ID_PATTERN = /^[a-zA-Z0-9_.\-:]+$/;

/**
 * 终端为什么没能接管这段对话。
 *
 * 以前这里只有"能/不能"两种结果,不能的时候静默退回一个全新的 `claude` —— 用户
 * 以为在继续原来的对话,其实在跟一段空白记录说话,而且没有任何提示。
 */
type ResumeResolution =
  | { ok: true; sessionId: string }
  | { ok: false; reason: 'no_session' | 'not_recorded' | 'invalid' | 'forbidden' };

function resolveResumeSessionId(
  message: ShellIncomingMessage,
  dependencies: ShellWebSocketDependencies
): ResumeResolution {
  const hasSession = readBoolean(message.hasSession);
  const sessionId = readString(message.sessionId);
  const provider = readString(message.provider, 'claude');

  if (!hasSession || !sessionId) {
    return { ok: false, reason: 'no_session' };
  }

  let resumeSessionId: string | null | undefined;
  try {
    resumeSessionId = dependencies.resolveProviderSessionId(sessionId, provider);
  } catch (error) {
    console.error('Failed to resolve provider session ID:', error);
    resumeSessionId = undefined;
  }

  // null 与 undefined 意思不同,以前被合并处理了:null 是"查过了,这个会话还没有
  // provider 端的 id"(第一轮还没跑完,或者第一轮失败了),undefined 是"查询本身
  // 出错"。前者退回 app id 去 resume 必然失败,所以分开报。
  if (resumeSessionId === null) {
    return { ok: false, reason: 'not_recorded' };
  }

  const resolvedSessionId = resumeSessionId === undefined ? sessionId : resumeSessionId;
  if (!resolvedSessionId || !SAFE_SESSION_ID_PATTERN.test(resolvedSessionId)) {
    return { ok: false, reason: 'invalid' };
  }

  return { ok: true, sessionId: resolvedSessionId };
}

/**
 * Resolves provider command line for plain shell and agent-backed shell modes.
 */
/**
 * 终端里跑什么。
 *
 * 默认是**普通终端**,不再自动 `claude --resume`。以前只要选中了会话,打开 Shell
 * 就会另起一个 Claude 进程接管同一段对话,而 chat 那边的常驻 runtime 还活着 ——
 * 两个进程往同一份 transcript 上写,谁也看不见谁。而 Shell 面板真正不可替代的
 * 用途是"在项目目录里跑命令"(git、测试、脚本),那件事不需要第二个 Claude。
 *
 * 要在终端里继续对话仍然可以,但要显式接管(`takeover`),走释放 → 交接的流程。
 */
function buildShellCommand(
  message: ShellIncomingMessage,
  resume: ResumeResolution
): string {
  const initialCommand = readString(message.initialCommand);
  const wantsTakeover = readBoolean(message.takeover);

  if (initialCommand) {
    return initialCommand;
  }

  if (wantsTakeover && resume.ok) {
    return `claude --resume "${resume.sessionId}"`;
  }

  // 空串 = 起用户的登录 shell(下面 pty.spawn 的 `-c ''` 会落到交互式 shell)。
  return '';
}

function readEnvValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const resolvedKey = Object.keys(env).find((envKey) => envKey.toLowerCase() === key.toLowerCase());
  return resolvedKey ? env[resolvedKey] : undefined;
}

function getPathEnvKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'PATH';
}

function prioritizeUserNpmGlobalBin(env: NodeJS.ProcessEnv): { key: string; value: string | undefined } {
  const pathKey = getPathEnvKey(env);
  const currentPath = env[pathKey];
  if (!currentPath) {
    return { key: pathKey, value: currentPath };
  }

  const delimiter = path.delimiter;
  const pathEntries = currentPath.split(delimiter).filter(Boolean);
  const npmPrefix = readEnvValue(env, 'npm_config_prefix');
  const appData = readEnvValue(env, 'APPDATA');
  const candidates = [
    npmPrefix || '',
    npmPrefix ? path.join(npmPrefix, 'bin') : '',
    appData ? path.join(appData, 'npm') : '',
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm'),
    path.join(os.homedir(), '.npm-global', 'bin'),
  ].filter(Boolean);

  const normalizedPathEntries = pathEntries.map((entry) => os.platform() === 'win32' ? entry.toLowerCase() : entry);
  const preferredEntries = candidates.filter((candidate, index) => {
    const normalizedCandidate = os.platform() === 'win32' ? candidate.toLowerCase() : candidate;
    return (
      candidates.indexOf(candidate) === index &&
      normalizedPathEntries.includes(normalizedCandidate)
    );
  });

  if (preferredEntries.length === 0) {
    return { key: pathKey, value: currentPath };
  }

  const normalizedPreferredEntries = preferredEntries.map((entry) =>
    os.platform() === 'win32' ? entry.toLowerCase() : entry
  );

  const value = [
    ...preferredEntries,
    ...pathEntries.filter((entry) => {
      const normalizedEntry = os.platform() === 'win32' ? entry.toLowerCase() : entry;
      return !normalizedPreferredEntries.includes(normalizedEntry);
    }),
  ].join(delimiter);

  return { key: pathKey, value };
}

/**
 * Handles websocket connections used by the standalone shell terminal UI.
 */
/**
 * PTY 池快照(F6 管理面)。**只读**,不碰任何状态。
 *
 * PTY 是最容易悄悄堆起来的一类资源:每个都是一个 shell 子进程,断开后还留
 * 30 分钟等重连,回放缓冲各自最多 2 MiB。面板要能一眼看出"有没有堆着"、
 * "缓冲吃了多少内存",以及**挂在谁头上** —— 键的前缀 `u<userId>_` 就是账号。
 */
export function getPtyPoolStats(): {
  count: number;
  attached: number;
  detached: number;
  takeover: number;
  bufferedBytes: number;
  byOwner: Array<{ userId: number | null; count: number }>;
} {
  const byOwner = new Map<number | null, number>();
  let attached = 0;
  let takeover = 0;
  let bufferedBytes = 0;

  for (const [key, session] of ptySessionsMap.entries()) {
    if (session.ws) attached += 1;
    if (session.isTakeover) takeover += 1;
    bufferedBytes += session.bufferedBytes;
    const match = /^u(\d+|anon)_/.exec(key);
    const owner = match && match[1] !== 'anon' ? Number(match[1]) : null;
    byOwner.set(owner, (byOwner.get(owner) ?? 0) + 1);
  }

  return {
    count: ptySessionsMap.size,
    attached,
    detached: ptySessionsMap.size - attached,
    takeover,
    bufferedBytes,
    byOwner: [...byOwner.entries()]
      .map(([userId, count]) => ({ userId, count }))
      .sort((left, right) => right.count - left.count),
  };
}

export function handleShellConnection(
  ws: WebSocket,
  request: AuthenticatedWebSocketRequest,
  dependencies: ShellWebSocketDependencies
): void {
  console.log('[INFO] Shell websocket connected');

  // 必须和 chat 连接一样盖上身份。少了这一步会同时坏两件事:PTY 复用键分不出
  // 用户(两个人在同一路径开终端会连到同一个 PTY 上),而 `claimForShell` 记下的
  // 持有者恒为 null,chat 那边的占用提示永远显示不出是谁接管的。
  stampSocketViewer(ws, request);
  const connectionViewer = readSocketViewer(ws);

  let shellProcess: IPty | null = null;
  let ptySessionKey: string | null = null;
  let urlDetectionBuffer = '';
  const announcedAuthUrls = new Set<string>();

  ws.on('message', async (rawMessage) => {
    try {
      const data = parseShellMessage(rawMessage);
      if (!data?.type) {
        throw new Error('Invalid websocket payload');
      }

      if (data.type === 'init') {
        const projectPath = readString(data.projectPath, process.cwd());
        const sessionId = readString(data.sessionId) || null;
        const hasSession = readBoolean(data.hasSession);
        const provider = readString(data.provider, 'claude');
        const initialCommand = readString(data.initialCommand);
        const forceRestart = readBoolean(data.forceRestart);
        /**
         * F10:终端多标签。
         *
         * PTY 的复用键此前是 `u<用户>_<项目路径>_<会话|default>`,于是同一个项目
         * 下开第二个终端会**连到第一个的 PTY 上** —— 两个标签共享一个 shell,
         * 输出互相串,关一个另一个也跟着哑。客户端给每个标签一个 id,键里带上它,
         * 各自一个 PTY;不带 id 的老客户端落到空后缀,行为与改动前逐字一致。
         *
         * 只取字母数字和连字符:这个值直接进键,不能让它带进分隔符或路径片段。
         */
        const terminalId = readString(data.terminalId).replace(/[^a-zA-Z0-9-]/g, '').slice(0, 32);
        const isPlainShell =
          readBoolean(data.isPlainShell) ||
          (!!initialCommand && !hasSession) ||
          provider === 'plain-shell';

        urlDetectionBuffer = '';
        announcedAuthUrls.clear();

        const isLoginCommand =
          !!initialCommand &&
          (initialCommand.includes('setup-token') ||
            initialCommand.includes('auth login'));

        // 必须在复用判定之前算出来:模式参与"能不能复用现有 PTY"的决定。
        const wantsTakeover = readBoolean(data.takeover);

        const commandSuffix =
          isPlainShell && initialCommand
            ? `_cmd_${Buffer.from(initialCommand).toString('base64').slice(0, 16)}`
            : '';
        // 键里必须有用户:没有它,普通终端的 sessionId 是 null,键塌缩成
        // `<projectPath>_default`,于是 B 在 A 已经打开的路径上开终端就会直接
        // 接到 A 的活 PTY 上 —— 回放 A 的滚动缓冲、能往里打字,而且下面那句
        // `existingSession.ws = ws` 会把 A 的输出整个重定向到 B,A 的终端无声
        // 变哑。身份缺失时退回 'anon',它自己一个隔离域,不与任何登录用户共享。
        const ptyOwnerKey = connectionViewer.userId === null || connectionViewer.userId === undefined
          ? 'anon'
          : String(connectionViewer.userId);
        ptySessionKey = `u${ptyOwnerKey}_${projectPath}_${sessionId ?? 'default'}${commandSuffix}${terminalId ? `_t${terminalId}` : ''}`;

        // 模式变了就得重开:普通终端里跑着一个交互 bash,接管要的是
        // `claude --resume <id>`,复用前者等于点了接管什么也没发生。
        const cached = ptySessionsMap.get(ptySessionKey);
        const modeChanged = Boolean(cached) && cached!.isTakeover !== wantsTakeover;

        if (isLoginCommand || forceRestart || modeChanged) {
          const oldSession = ptySessionsMap.get(ptySessionKey);
          if (oldSession) {
            if (oldSession.timeoutId) {
              clearTimeout(oldSession.timeoutId);
            }
            if (oldSession.claimedSessionId) {
              releaseShellClaim(oldSession.claimedSessionId);
            }
            oldSession.pty.kill();
            ptySessionsMap.delete(ptySessionKey);
          }
        }

        const existingSession =
          isLoginCommand || forceRestart || modeChanged ? null : ptySessionsMap.get(ptySessionKey);
        if (existingSession) {
          shellProcess = existingSession.pty;
          if (existingSession.timeoutId) {
            clearTimeout(existingSession.timeoutId);
          }

          ws.send(
            JSON.stringify({
              type: 'output',
              data: '\x1b[36m[Reconnected to existing session]\x1b[0m\r\n',
            })
          );

          if (existingSession.buffer.length > 0) {
            existingSession.buffer.forEach((bufferedData) => {
              ws.send(
                JSON.stringify({
                  type: 'output',
                  data: bufferedData,
                })
              );
            });
          }

          existingSession.ws = ws;
          return;
        }

        const resolvedProjectPath = path.resolve(projectPath);
        try {
          const stats = fs.statSync(resolvedProjectPath);
          if (!stats.isDirectory()) {
            throw new Error('Not a directory');
          }
        } catch {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid project path' }));
          return;
        }

        // 抢在会话监视器前面把这个目录登记成"属于开终端的这个人"的项目。
        //
        // 不做这一步的后果是日常可触发的:用户在终端里于任何尚未登记的目录跑一次
        // `claude`,监视器随后按 transcript 里的 cwd 建出项目行,而它没有用户
        // 上下文,owner 只能是 NULL —— NULL 的语义是公共项目,于是那个目录连同
        // 会话标题出现在所有人的侧栏里。这里先建,监视器后到时走 ON CONFLICT,
        // owner 保持不变。
        if (connectionViewer.userId !== null && connectionViewer.userId !== undefined) {
          const ownerUserId = Number(connectionViewer.userId);
          if (Number.isInteger(ownerUserId)) {
            try {
              projectsDb.createProjectPath(resolvedProjectPath, null, ownerUserId);
            } catch (error) {
              // 登记失败不该挡住开终端 —— 最坏情况退回到监视器建行的旧行为。
              console.error('[Shell] 预登记项目归属失败:', error);
            }
          }
        }

        const safeSessionIdPattern = /^[a-zA-Z0-9_.\-:]+$/;
        if (sessionId && !safeSessionIdPattern.test(sessionId)) {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid session ID' }));
          return;
        }

        const resume = resolveResumeSessionId(data, dependencies);
        const appSessionId = readString(data.sessionId);
        // 身份在连接建立时就盖好了(见 handleShellConnection 顶部),这里直接用。
        // 原来这里是手抄的一份 `ws.prismUserId` 读取 —— 而 shell 连接从来没被
        // 盖过章,所以它读到的永远是 null。
        const viewer = connectionViewer;

        // 接管前先把 chat 那边的 runtime 放掉。顺序不能反:先起 CLI 再释放,中间
        // 那一小段就是两个进程同时写同一份 transcript,正是要消掉的东西。
        let takeoverNote = '';
        let takeoverGranted = false;
        if (wantsTakeover) {
          if (!resume.ok) {
            takeoverNote = resume.reason === 'not_recorded'
              ? '\x1b[33m这段对话还没有可恢复的记录 —— 先在 chat 里发一轮,让 Claude 报出它自己的会话 id,再回来接管。已为你打开普通终端。\x1b[0m\r\n'
              : '\x1b[33m无法解析这段对话的会话 id,已为你打开普通终端。\x1b[0m\r\n';
          } else if (dependencies.releaseConversation) {
            const released = await dependencies.releaseConversation(resume.sessionId);
            if (released.released) {
              claimForShell(appSessionId || resume.sessionId, viewer);
              takeoverGranted = true;
            } else {
              takeoverNote = released.reason === 'turn_in_flight'
                ? '\x1b[33mchat 里有一轮对话正在进行,现在接管会打断它。等它跑完再试。已为你打开普通终端。\x1b[0m\r\n'
                : '\x1b[33m释放 chat 侧运行时失败,没有接管。已为你打开普通终端。\x1b[0m\r\n';
            }
          } else {
            claimForShell(appSessionId || resume.sessionId, viewer);
            takeoverGranted = true;
          }
        }

        const shellCommand = buildShellCommand(data, takeoverGranted ? resume : { ok: false, reason: 'no_session' });
        const shell = os.platform() === 'win32' ? 'powershell.exe' : 'bash';
        const shellArgs = shellCommand
          ? (os.platform() === 'win32' ? ['-Command', shellCommand] : ['-c', shellCommand])
          : (os.platform() === 'win32' ? [] : ['-i']);
        const termCols = readNumber(data.cols, 80);
        const termRows = readNumber(data.rows, 24);
        const prioritizedPath = prioritizeUserNpmGlobalBin(process.env);

        shellProcess = pty.spawn(shell, shellArgs, {
          name: 'xterm-256color',
          cols: termCols,
          rows: termRows,
          cwd: resolvedProjectPath,
          env: {
            ...process.env,
            [prioritizedPath.key]: prioritizedPath.value,
            TERM: 'xterm-256color',
            COLORTERM: 'truecolor',
            FORCE_COLOR: '3',
          },
        });

        ptySessionsMap.set(ptySessionKey, {
          pty: shellProcess,
          ws,
          buffer: [],
          bufferedBytes: 0,
          timeoutId: null,
          projectPath,
          sessionId,
          isTakeover: takeoverGranted,
          claimedSessionId: takeoverGranted ? (appSessionId || (resume.ok ? resume.sessionId : null)) : null,
        });

        shellProcess.onData((chunk) => {
          if (!ptySessionKey) {
            return;
          }

          const session = ptySessionsMap.get(ptySessionKey);
          if (!session) {
            return;
          }

          // 双预算裁剪(字节为主 + 条数兜底)抽成纯函数,便于单测。
          session.bufferedBytes = pushReplayChunk(
            session.buffer,
            session.bufferedBytes,
            chunk,
            PTY_REPLAY_BUFFER_MAX_BYTES,
            PTY_REPLAY_BUFFER_MAX_CHUNKS,
            (text) => Buffer.byteLength(text),
          );

          if (session.ws && session.ws.readyState === WebSocket.OPEN) {
            let outputData = chunk;
            const cleanChunk = dependencies.stripAnsiSequences(chunk);
            urlDetectionBuffer = `${urlDetectionBuffer}${cleanChunk}`.slice(-SHELL_URL_PARSE_BUFFER_LIMIT);

            outputData = outputData.replace(
              /OPEN_URL:\s*(https?:\/\/[^\s\x1b\x07]+)/g,
              '[INFO] Opening in browser: $1'
            );

            const emitAuthUrl = (detectedUrl: string, autoOpen = false) => {
              const normalizedUrl = dependencies.normalizeDetectedUrl(detectedUrl);
              if (!normalizedUrl) {
                return;
              }

              const isNewUrl = !announcedAuthUrls.has(normalizedUrl);
              if (isNewUrl) {
                announcedAuthUrls.add(normalizedUrl);
                session.ws?.send(
                  JSON.stringify({
                    type: 'auth_url',
                    url: normalizedUrl,
                    autoOpen,
                  })
                );
              }
            };

            const normalizedDetectedUrls = dependencies.extractUrlsFromText(urlDetectionBuffer)
              .map((url) => dependencies.normalizeDetectedUrl(url))
              .filter((url): url is string => Boolean(url));

            const dedupedDetectedUrls = Array.from(new Set(normalizedDetectedUrls)).filter(
              (url, _, urls) =>
                !urls.some((otherUrl) => otherUrl !== url && otherUrl.startsWith(url))
            );

            dedupedDetectedUrls.forEach((url) => emitAuthUrl(url, false));

            if (
              dependencies.shouldAutoOpenUrlFromOutput(cleanChunk) &&
              dedupedDetectedUrls.length > 0
            ) {
              const bestUrl = dedupedDetectedUrls.reduce((longest, current) =>
                current.length > longest.length ? current : longest
              );
              emitAuthUrl(bestUrl, true);
            }

            session.ws.send(
              JSON.stringify({
                type: 'output',
                data: outputData,
              })
            );
          }
        });

        shellProcess.onExit((exitCode) => {
          if (!ptySessionKey) {
            return;
          }

          const session = ptySessionsMap.get(ptySessionKey);
          if (session && session.pty !== shellProcess) {
            return;
          }

          if (session && session.ws && session.ws.readyState === WebSocket.OPEN) {
            session.ws.send(
              JSON.stringify({
                type: 'output',
                data: `\r\n\x1b[33mProcess exited with code ${exitCode.exitCode}${
                  exitCode.signal != null ? ` (${exitCode.signal})` : ''
                }\x1b[0m\r\n`,
              })
            );
          }

          if (session?.timeoutId) {
            clearTimeout(session.timeoutId);
          }

          const claimed = session?.claimedSessionId ?? (session?.isTakeover ? appSessionId : null);
          ptySessionsMap.delete(ptySessionKey);
          shellProcess = null;
          // 终端没了就还给 chat。忘了释放会让 chat 被一个已经不存在的终端锁住。
          // 用条目上记的 id,不用闭包里的 appSessionId —— 重连之后 onExit 仍然
          // 挂在最初那次 init 的闭包上,那里的变量未必还对得上。
          if (claimed) {
            releaseShellClaim(claimed);
          }
        });

        // 说清楚这个终端是什么。以前"接管失败"和"正常新会话"打的是同一句话,
        // 用户没有任何线索知道自己在跟一段空白记录说话。
        let welcomeMsg = takeoverGranted
          ? `\x1b[36m已接管对话 ${resume.ok ? resume.sessionId : ''},chat 侧运行时已释放。退出终端后 chat 可继续。\x1b[0m\r\n`
          : `\x1b[36m终端已就绪:${projectPath}\x1b[0m\r\n`;
        if (takeoverNote) {
          welcomeMsg = takeoverNote + welcomeMsg;
        }

        ws.send(
          JSON.stringify({
            type: 'output',
            data: welcomeMsg,
          })
        );
        return;
      }

      if (data.type === 'input') {
        if (shellProcess) {
          shellProcess.write(readString(data.data));
        }
        return;
      }

      if (data.type === 'resize') {
        if (shellProcess) {
          shellProcess.resize(readNumber(data.cols, 80), readNumber(data.rows, 24));
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ERROR] Shell WebSocket error:', message);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: 'output',
            data: `\r\n\x1b[31mError: ${message}\x1b[0m\r\n`,
          })
        );
      }
    }
  });

  ws.on('close', () => {
    if (!ptySessionKey) {
      return;
    }

    const session = ptySessionsMap.get(ptySessionKey);
    if (!session) {
      return;
    }

    // 这个 PTY 已经被别的连接接手了(同一个人开了第二个标签页,那边的 init 把
    // `session.ws` 指到了新 socket)。旧连接的 close 不能再动它:否则会把活跃
    // 标签页的输出掐掉,还给它挂一个 30 分钟后的 kill,而那个定时器之后没有任何
    // 地方会清。
    if (session.ws !== ws) {
      return;
    }

    session.ws = null;

    // 接管终端断开就立刻收掉,不留缓期。
    //
    // 这是"点断开连接回 chat 仍然无法对话"的原因:占用登记原先只在 PTY 退出时
    // 释放,而断开连接并不结束 PTY —— 它按普通终端的重连逻辑活着,最长 30 分钟。
    // 于是 chat 那边继续被 SESSION_HELD_BY_SHELL 挡着,而用户看得见的终端已经
    // 关了,没有任何办法把对话要回来。接管是前台动作,关掉它就该交还。
    if (session.isTakeover) {
      if (session.claimedSessionId) {
        releaseShellClaim(session.claimedSessionId);
      }
      try {
        session.pty.kill();
      } catch {
        // 已经退出了 —— onExit 会做剩下的清理。
      }
      ptySessionsMap.delete(ptySessionKey);
      return;
    }

    session.timeoutId = setTimeout(() => {
      if (ptySessionsMap.get(ptySessionKey as string) !== session) {
        return;
      }

      session.pty.kill();
      ptySessionsMap.delete(ptySessionKey as string);
    }, PTY_SESSION_TIMEOUT);
  });

  ws.on('error', (error) => {
    console.error('[ERROR] Shell WebSocket error:', error);
  });
}
