import type { ChatMessage } from '../types/types';

/**
 * 工具执行卡里一行的摘要(设计稿 2a/2b 的五列表格:状态 / 工具名 / 目标 / 计量 / 耗时)。
 *
 * 纯函数,从既有的 ChatMessage 推导 —— 不新增任何协议字段:
 * - 目标:从 toolInput 取最能代表这次调用的那个值(路径 / 命令 / 模式)
 * - 计量:写操作数 +增 −删,读/搜操作数行数或命中数
 * - 耗时:tool_result 的时间戳减去 tool_use 的时间戳
 */

export type ToolRowStatus = 'running' | 'done' | 'error';

export type ToolRowSummary = {
  status: ToolRowStatus;
  /** 时间轴图标分类 */
  icon: ActivityIconKey;
  /** 行文案的原料(动词 + 目标,或工具自带的人话描述) */
  label: ActivityLabel;
  /** 工具名,固定宽度那一列 */
  name: string;
  /** 目标:路径 / 命令 / 模式,可省略号 */
  target: string;
  /** 结果计量文案,空串表示不显示 */
  metric: string;
  /** 计量是否是写操作(写操作用强调色) */
  metricIsWrite: boolean;
  /** 耗时文案,如 `0.4s`;算不出来时为空串 */
  duration: string;
};

const WRITE_TOOLS = new Set(['Edit', 'Write', 'ApplyPatch', 'NotebookEdit', 'MultiEdit']);

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function countLines(value: unknown): number {
  const text = str(value);
  if (!text) return 0;
  return text.split('\n').length;
}

export function toolTarget(toolName: string, toolInput: unknown): string {
  const input = asRecord(toolInput);
  // 顺序即优先级:先看"这次动的是哪个文件",再看命令/模式,`path` 只是搜索的作用域,
  // 放在最后 —— 否则 Grep 会显示目录而不是它真正在找的东西。
  const candidates = [
    input.file_path,
    input.notebook_path,
    input.command,
    input.pattern,
    input.query,
    input.url,
    input.path,
    input.description,
    input.prompt,
  ];
  for (const candidate of candidates) {
    const text = str(candidate).trim();
    if (text) return text;
  }
  return typeof toolInput === 'string' ? toolInput.trim() : '';
}

export function toolMetric(
  toolName: string,
  toolInput: unknown,
  toolResult: ChatMessage['toolResult'],
): { text: string; isWrite: boolean } {
  const input = asRecord(toolInput);

  if (WRITE_TOOLS.has(toolName)) {
    const oldText = str(input.old_string) || str(input.old_source);
    const newText = str(input.new_string) || str(input.new_source) || str(input.content);
    const added = newText ? countLines(newText) : 0;
    const removed = oldText ? countLines(oldText) : 0;
    if (added || removed) {
      return { text: `+${added} −${removed}`, isWrite: true };
    }
    return { text: '', isWrite: true };
  }

  const result = toolResult ? asRecord(toolResult) : {};
  const toolUseResult = asRecord(result.toolUseResult);

  const fileCount = Number(toolUseResult.numFiles ?? (Array.isArray(toolUseResult.filenames) ? toolUseResult.filenames.length : NaN));
  if (Number.isFinite(fileCount) && fileCount > 0) {
    return { text: `${fileCount} 处`, isWrite: false };
  }

  if (toolName === 'Read') {
    const lines = countLines(result.content);
    if (lines > 0) return { text: `${lines} 行`, isWrite: false };
  }

  return { text: '', isWrite: false };
}

export function toolDuration(
  startedAt: ChatMessage['timestamp'],
  toolResult: ChatMessage['toolResult'],
): string {
  const endRaw = toolResult && typeof toolResult === 'object' ? (toolResult as Record<string, unknown>).timestamp : undefined;
  if (endRaw === undefined || endRaw === null) return '';

  const start = new Date(startedAt as string | number | Date).getTime();
  const end = new Date(endRaw as string | number | Date).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '';

  const ms = end - start;
  if (ms < 0) return '';
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/* ── 行文案与图标(活动时间轴) ─────────────────────────────────── */

/** 时间轴左侧图标的语义分类 —— 组件按它取 lucide 图标。 */
export type ActivityIconKey =
  | 'read' | 'write' | 'edit' | 'bash' | 'search' | 'glob'
  | 'fetch' | 'agent' | 'todo' | 'mcp' | 'thinking' | 'tool'
  /** 回合中夹在工具之间的过渡性正文(cd 轮起收进时间轴) */
  | 'narration';

/** 行文案的动词分类。`generic` 表示没有合适的动词,直接用工具名。 */
export type ActivityVerb =
  | 'read' | 'write' | 'edit' | 'bash' | 'search' | 'glob'
  | 'fetch' | 'agent' | 'todo' | 'generic';

export type ActivityLabel = {
  /** 工具自带的人话描述(Bash / Task 有 `description`),有就直接用,不再套动词。 */
  description?: string;
  verb: ActivityVerb;
  /** 动词后面挂的目标,已缩成"读得动"的短形式(路径取文件名)。 */
  target: string;
  /** `generic` 时显示的工具名(mcp 工具会剥掉 `mcp__server__` 前缀)。 */
  toolLabel: string;
};

const ICON_BY_TOOL: Record<string, ActivityIconKey> = {
  Read: 'read', NotebookRead: 'read', ReadMcpResource: 'read',
  Write: 'write',
  Edit: 'edit', MultiEdit: 'edit', ApplyPatch: 'edit', NotebookEdit: 'edit',
  Bash: 'bash', BashOutput: 'bash', KillShell: 'bash', KillBash: 'bash', SlashCommand: 'bash',
  Grep: 'search', WebSearch: 'search',
  Glob: 'glob', LS: 'glob',
  WebFetch: 'fetch',
  Task: 'agent', Agent: 'agent',
  TodoWrite: 'todo',
};

const VERB_BY_TOOL: Record<string, ActivityVerb> = {
  Read: 'read', NotebookRead: 'read',
  Write: 'write',
  Edit: 'edit', MultiEdit: 'edit', ApplyPatch: 'edit', NotebookEdit: 'edit',
  Bash: 'bash', SlashCommand: 'bash',
  Grep: 'search', WebSearch: 'search',
  Glob: 'glob', LS: 'glob',
  WebFetch: 'fetch',
  Task: 'agent', Agent: 'agent',
  TodoWrite: 'todo',
};

/** `mcp__jira__create_issue` → `create_issue`;其余原样。 */
export function shortToolName(toolName: string): string {
  if (!toolName.startsWith('mcp__')) return toolName;
  const parts = toolName.split('__');
  return parts[parts.length - 1] || toolName;
}

export function activityIconKey(toolName: string): ActivityIconKey {
  if (toolName.startsWith('mcp__')) return 'mcp';
  return ICON_BY_TOOL[toolName] ?? 'tool';
}

/** 路径取文件名,URL 取主机名,其余原样 —— 一行放得下才叫人话。 */
function shortenTarget(target: string): string {
  const text = target.trim();
  if (!text) return '';
  if (/^https?:\/\//.test(text)) {
    try {
      return new URL(text).host;
    } catch {
      return text;
    }
  }
  // 命令里带空格,不能当路径切;纯路径才取尾段
  if (text.includes('/') && !/\s/.test(text)) {
    const segments = text.split('/').filter(Boolean);
    return segments[segments.length - 1] || text;
  }
  return text;
}

/**
 * 一行里的命令要读得出"这一步在干嘛",不是把整条流水线抄上去。
 * 去掉开头的 `cd xxx &&`(那是每条命令都有的噪声),截到第一个管道 / 续接 /
 * 重定向 / heredoc 为止,多行折成一行。截过就在末尾留省略号。
 */
export function compactCommand(command: string): string {
  const flat = command.replace(/\s*\n\s*/g, ' ').trim();
  if (!flat) return '';

  const withoutCd = flat.replace(/^cd\s+[^\s;&|]+\s*&&\s*/, '');
  const cut = withoutCd.search(/\s(?:\||&&|;)\s|\s<<|\s2>&1/);
  const head = (cut === -1 ? withoutCd : withoutCd.slice(0, cut)).trim();

  if (!head) return withoutCd;
  return head.length < withoutCd.length ? `${head} …` : head;
}

export function toolRowLabel(toolName: string, toolInput: unknown): ActivityLabel {
  const input = asRecord(toolInput);
  const description = str(input.description).trim();
  const verb = VERB_BY_TOOL[toolName] ?? 'generic';
  const rawTarget = toolTarget(toolName, toolInput);
  const target = verb === 'todo'
    ? ''
    : verb === 'bash'
      ? compactCommand(rawTarget)
      : shortenTarget(rawTarget);

  return {
    // description 是工具作者写给人看的那一句,优先级最高
    ...(description ? { description } : {}),
    verb,
    target,
    toolLabel: shortToolName(toolName),
  };
}

export function summarizeToolRow(message: ChatMessage): ToolRowSummary {
  const toolName = message.toolName || 'Tool';
  const hasResult = Boolean(message.toolResult);
  const isError = Boolean(message.toolResult && (message.toolResult as Record<string, unknown>).isError);
  const metric = toolMetric(toolName, message.toolInput, message.toolResult);

  return {
    status: !hasResult ? 'running' : isError ? 'error' : 'done',
    icon: activityIconKey(toolName),
    label: toolRowLabel(toolName, message.toolInput),
    name: toolName,
    target: toolTarget(toolName, message.toolInput),
    metric: metric.text,
    metricIsWrite: metric.isWrite,
    duration: toolDuration(message.timestamp, message.toolResult),
  };
}

/* ── 整段活动的一句话小结 ───────────────────────────────────────── */

/** 小结里的一个计数分段,组件按 `key` 取文案(`执行 37 条命令` 这类)。 */
export type ActivitySummarySegment = {
  key: ActivityIconKey;
  count: number;
};

// 显示顺序固定 —— 同一段活动每次刷新都该读出同一句话
const SUMMARY_ORDER: ActivityIconKey[] = [
  'bash', 'write', 'edit', 'read', 'search', 'glob', 'fetch', 'agent', 'todo', 'mcp', 'tool', 'narration', 'thinking',
];

/**
 * 把一段活动折成「执行 37 条命令 · 新建 6 个文件 · 读取 3 个文件」这样的抬头。
 * 按图标分类计数,空类不出现。
 */
export function summarizeActivityRun(
  messages: Array<{ isThinking?: boolean; isToolUse?: boolean; toolName?: string }>,
): ActivitySummarySegment[] {
  const counts = new Map<ActivityIconKey, number>();

  for (const message of messages) {
    const key: ActivityIconKey = message.isThinking
      ? 'thinking'
      : !message.isToolUse && !message.toolName
        ? 'narration'
        : activityIconKey(message.toolName || '');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return SUMMARY_ORDER
    .filter((key) => (counts.get(key) ?? 0) > 0)
    .map((key) => ({ key, count: counts.get(key) as number }));
}

/** 还在跑时,收起状态下留几步在外面。 */
export const ACTIVITY_TAIL_ROWS = 3;

/**
 * **还在跑**的那一段,少于这个步数就不折 —— 两三行的东西再折一层是添乱。
 *
 * 这条只管进行中的段。已经跑完的段无论几步都整段收起,见 `planActivityFold`。
 */
export const ACTIVITY_MIN_ROWS = 3;

export type ActivityFoldPlan = {
  /** 收起状态下应当显示的行数(从末尾往前数) */
  visibleCount: number;
  /** 被折起来的行数 */
  foldedCount: number;
  /** 有东西被折起来 —— 抬头才需要做成可点的按钮 */
  canFold: boolean;
  /** 抬头是否出现(被折起来时必须出现,否则那些行没有入口) */
  showSummary: boolean;
};

/**
 * 一轮活动收起时露出多少行。
 *
 * - **还在跑**:留最新 `ACTIVITY_TAIL_ROWS` 步 —— 用户盯的是"现在在干什么"。
 *   不足这个步数就全摊着,没什么可折的。
 * - **已跑完**:**无论几步都整段收成抬头一行**。做完的活儿不该继续占着屏幕,
 *   哪怕只有一两步 —— 一屏里躺着七八段各留两行的"残骸",比一段长的还碎。
 *   「摊开最新三步」是**进行中**那一段的特权。
 */
export function planActivityFold(total: number, hasRunning: boolean): ActivityFoldPlan {
  const visibleCount = hasRunning ? Math.min(total, ACTIVITY_TAIL_ROWS) : 0;
  const foldedCount = total - visibleCount;
  return {
    visibleCount,
    foldedCount,
    canFold: foldedCount > 0,
    showSummary: foldedCount > 0 || total >= ACTIVITY_MIN_ROWS,
  };
}
