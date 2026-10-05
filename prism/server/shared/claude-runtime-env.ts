/**
 * hm:Prism 起 claude 子进程时的环境变量与会话级约定 —— SDK 两条路径、终端、SkillWhet 共用一份。
 *
 * 放在 shared/ 而不是 claude-sdk.js 里:终端(modules/websocket)与 SkillWhet(services)
 * 都要用,而模块边界不许它们 import claude-sdk.js。
 */

/**
 * A3.1:**跨会话消息的两个工具,无条件禁掉。**
 *
 * CLI 2.1.28x 把 `SendMessage` / `ListAgents` 交给了模型(实测),默认"同档位自动投递";
 * 而 Prism 所有用户都跑在同一个 OS 用户(jovyan)下 —— 对 CLI 来说全是"同一个人的会话",
 * A 的 agent 能列出并给 B 的会话发消息。三层防:用户级 settings.json(部署步骤)、
 * 这里的 `disallowedTools`、`Options.settings.crossSessionInbound = 'refuse'`。
 */
export const CROSS_SESSION_TOOLS: readonly string[] = Object.freeze(['SendMessage', 'ListAgents']);

/** A3.1 第三层:本会话拒收别的会话投来的消息。 */
export const CROSS_SESSION_INBOUND = 'refuse' as const;

/**
 * A3.4:**从 claude 的 Bash 里继承来的"我是子会话"标记。**
 *
 * CLI 给它起的每个 shell 盖这几个变量(2.1.285 二进制里的 `bNe()`:
 * `CLAUDECODE=1`、`CLAUDE_CODE_SESSION_ID`、`CLAUDE_CODE_CHILD_SESSION=1`、
 * `CLAUDE_CODE_SESSION_ATTENDED`、`CLAUDE_PID`,另有 `AI_AGENT` / `CLAUDE_EFFORT` /
 * `TRACEPARENT`)。Prism 如果是从这样的 shell 里起的(agent 在对话里跑
 * `bash prism.sh restart` 就是),它起的每个 claude 都继承这些 —— 而
 * `CLAUDE_CODE_CHILD_SESSION` 会让 CLI **不写 transcript**(2.1.170 / 2.1.217 起),
 * 会话从此续不上、侧栏也看不到。
 *
 * 前五个无条件删;后四个是通用名字,只在确认是从 CLI 的 shell 里继承来的时候才删。
 */
export const CLI_SESSION_MARKER_KEYS: readonly string[] = Object.freeze([
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_ENTRYPOINT',
]);
export const CLI_CHILD_SHELL_KEYS: readonly string[] = Object.freeze([
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'AI_AGENT',
  'TRACEPARENT',
]);

/**
 * 删掉继承来的会话标记(就地改 `env`),返回删了哪些。启动时对 `process.env` 调一次,
 * 之后所有子进程(SDK、PTY、SkillWhet、营销诊断、Jupyter)都从干净的 env 起。
 */
let startupScrubbed: string[] = [];
/** 启动时(load-env.js)删掉了哪些 —— index.js 读来打日志。 */
export function scrubbedSessionMarkersAtStartup(): string[] {
  return [...startupScrubbed];
}

export function scrubInheritedSessionMarkers(
  env: NodeJS.ProcessEnv = process.env,
  { recordAsStartup = false }: { recordAsStartup?: boolean } = {},
): string[] {
  const inheritedFromCliShell = Boolean(env.CLAUDECODE || env.CLAUDE_CODE_CHILD_SESSION);
  const removed: string[] = [];
  for (const key of CLI_SESSION_MARKER_KEYS) {
    if (env[key] !== undefined) {
      delete env[key];
      removed.push(key);
    }
  }
  if (inheritedFromCliShell) {
    for (const key of CLI_CHILD_SHELL_KEYS) {
      if (env[key] !== undefined) {
        delete env[key];
        removed.push(key);
      }
    }
  }
  if (recordAsStartup) startupScrubbed = [...removed];
  return removed;
}

/**
 * A3.5:**只由 Prism 按 runtime 传的变量。**
 *
 * `~/.claude/settings.json` 的 `env` 优先于进程 env(claude-settings-mapping.service 里有说明)——
 * 这几个若写进了那份文件,Prism 按模型给的值会被静默盖掉。启动自检发现就 warn。
 */
export const PRISM_OWNED_CLI_ENV_KEYS: readonly string[] = Object.freeze([
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  'CLAUDE_CODE_ENABLE_TODO_TOOLS',
  'DISABLE_AUTOUPDATER',
]);

/**
 * SDK 子进程的 env。
 *
 * - SDK 0.2.113 起 `options.env` **替换**而不是叠加 process.env,所以先整份拷过来;
 * - A3.2 `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`:2.1.285 只对第一方、未指定模型、少数旧 Claude
 *   型号默认给 TaskCreate 一族,网关上的模型名一个都不算 —— 不开的话任务清单那块静默消失;
 * - `DISABLE_AUTOUPDATER=1`:随包二进制不该自己去装新版本(装到 ~/.local/bin 会变成
 *   终端与 cron 用的那个 claude)。
 * - `extra` 里值为 undefined 的键会被**删掉**(按模型不设窗口时要把继承来的清掉)。
 */
export function buildClaudeSdkEnv(
  base: NodeJS.ProcessEnv = process.env,
  extra: Record<string, string | undefined> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (typeof value === 'string') env[key] = value;
  }
  env.CLAUDE_CODE_ENABLE_TODO_TOOLS = '1';
  env.DISABLE_AUTOUPDATER = '1';
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}
