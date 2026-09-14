import type { ChatMessage } from '../types/types';

/**
 * 工具执行卡里一行的摘要(设计稿 2a/2b 的五列表格:状态 / 工具名 / 目标 / 计量 / 耗时)。
 *
 * 纯函数,从既有的 ChatMessage 推导 —— 不新增任何协议字段:
 * - 目标:从 toolInput 取最能代表这次调用的那个值(路径 / 命令 / 模式)
 * - 计量:写操作数 +增 −删,读/搜操作数行数或命中数
 * - 耗时:tool_result 的时间戳减去 tool_use 的时间戳
 */

export type ToolRowStatus = 'running' | 'done' | 'error' | 'interrupted';

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
      // ef:新建文件(没有 old_string)只说写了多少行 —— `−0` 是编辑才有的概念,
      // 挂在新建行上是一句没有信息量的噪声(设计稿里写入行是「+86 行」)。
      return { text: removed ? `+${added} −${removed}` : `+${added} 行`, isWrite: true };
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

/**
 * ef:一段活动的**总耗时**(设计稿抬头右端那个「1 分 12 秒」)。
 *
 * 逐行相加而不是"最后一行结束 − 第一行开始":工具之间还夹着模型思考的时间,
 * 端到端差值会把那部分也算进来 —— 抬头说的是"这一轮的工具跑了多久"。
 * 一条都算不出来时返回空串,抬头就不显示这一项。
 */
export function formatRunDuration(
  messages: Array<{ timestamp?: ChatMessage['timestamp']; toolResult?: ChatMessage['toolResult'] }>,
): string {
  let total = 0;
  let counted = 0;
  for (const message of messages) {
    const endRaw = message.toolResult && typeof message.toolResult === 'object'
      ? (message.toolResult as Record<string, unknown>).timestamp
      : undefined;
    if (endRaw === undefined || endRaw === null) continue;
    const start = new Date(message.timestamp as string | number | Date).getTime();
    const end = new Date(endRaw as string | number | Date).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
    total += end - start;
    counted += 1;
  }
  if (counted === 0) return '';
  return formatDurationMs(total);
}

/** 毫秒 → 「0.4s」/「12.0s」/「1m 12s」。toolDuration 与 formatRunDuration 共用。 */
export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
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

  return formatDurationMs(end - start);
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

/**
 * @param sessionIsProcessing 这个会话此刻还在跑吗。
 *
 * 没有结果的工具行以前一律算 'running' —— 于是回合被中止/超时收掉时,那条
 * tool_result 永远不会到,卡片就永远转下去。会话都已经不在跑了还显示"运行中",
 * 是在骗人。会话闲下来时仍然没结果的行,按**已中断**渲染。
 */
export function summarizeToolRow(message: ChatMessage, sessionIsProcessing = true): ToolRowSummary {
  const toolName = message.toolName || 'Tool';
  const hasResult = Boolean(message.toolResult);
  const isError = Boolean(message.toolResult && (message.toolResult as Record<string, unknown>).isError);
  const metric = toolMetric(toolName, message.toolInput, message.toolResult);

  /**
   * ge:**被转到后台的那次调用,终态在 `background` 里。**
   *
   * 转后台时这一行**立刻**拿到一个 "running in the background" 的 tool_result
   * (SDK 原话),按 `hasResult` 判它当场就是"完成" —— 而它其实刚开始跑。
   * 真正的完成/失败由 SDK 的 `task_notification` 带回来,按 `tool_use_id` 归到
   * 这一行上(见 useChatMessages 的 backgroundByToolId)。
   *
   * 这也是为什么"后台任务完成"不再需要在主对话流里单独占一行:那件事**这一行
   * 自己就说得清**,而且说得更准。
   */
  const background = (message as { background?: { status?: string } }).background;
  const backgroundStatus = background?.status === 'completed'
    ? 'done'
    : background?.status === 'failed'
      ? 'error'
      : background?.status === 'running'
        ? 'running'
        : null;

  return {
    status: backgroundStatus ?? (hasResult
      ? (isError ? 'error' : 'done')
      : (sessionIsProcessing ? 'running' : 'interrupted')),
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

export type ActivityFoldPlan = {
  /** 收起状态下应当显示的行数(从末尾往前数) */
  visibleCount: number;
  /** 被折起来的行数 */
  foldedCount: number;
  /** 抬头做成可点的按钮 —— 现在只要有行就可点(既能展开也能手动收起) */
  canFold: boolean;
  /** 抬头是否出现 */
  showSummary: boolean;
};

/**
 * 一段活动收起时露出多少行。
 *
 * ## fw 起的规则(用户定的)
 *
 * 1. **只要有一行就渲染抬头** —— 不再有"少于三步不给抬头"这条。此前一个回合
 *    刚开跑、段内只有一两行时抬头根本不出现,行光秃秃地摊着,随后第三行落地
 *    抬头才凭空冒出来,位置还整个错一档;
 * 2. **这一轮的正文还没开始写**:留最新 `ACTIVITY_TAIL_ROWS` 步,其余折起 ——
 *    用户盯的是"现在在干什么";不足三步就全露(没什么可折的);
 * 3. **正式回复一出现**:整段收成抬头一行。做完的活儿不该继续占着屏幕。
 *
 * 第 3 条的判据是**正文出没出现**,不是"最后一个工具返回没有"。后者会在工具
 * 刚返回、正文还没开始写的那一刻把整段塌掉 —— 既让人以为这一轮完了,又在正文
 * 即将出现的位置制造一次大幅高度突变。判据本身收在 `focusActivityGroup` 里。
 *
 * @param keepTail 这一段属于正在跑的这一轮,且正文还没开始出现
 */
/**
 * gb:**收起状态下该露几行 —— 收起不等于清空。**
 *
 * 这一段此前有两个"收起":自动规则(`planActivityFold`)在回合还在跑时收到
 * **尾部三行**,而用户手动点抬头收起时,组件里写死的是 **0**。同一个动作两种
 * 含义,用户点的正是后者 —— 于是一轮跑到 33 步时点一下"收起",正在跑的那几步
 * 也一起没了,而 `manualFold` 一旦定下就压过自动规则(fw 有意为之),这一轮
 * **剩下的全程**都不再露尾三。用户看到的就是一条"执行 33 条命令·运行中"的
 * 光杆抬头,底下什么都没有。
 *
 * 所以把"收起的目标"抽成这一个函数,自动与手动两条路共用它。
 *
 * **例外**:总共就 ≤ `ACTIVITY_TAIL_ROWS` 行时,"保留最新三个"和"全都露着"是
 * 同一件事 —— 这时候收起若还留三行,那个按钮就成了点了没反应的死键
 * (fw 专门修过这个)。所以只有这种情况才真的收干净。
 *
 * 白送的一条:回合一结束 `keepTail` 翻 false,收起目标当场变 0 ——
 * **"会话完成后才全部折叠"是这个判据的自然结果,不用另写一行。**
 */
export function collapsedVisibleCount(total: number, keepTail: boolean): number {
  return keepTail && total > ACTIVITY_TAIL_ROWS ? ACTIVITY_TAIL_ROWS : 0;
}

export function planActivityFold(total: number, keepTail: boolean): ActivityFoldPlan {
  const visibleCount = keepTail ? Math.min(total, ACTIVITY_TAIL_ROWS) : 0;
  const foldedCount = total - visibleCount;
  return {
    visibleCount,
    foldedCount,
    canFold: total > 0,
    showSummary: total > 0,
  };
}

/**
 * 渲染列表里一项对"哪一段属于正在跑的这一轮"这件事的作用。
 *
 * - `activity` 这一项是一段活动时间轴(工具组);
 * - `turn-boundary` **开启新的一轮或终结当前一轮**(用户消息 / 错误行);
 * - `reply` **这一轮的正式回复**(普通助手正文)—— 它不结束回合(后面还可能
 *   接着调工具),但它一出现,它上面那段活动就该收起来;
 * - `other` 其余(子代理卡、任务通知、压缩摘要、交互式提示……)—— 不改变归属。
 */
export type ActivityItemRole = 'activity' | 'turn-boundary' | 'reply' | 'other';

export type ActivityFocus = {
  /** 属于正在跑的这一轮的那一段活动的下标;-1 表示没有 */
  index: number;
  /** 这一轮的正式回复已经开始出现(已落地的正文,或正在流式打字) */
  replyStarted: boolean;
};

/**
 * 找出"正在跑的这一轮"对应哪一段活动,以及**它的正文开始写了没有**。
 *
 * ## 为什么这两件事必须一起算
 *
 * 它们的答案来自同一次倒扫,而且各自驱动不同的东西 —— 拆成两个判据就是下一次
 * "只改了一半"的温床:
 *
 * - `index` 决定**行状态**:属于这一轮的段,没有结果的工具行是「运行中」;
 *   不属于的,是「已中断」。
 * - `replyStarted` 决定**折不折**:正文一出现就整段收起(规则见 planActivityFold)。
 *
 * 曾经这两件事共用一个 `sessionIsProcessing`,于是"正文出现要收起"和"这一行
 * 还在跑"互相打架:一个说收、一个说这行是运行中。
 *
 * ## 倒扫怎么读
 *
 * 从尾部往前:
 * - 撞上 `turn-boundary` → 这一轮**一步都还没跑出来**(用户刚发出消息),返回 -1;
 * - 撞上 `reply` → 正文已经出现,**接着往前找**它对应的那段活动
 *   (模型可能写完一段正文又接着调工具,那时最后一段才是当前段);
 * - 撞上 `activity` → 就是它。
 *
 * ft 那版只停在"最后一个工具组",漏掉了"用户发出下一条消息之后,上一轮的活动段
 * 仍然是最后一个工具组"这一半(fu 修)。传下标取值而不先 map 成数组:渲染期每轮
 * 都要算一次,长会话里那是几百项的白白分配,而且撞上边界能立刻短路。
 *
 * @param replyInFlight 正文正在流式打字(它不在列表里,由调用方告知)
 */
/**
 * 最后一条**回合边界**(用户消息 / provider 报的错)在第几项;没有就是 -1。
 *
 * fz:比它靠后的项都属于"最新那一轮"。子代理卡要用它 ——
 * 那张卡此前连"会话在不在跑"都不知道,于是没有结果的子代理**永久转圈**:
 * 用户按停止、服务重启、CLI 崩了,`tool_result` 永远不会到,而卡上那个
 * `animate-spin` 明天、下个月翻回来还在转,旁边同一屏的工具清单却写着「已中断」。
 *
 * 判据与折叠那条**刻意分开**:折叠看的是"正文出没出现"(正文一出现就收起),
 * 而"这个子代理还在不在跑"跟正文写没写没关系 —— 合成一个判据就是下一次
 * "一个判据回答两个问题"。
 */
export function lastTurnBoundaryIndex(
  total: number,
  roleAt: (index: number) => ActivityItemRole,
): number {
  for (let i = total - 1; i >= 0; i -= 1) {
    if (roleAt(i) === 'turn-boundary') return i;
  }
  return -1;
}

export function focusActivityGroup(
  total: number,
  roleAt: (index: number) => ActivityItemRole,
  replyInFlight = false,
): ActivityFocus {
  let replyStarted = replyInFlight;
  for (let i = total - 1; i >= 0; i -= 1) {
    const role = roleAt(i);
    if (role === 'turn-boundary') return { index: -1, replyStarted };
    if (role === 'reply') {
      replyStarted = true;
      continue;
    }
    if (role === 'activity') return { index: i, replyStarted };
  }
  return { index: -1, replyStarted };
}

/**
 * 这一段要不要保持摊开:**属于正在跑的这一轮,且正文还没开始出现**。
 *
 * 两个条件各自都被单独用错过:
 * - 只看"会话在跑" → 一发消息满屏折叠条全部弹开(ft 之前);
 * - 只看"是不是最后一个工具组" → 发出下一条消息后上一轮那段又弹开(fu 修);
 * - 不看正文 → 正文都写出来了,上面那段还摊着三行(fw 修,用户要求)。
 */
export function shouldKeepActivityTailOpen(
  isCurrentTurnGroup: boolean,
  replyStarted: boolean,
): boolean {
  return isCurrentTurnGroup && !replyStarted;
}

/**
 * gg:**一条子代理叙述要不要折起来。**
 *
 * `forwardSubagentText` 打开之后,子代理的思考与正文都进了卡片里那条嵌套轴。
 * 思考一条动辄十几行,几条并排就把这根轴撑成一堵墙 —— 用户原话
 * 「子 agent 的思考输出,折叠掉,不要全部放上显得太多」。
 *
 * 判据刻意是**「一行放不放得下」而不是「是不是思考」**:
 *
 * - 短思考(「先看看目录结构」)折起来只是多一次点击;
 * - 长正文同样该折 —— 撑墙的是长度,不是种类。
 *
 * 100 字符这个数不是拍的:实测里那些一行就说完的叙述
 * (「I'll start by exploring the directory to understand the existing code style.」76 字符)
 * 全部落在它下面,而带换行的多段思考一律落在它上面。
 */
export const NARRATION_FOLD_CHARS = 100;

export function shouldFoldNarration(body: string): boolean {
  return body.length > NARRATION_FOLD_CHARS || body.includes('\n');
}
