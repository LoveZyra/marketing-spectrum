import { memo, useMemo, useRef, useState } from 'react';
import { Archive, ChevronRight, Wrench } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import ClaudeLogo from '../../../llm-logo-provider/ClaudeLogo';
import type {
  ChatMessage,
  ClaudePermissionSuggestion,
  PermissionGrantResult,
} from '../../types/types';
import { formatUsageLimitText } from '../../utils/chatFormatting';
import { cn } from '../../../../lib/utils';
import type { Project } from '../../../../types/app';
import { ToolRenderer, shouldHideToolResult } from '../../tools';
import { Reasoning, ReasoningTrigger, ReasoningContent } from '../../../../shared/view/ui';

import ChatMessageImages from './ChatMessageImages';
import { Markdown } from './Markdown';
import MessageCopyControl from './MessageCopyControl';
import UserMessageBody from './UserMessageBody';

type DiffLine = {
  type: string;
  content: string;
  lineNum: number;
};

type MessageComponentProps = {
  message: ChatMessage;
  prevMessage: ChatMessage | null;
  createDiff: (oldStr: string, newStr: string) => DiffLine[];
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onShowSettings?: () => void;
  onGrantToolPermission?: (suggestion: ClaudePermissionSuggestion) => PermissionGrantResult | null | undefined;
  showRawParameters?: boolean;
  showThinking?: boolean;
  selectedProject?: Project | null;
  /** Prism: fork the conversation at this user message and re-run an edit. */
  onEditRerun?: (message: ChatMessage) => void;
  /** F2:这条错误消息是对话末尾且当前空闲 —— 显示「重发上一条」。 */
  showRetry?: boolean;
  onRetry?: () => void;
  /**
   * 活动时间轴的展开区用:只要消息主体,不要头像 / 角色名 / 时间戳那圈外壳 ——
   * 那些信息时间轴的行上已经有了,再来一遍就是噪声。
   */
  bare?: boolean;
};

type InteractiveOption = {
  number: string;
  text: string;
  isSelected: boolean;
};

const COPY_HIDDEN_TOOL_NAMES = new Set(['Bash', 'Edit', 'Write', 'ApplyPatch']);

const MessageComponent = memo(({ message, prevMessage, createDiff, onFileOpen, showRawParameters, showThinking, selectedProject, onEditRerun, showRetry = false, onRetry, bare = false }: MessageComponentProps) => {
  const { t } = useTranslation('chat');
  const isGrouped = bare || (prevMessage && prevMessage.type === message.type &&
    ((prevMessage.type === 'assistant') ||
      (prevMessage.type === 'user') ||
      (prevMessage.type === 'tool') ||
      (prevMessage.type === 'error')));
  const messageRef = useRef<HTMLDivElement | null>(null);
  const userCopyContent = String(message.content || '');
  const formattedMessageContent = useMemo(
    () => formatUsageLimitText(String(message.content || '')),
    [message.content]
  );
  const assistantCopyContent = message.isToolUse
    ? String(message.displayText || message.content || '')
    : formattedMessageContent;
  const isCommandOrFileEditToolResponse = Boolean(
    message.isToolUse && COPY_HIDDEN_TOOL_NAMES.has(String(message.toolName || ''))
  );
  const shouldShowUserCopyControl = message.type === 'user' && userCopyContent.trim().length > 0;
  const shouldShowAssistantCopyControl = message.type === 'assistant' &&
    assistantCopyContent.trim().length > 0 &&
    !isCommandOrFileEditToolResponse &&
    !message.isThinking;


  const formattedTime = useMemo(() => new Date(message.timestamp).toLocaleTimeString(), [message.timestamp]);
  const shouldHideThinkingMessage = Boolean(message.isThinking && !showThinking);
  const [isCompactSummaryOpen, setIsCompactSummaryOpen] = useState(false);

  if (shouldHideThinkingMessage) {
    return null;
  }

  /**
   * 压缩摘要(/compact 或上下文耗尽时 CLI 自动压缩)。
   *
   * 它以 `role: 'user'` 写进 transcript,服务端已经把它改标成 assistant
   * (见 claude-sessions.provider 的 isCompactSummary 分支)—— 否则会显示成
   * "用户发了一大段英文摘要"。但改标之后它仍是一条普通正文,几百行摊在流里,
   * 而且没法收。
   *
   * 它该留着:这是"这里发生过一次压缩、带过来的是这些"的唯一凭据,删了就断片。
   * 但**默认收起**:平时只占一行,想追溯再展开。
   */
  if (message.isCompactSummary) {
    const summaryText = String(message.content || '');
    return (
      <div
        ref={messageRef}
        data-message-timestamp={message.timestamp || undefined}
        className={`chat-message ${message.type} px-3 sm:px-0`}
      >
        <button
          type="button"
          onClick={() => setIsCompactSummaryOpen((current) => !current)}
          aria-expanded={isCompactSummaryOpen}
          className="group flex w-full items-center gap-1.5 py-1.5 text-left text-[13px] leading-5 text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronRight
            className={cn('h-3.5 w-3.5 flex-none transition-transform', isCompactSummaryOpen && 'rotate-90')}
            strokeWidth={2}
            aria-hidden
          />
          <Archive className="h-3.5 w-3.5 flex-none" strokeWidth={2} aria-hidden />
          <span className="min-w-0 truncate">
            {t('compactSummary.title', { defaultValue: '上下文已压缩 —— 早前的对话折成了一份摘要' })}
          </span>
        </button>

        {isCompactSummaryOpen && (
          <div className="pb-2 pt-0.5">
            <Markdown className="prose prose-sm max-w-none border-l border-border pl-3 font-sans text-[13px] leading-[21px] text-muted-foreground dark:prose-invert">
              {summaryText}
            </Markdown>
            <div className="mt-2 flex items-center text-[11px]">
              <MessageCopyControl content={summaryText} messageType="assistant" />
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      ref={messageRef}
      data-message-timestamp={message.timestamp || undefined}
      className={`chat-message group/msg ${message.type} ${isGrouped ? 'grouped' : ''} ${message.type === 'user' ? 'flex justify-end px-3 sm:px-0' : 'px-3 sm:px-0'}`}
    >
      {message.type === 'user' ? (
        /* User turn on the right: claude.ai-style attachment cards above the bubble */
        <div className="flex w-full min-w-0 items-end justify-end sm:max-w-[85%]">
          <div className="flex min-w-0 flex-1 flex-col items-end gap-2 sm:flex-initial">
            {message.images && message.images.length > 0 && (
              <ChatMessageImages
                images={message.images}
                projectId={selectedProject?.projectId}
              />
            )}
            {userCopyContent.trim().length > 0 || !message.images?.length ? (
              /* 提问用中性气泡:底色是沉降面、文字是墨色,字号与正文回答同一档 ——
                 绿底白字那版把提问做成了整屏最抢眼的东西,而它只是上下文。
                 复制 / 时间 / 编辑重跑移到气泡外,悬停才出现。 */
              <>
                <div className="prism-panel max-w-full rounded-[var(--radius-bubble)] bg-card px-4 py-2.5 text-[15px] leading-[26px] text-foreground">
                  <UserMessageBody content={userCopyContent} />
                </div>
                <div className="flex items-center gap-1.5 font-mono text-[10.5px] text-muted-foreground transition-opacity sm:opacity-0 sm:focus-within:opacity-100 sm:group-hover/msg:opacity-100">
                  {onEditRerun && Boolean(message.id) && userCopyContent.trim().length > 0 && (
                    <button
                      type="button"
                      onClick={() => onEditRerun(message)}
                      className="rounded-sm px-1 py-0.5 transition-colors hover:text-foreground"
                      title={t('fork.editRerunTitle', { defaultValue: '从这里分叉：编辑此消息并重新运行' })}
                    >
                      {t('fork.editRerun', { defaultValue: '编辑重跑' })}
                    </button>
                  )}
                  {shouldShowUserCopyControl && (
                    <MessageCopyControl content={userCopyContent} messageType="user" />
                  )}
                  <span>{formattedTime}</span>
                </div>
              </>
            ) : (
              /* Image-only turn: no text bubble, but the timestamp still shows */
              <div className="flex items-center justify-end gap-1 text-xs text-muted-foreground">
                <span>{formattedTime}</span>
              </div>
            )}
          </div>
        </div>
      ) : message.isTaskNotification ? (
        /* Compact task notification on the left */
        <div className="w-full">
          <div className="flex items-center gap-2 py-0.5">
            <span className={`inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full ${message.taskStatus === 'completed' ? 'bg-primary' : 'bg-muted-foreground'}`} />
            <span className="text-xs text-muted-foreground">{message.content}</span>
          </div>
        </div>
      ) : (
        /* Claude/Error/Tool messages on the left */
        <div className="w-full">
          {!isGrouped && (
            <div className="mb-2 flex items-center space-x-3">
              {message.type === 'error' ? (
                <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full border border-border bg-muted text-sm text-foreground">
                  !
                </div>
              ) : message.type === 'tool' ? (
                <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  <Wrench className="h-4 w-4" aria-hidden />
                </div>
              ) : (
                <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full p-1 text-sm text-foreground">
                  <ClaudeLogo className="h-full w-full" />
                </div>
              )}
              <div className="text-sm font-medium text-foreground">
                {message.type === 'error'
                  ? t('messageTypes.error')
                  : message.type === 'tool'
                    ? t('messageTypes.tool')
                    : t('messageTypes.claude')}
              </div>
            </div>
          )}

          <div className="w-full">

            {message.isToolUse ? (
              <>
                <div className="flex flex-col">
                  <div className="flex flex-col">
                    <Markdown className="prose prose-sm max-w-none font-sans dark:prose-invert">
                      {String(message.displayText || '')}
                    </Markdown>
                  </div>
                </div>

                {message.toolInput && (
                  <ToolRenderer
                    toolName={message.toolName || 'UnknownTool'}
                    toolInput={message.toolInput}
                    toolResult={message.toolResult}
                    toolId={message.toolId}
                    mode="input"
                    onFileOpen={onFileOpen}
                    createDiff={createDiff}
                    selectedProject={selectedProject}
                    showRawParameters={showRawParameters}
                    rawToolInput={typeof message.toolInput === 'string' ? message.toolInput : undefined}
                    isSubagentContainer={message.isSubagentContainer}
                    subagentState={message.subagentState}
                  />
                )}

                {/* Tool Result Section — Bash renders its output inside the command row above. */}
                {message.toolResult && message.toolName !== 'Bash' && !shouldHideToolResult(message.toolName || 'UnknownTool', message.toolResult) && (
                  message.toolResult.isError ? (
                    // Error results - red error box with content
                    <div
                      id={`tool-result-${message.toolId}`}
                      className="relative mt-2 scroll-mt-4 rounded border border-border bg-muted p-3"
                    >
                      <div className="relative mb-2 flex items-center gap-1.5">
                        <svg className="h-4 w-4 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                        <span className="text-xs font-medium text-muted-foreground">{t('messageTypes.error')}</span>
                      </div>
                      <div className="relative text-sm text-muted-foreground">
                        <Markdown className="prose prose-sm max-w-none font-sans dark:prose-invert">
                          {String(message.toolResult.content || '')}
                        </Markdown>
                      </div>
                    </div>
                  ) : (
                    // Non-error results - route through ToolRenderer (single source of truth)
                    <div id={`tool-result-${message.toolId}`} className="scroll-mt-4">
                      <ToolRenderer
                        toolName={message.toolName || 'UnknownTool'}
                        toolInput={message.toolInput}
                        toolResult={message.toolResult}
                        toolId={message.toolId}
                        mode="result"
                        onFileOpen={onFileOpen}
                        createDiff={createDiff}
                        selectedProject={selectedProject}
                      />
                    </div>
                  )
                )}
              </>
            ) : message.isInteractivePrompt ? (
              // Special handling for interactive prompts
              <div className="rounded-lg border border-border bg-muted p-4">
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full border border-border bg-muted">
                    <svg className="h-5 w-5 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  </div>
                  <div className="flex-1">
                    <h4 className="mb-3 text-base font-semibold text-foreground">
                      {t('interactive.title')}
                    </h4>
                    {(() => {
                      const lines = (message.content || '').split('\n').filter((line) => line.trim());
                      const questionLine = lines.find((line) => line.includes('?')) || lines[0] || '';
                      const options: InteractiveOption[] = [];

                      // Parse the menu options
                      lines.forEach((line) => {
                        // Match lines like "❯ 1. Yes" or "  2. No"
                        const optionMatch = line.match(/[❯\s]*(\d+)\.\s+(.+)/);
                        if (optionMatch) {
                          const isSelected = line.includes('❯');
                          options.push({
                            number: optionMatch[1],
                            text: optionMatch[2].trim(),
                            isSelected
                          });
                        }
                      });

                      return (
                        <>
                          <p className="mb-4 text-sm text-muted-foreground">
                            {questionLine}
                          </p>

                          {/* Option buttons */}
                          <div className="mb-4 space-y-2">
                            {options.map((option) => (
                              <button
                                key={option.number}
                                className={`w-full rounded-lg border-2 px-4 py-3 text-left transition-colors ${option.isSelected
                                  ? 'border-primary/[0.32] bg-primary/[0.08] text-foreground'
                                  : 'border-border bg-background text-muted-foreground'
                                  } cursor-not-allowed opacity-75`}
                                disabled
                              >
                                <div className="flex items-center gap-3">
                                  <span className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-sm font-bold ${option.isSelected
                                    ? 'bg-primary/[0.16]'
                                    : 'bg-muted'
                                    }`}>
                                    {option.number}
                                  </span>
                                  <span className="flex-1 text-sm font-medium sm:text-base">
                                    {option.text}
                                  </span>
                                  {option.isSelected && (
                                    <span className="text-lg">❯</span>
                                  )}
                                </div>
                              </button>
                            ))}
                          </div>

                          <div className="rounded-lg bg-muted p-3">
                            <p className="mb-1 text-sm font-medium text-muted-foreground">
                              {t('interactive.waiting')}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {t('interactive.instruction')}
                            </p>
                          </div>
                        </>
                      );
                    })()}
                  </div>
                </div>
              </div>
            ) : message.isThinking ? (
              /* Thinking messages — Reasoning component (ai-elements pattern) */
              <Reasoning defaultOpen={false}>
                <ReasoningTrigger />
                <ReasoningContent>
                  <Markdown className="prose prose-sm max-w-none font-sans dark:prose-invert">
                    {message.content}
                  </Markdown>
                  <div className="mt-3 flex items-center text-[11px]">
                    <MessageCopyControl content={String(message.content || '')} messageType="assistant" />
                  </div>
                </ReasoningContent>
              </Reasoning>
            ) : (
              <div dir="auto" className="text-sm text-body">
                {/* Reasoning accordion */}
                {showThinking && message.reasoning && (
                  <Reasoning className="mb-3" defaultOpen={false}>
                    <ReasoningTrigger />
                    <ReasoningContent>
                      <div className="whitespace-pre-wrap">
                        {message.reasoning}
                      </div>
                    </ReasoningContent>
                  </Reasoning>
                )}

                {(() => {
                  const content = formattedMessageContent;

                  // Detect if content is pure JSON (starts with { or [)
                  const trimmedContent = content.trim();
                  if ((trimmedContent.startsWith('{') || trimmedContent.startsWith('[')) &&
                    (trimmedContent.endsWith('}') || trimmedContent.endsWith(']'))) {
                    try {
                      const parsed = JSON.parse(trimmedContent);
                      const formatted = JSON.stringify(parsed, null, 2);

                      return (
                        <div className="my-2">
                          <div className="mb-2 flex items-center gap-2 text-sm text-muted-foreground">
                            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                            </svg>
                            <span className="font-medium">{t('json.response')}</span>
                          </div>
                          <div className="overflow-hidden rounded-lg border border-border bg-muted">
                            <pre className="overflow-x-auto p-4">
                              <code className="block whitespace-pre font-mono text-sm text-foreground">
                                {formatted}
                              </code>
                            </pre>
                          </div>
                        </div>
                      );
                    } catch {
                      // Not valid JSON, fall through to normal rendering
                    }
                  }

                  // Normal rendering for non-JSON content
                  return message.type === 'assistant' ? (
                    <Markdown
                      className="chat-answer prose prose-sm font-sans dark:prose-invert"
                      streaming={Boolean(message.isStreaming)}
                    >
                      {content}
                    </Markdown>
                  ) : (
                    <div className="whitespace-pre-wrap">
                      {content}
                    </div>
                  );
                })()}

                {/* 失败一键重试:只在"最后一条是错误、当前空闲"时出现(由
                    ChatMessagesPane 判定)。按原文重发最近一条用户消息;
                    回合在跑或断网时自动进排队通道,不会重复发。 */}
                {showRetry && onRetry && message.type === 'error' && (
                  <button
                    type="button"
                    onClick={onRetry}
                    className="mt-2 rounded-md border border-border px-2.5 py-1 text-xs text-body transition-colors hover:bg-muted hover:text-foreground"
                  >
                    {t('retry.lastTurn', { defaultValue: '重发上一条消息' })}
                  </button>
                )}
              </div>
            )}

            {!bare && (shouldShowAssistantCopyControl || !isGrouped) && (
              <div className="mt-2 flex w-full items-center gap-2 font-mono text-[10.5px] text-muted-foreground transition-opacity sm:opacity-0 sm:focus-within:opacity-100 sm:group-hover/msg:opacity-100">
                {shouldShowAssistantCopyControl && (
                  <MessageCopyControl content={assistantCopyContent} messageType="assistant" />
                )}
                {!isGrouped && <span>{formattedTime}</span>}
                {/* 这一轮实际服务的模型(响应元数据)。模型的自我介绍会顺着上下文
                    复述历史("我是 XX"),不可信;这个小标签才是铁证。
                    注意不能绑 !isGrouped —— 回复常以 thinking 块开头,正文会被判成
                    "同类分组"而藏掉时间戳;徽标必须独立于分组,否则几乎永远看不见。 */}
                {typeof message.model === 'string' && message.model && (
                  <span
                    className="rounded-sm border border-border px-1 py-px font-mono text-[10px] text-muted-foreground"
                    title="这一轮实际服务的模型（来自响应元数据，非模型自述）"
                  >
                    {message.model}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
});

export default MessageComponent;

