import type { Project, ProjectSession, LLMProvider } from '../../../types/app';
import type { SettingsMainTab } from '../../settings/types/types';
import type {
  MarkSessionIdle,
  MarkSessionProcessing,
  SessionActivityMap,
} from '../../../hooks/useSessionProtection';

export type Provider = LLMProvider;

export type PermissionMode = 'default' | 'acceptEdits' | 'auto' | 'bypassPermissions' | 'plan';

export interface ChatImage {
  /** Inline data URL (Claude history stores attachments as base64). */
  data?: string;
  /** Project-relative path under `attachments/` served via the files API. */
  path?: string;
  name?: string;
  mimeType?: string;
}

export interface ToolResult {
  content?: unknown;
  isError?: boolean;
  timestamp?: string | number | Date;
  toolUseResult?: unknown;
  [key: string]: unknown;
}

export interface SubagentChildTool {
  toolId: string;
  toolName: string;
  toolInput: unknown;
  toolResult?: ToolResult | null;
  timestamp: Date;
  /**
   * 这一步是工具调用,还是子代理自己的正文 / 思考。
   *
   * SDK 默认只转发子代理的 `tool_use` / `tool_result`(原话:"enough for a
   * heartbeat counter");`forwardSubagentText: true` 之后正文与思考也带着
   * `parent_tool_use_id` 一起来,SDK 说这就是给"消费方渲染嵌套 transcript"用的。
   * 有了这两种,点开一张子代理卡看到的才是它自己的那条会话时间轴,
   * 而不是一串光秃秃的工具名。
   */
  kind?: 'tool' | 'text' | 'thinking';
  /** `kind` 为 text / thinking 时的正文。 */
  content?: string;
}

export interface ChatMessage {
  type: string;
  content?: string;
  displayText?: string;
  timestamp: string | number | Date;
  images?: ChatImage[];
  reasoning?: string;
  isThinking?: boolean;
  isStreaming?: boolean;
  isInteractivePrompt?: boolean;
  isToolUse?: boolean;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: ToolResult | null;
  toolId?: string;
  toolCallId?: string;
  commandName?: string;
  commandMessage?: string;
  commandArgs?: string;
  isLocalCommand?: boolean;
  isLocalCommandStdout?: boolean;
  isCompactSummary?: boolean;
  /**
   * 这条 error 是本地提示,不是这一轮的结果。
   *
   * 附件太大、文档解析失败、抓网页失败、断线时授权没发出去……这些都是前端就地插进
   * transcript 的红字,与正在跑的那一轮无关。而 `endsTurnForOutputs` 把 `type === 'error'`
   * 当回合边界;不区分的话,拖错一个附件就会把正在跑的活动段整个折掉,还把此刻真正在跑的
   * 那条工具行标成「已中断」。带上这个标记的行不参与回合边界判定。
   */
  isLocalNotice?: boolean;
  /** 用户气泡的幂等键(本地回声)与"已撤回"标记:合流消息的撤回 / 置灰靠它们。 */
  clientMessageId?: string;
  withdrawn?: boolean;
  /** 插话:合流进正在跑的这一轮,不是回合边界(见 turnBoundary.endsTurnForOutputs)。 */
  interjection?: boolean;
  /** 本地回声发出时回合还在跑。进度区数回合时不算新回合(见 taskChecklist)。 */
  sentDuringTurn?: boolean;
  /** 本地回声打戳时还没有服务器时钟样本,时间是浏览器时间(见 NormalizedMessage.clockUnsynced)。 */
  clockUnsynced?: boolean;
  /** 这一轮实际服务的模型(响应元数据),显示在回答的时间戳旁。 */
  model?: string;
  /**
   * 这次工具调用被转到后台之后的进展与终态。
   *
   * 不只是子代理,任何工具调用都可能被转后台(Ctrl+B 的 Bash、workflow)。
   * 转后台时那次调用立刻拿到一个 "running in the background" 的 tool_result,
   * 不能按"有结果 = 完成"画;真正的终态在 SDK 的 `task_notification` 里,
   * 由 `useChatMessages` 按 `tool_use_id` 归回这一行。
   */
  background?: {
    status: 'running' | 'completed' | 'failed';
    summary?: string;
    toolUses?: number;
    durationMs?: number;
    lastToolName?: string;
  };
  isSubagentContainer?: boolean;
  subagentState?: {
    childTools: SubagentChildTool[];
    currentToolIndex: number;
    isComplete: boolean;
    /**
     * 这个子代理转到后台之后的进展与汇报。
     *
     * 任务一转后台,那次工具调用就立刻拿到一个 "running in the background" 的
     * tool_result(SDK 原话),卡片会停在转后台之前跑到的那几步;它之后真正干的活
     * 全在 SDK 的 `task_progress` / `task_notification` 里,要靠这里连起来。
     *
     * 子代理内部的每一步在后台化之后不再走实时流,所以这里拿到的是计数与汇报,
     * 不是一步步的清单;全文在 SDK 给的 `output_file` 里。
     */
    background?: {
      status: 'running' | 'completed' | 'failed';
      summary?: string;
      toolUses?: number;
      durationMs?: number;
      lastToolName?: string;
    };
  };
  [key: string]: unknown;
}

export interface ClaudeSettings {
  allowedTools: string[];
  disallowedTools: string[];
  skipPermissions: boolean;
  projectSortOrder: string;
  lastUpdated?: string;
  [key: string]: unknown;
}

export interface ClaudePermissionSuggestion {
  toolName: string;
  entry: string;
  isAllowed: boolean;
}

export interface PermissionGrantResult {
  success: boolean;
  alreadyAllowed?: boolean;
  updatedSettings?: ClaudeSettings;
}

export interface PendingPermissionRequest {
  requestId: string;
  toolName: string;
  input?: unknown;
  context?: unknown;
  sessionId?: string | null;
  receivedAt?: Date;
  /** 主回合结束后,后台子代理要的审批。 */
  background?: boolean;
  /** CLI 说这一次不该给"总是允许"(suppressAlwaysAllowRule)。 */
  suppressAlwaysAllow?: boolean;
}

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface Question {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

export type SessionNavigationOptions = {
  replace?: boolean;
};

export type SessionEstablishedContext = {
  provider: LLMProvider;
  project: Project;
  summary?: string | null;
};

export interface ChatInterfaceProps {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  isConnected: boolean;
  /** Returns false when the socket was not open, so the caller can keep the draft. */
  sendMessage: (message: unknown) => boolean;
  onFileOpen?: (filePath: string, diffInfo?: any) => void;
  /** 右侧文件预览栏是否开着:开着时工作面板自动折起来让位。 */
  isEditorOpen?: boolean;
  /**
   * 聊天页签是不是当前页签。ChatInterface 在 Shell / 文件 / 任务页签下只是隐藏不卸载,
   * 全局 Esc 只在它是当前页签时才中止回合。不传 = 当前。
   */
  isActive?: boolean;
  onInputFocusChange?: (focused: boolean) => void;
  onSessionProcessing?: MarkSessionProcessing;
  onSessionIdle?: MarkSessionIdle;
  processingSessions?: SessionActivityMap;
  onNavigateToSession?: (targetSessionId: string, options?: SessionNavigationOptions) => void;
  onSessionEstablished?: (sessionId: string, context: SessionEstablishedContext) => void;
  /** 开设置页;`tab` = 直接落到哪个标签(例如模型菜单的「去填 key」开 `gateways`)。 */
  onShowSettings?: (tab?: SettingsMainTab) => void;
  showRawParameters?: boolean;
  showThinking?: boolean;
  sendByCtrlEnter?: boolean;
  externalMessageUpdate?: number;
  newSessionTrigger?: number;
  /** 「这条会话已被删除」卡片上的「新建会话继续」:在同一个项目里开新会话。 */
  onStartNewSession?: (project: Project) => void;
  onTaskClick?: (...args: unknown[]) => void;
  onShowAllTasks?: (() => void) | null;
}
