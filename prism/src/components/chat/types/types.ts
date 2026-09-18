import type { Project, ProjectSession, LLMProvider } from '../../../types/app';
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
   * ge:这一步是**工具调用**,还是子代理自己的**正文 / 思考**。
   *
   * SDK 默认只转发子代理的 `tool_use` / `tool_result`(原话:"enough for a
   * heartbeat counter");`forwardSubagentText: true` 之后正文与思考也带着
   * `parent_tool_use_id` 一起来 —— SDK 说这就是给"消费方渲染嵌套 transcript"
   * 用的。有了这两种,点开一张子代理卡看到的才是**它自己的那条会话时间轴**,
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
   * fz:**这条 error 是本地提示,不是这一轮的结果。**
   *
   * 附件太大、文档解析失败、抓网页失败、断线时授权没发出去…… 这些都是前端
   * 就地插进 transcript 的红字,与正在跑的那一轮毫无关系。而
   * `endsTurnForOutputs` 把 `type === 'error'` 当回合边界 —— 于是拖错一个
   * 附件就会把正在跑的活动段整个折掉,还把此刻真正在跑的那条工具行标成
   * 「已中断」。带上这个标记的行不参与回合边界判定。
   */
  isLocalNotice?: boolean;
  /** 这一轮实际服务的模型(响应元数据),显示在回答的时间戳旁。 */
  model?: string;
  /**
   * ge:**这次工具调用被转到后台之后的进展与终态。**
   *
   * 不只是子代理 —— 任何工具调用都可能被转后台(Ctrl+B 的 Bash、workflow)。
   * 转后台时那次调用**立刻**拿到一个 "running in the background" 的 tool_result,
   * 按老判据(有结果 = 完成)那一行当场就画成完成;真正的终态在 SDK 的
   * `task_notification` 里,由 `useChatMessages` 按 `tool_use_id` 归回这一行。
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
     * gd:**这个子代理转到后台之后的进展与汇报。**
     *
     * 任务一转后台,那次工具调用就**立刻**拿到一个"running in the background"的
     * tool_result(SDK 原话)—— 卡片当场收工,停在转后台之前跑到的那几步,
     * 而它真正干的活(十几条命令、几十次思考)全在 SDK 的 `task_progress` /
     * `task_notification` 里。线上看到的「2 步」+ 另起一行的完成汇报,
     * 就是这两样没连起来。
     *
     * 子代理内部的每一步在后台化之后**不再走实时流**,所以这里拿到的是**计数与
     * 汇报**,不是一步步的清单 —— 全文在 SDK 给的 `output_file` 里。
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
  /** dy:右侧文件预览栏是否开着 —— 开着时工作面板自动折起来让位。 */
  isEditorOpen?: boolean;
  onInputFocusChange?: (focused: boolean) => void;
  onSessionProcessing?: MarkSessionProcessing;
  onSessionIdle?: MarkSessionIdle;
  processingSessions?: SessionActivityMap;
  onNavigateToSession?: (targetSessionId: string, options?: SessionNavigationOptions) => void;
  onSessionEstablished?: (sessionId: string, context: SessionEstablishedContext) => void;
  onShowSettings?: () => void;
  showRawParameters?: boolean;
  showThinking?: boolean;
  sendByCtrlEnter?: boolean;
  externalMessageUpdate?: number;
  newSessionTrigger?: number;
  /** gk:「这条会话已被删除」卡片上的「新建会话继续」—— 在同一个项目里开新会话。 */
  onStartNewSession?: (project: Project) => void;
  onTaskClick?: (...args: unknown[]) => void;
  onShowAllTasks?: (() => void) | null;
}
