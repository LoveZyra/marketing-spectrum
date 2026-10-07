import { memo, useMemo, useRef, useState } from 'react';
import { Archive, ChevronRight, PencilLine, RotateCcw, Undo2, Wrench, Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type {
  ChatMessage,
  ClaudePermissionSuggestion,
  PermissionGrantResult,
} from '../../types/types';
import { matchSkillInvocation, useSkillsCatalog } from '../../hooks/useSkillsCatalog';
import { formatUsageLimitText } from '../../utils/chatFormatting';
import { cn } from '../../../../lib/utils';
import type { Project } from '../../../../types/app';
import { ToolRenderer, shouldHideToolResult } from '../../tools';
import { Reasoning, ReasoningTrigger, ReasoningContent } from '../../../../shared/view/ui';
import type { TurnOutputFile } from '../../utils/turnOutputs';
import type { FeedbackPayload, MessageFeedbackRow } from '../../hooks/useMessageFeedback';
import { uiLocale } from '../../../../utils/uiLocale';
import { useMergedMessages } from '../../../../contexts/MergedMessagesContext';

import ChatMessageImages from './ChatMessageImages';
import { Markdown, StreamingMarkdown } from './Markdown';
import MessageCopyControl from './MessageCopyControl';
import MessageFeedbackControl from './MessageFeedbackControl';
import SkillSurveyCard from './SkillSurveyCard';
import TurnOutputsCard from './TurnOutputsCard';
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
  /** 这条错误消息在对话末尾且当前空闲:显示「重发上一条」。 */
  showRetry?: boolean;
  onRetry?: () => void;
  /** 这条是对话收尾的助手回答:悬停操作里给一枚「重跑」。 */
  canRerun?: boolean;
  /**
   * 这一轮产出的文件,渲染在正文最下方、复制 / 重跑那一行之上:读完结论,
   * 产出就在同一块内容的末尾,不另起一张卡浮在外面。
   */
  turnOutputs?: TurnOutputFile[];
  onFileOpenPath?: (filePath: string) => void;
  /** 会话产出通道的会话 id:项目目录之外的产出也能经它下载。 */
  outputsSessionId?: string | null;
  /**
   * 活动时间轴的展开区用:只要消息主体,不要头像 / 角色名 / 时间戳那圈外壳 ——
   * 那些信息时间轴的行上已经有了,再来一遍就是噪声。
   */
  bare?: boolean;
  /**
   * 滚动位置锚点用的稳定行标识,只有顶层行才传:展开区里嵌套的 MessageComponent 不传,
   * 于是不进锚点集合,它们的出现 / 消失不会让"倒数第几行"整体错位。
   */
  rowKey?: string;
  /**
   * 反馈:`feedback` 是当前用户对这条回答已有的意见(点亮赞 / 踩);`feedbackSkillHint`
   * 是本轮调用的 skill(点踩表单预填);`skillSurvey` 非空 = 服务端抽中了这一轮,
   * 在产出卡下面画「效果如何」卡。回调没传时(时间轴展开区、首页)一律不画。
   */
  feedback?: MessageFeedbackRow | null;
  feedbackSkillHint?: string | null;
  skillSurvey?: { skill: string } | null;
  onFeedbackSubmit?: (messageId: string, payload: FeedbackPayload) => Promise<unknown>;
  onFeedbackRemove?: (messageId: string) => Promise<void>;
};

type InteractiveOption = {
  number: string;
  text: string;
  isSelected: boolean;
};

const COPY_HIDDEN_TOOL_NAMES = new Set(['Bash', 'Edit', 'Write', 'ApplyPatch']);

const MessageComponent = memo(({ message, prevMessage, createDiff, onFileOpen, showRawParameters, showThinking, selectedProject, onEditRerun, showRetry = false, onRetry, canRerun = false, turnOutputs, onFileOpenPath, outputsSessionId, bare = false, rowKey, feedback = null, feedbackSkillHint = null, skillSurvey = null, onFeedbackSubmit, onFeedbackRemove }: MessageComponentProps) => {
  const { t } = useTranslation('chat');
  const isGrouped = bare || (prevMessage && prevMessage.type === message.type &&
    ((prevMessage.type === 'assistant') ||
      (prevMessage.type === 'user') ||
      (prevMessage.type === 'tool') ||
      (prevMessage.type === 'error')));
  const messageRef = useRef<HTMLDivElement | null>(null);
  const userCopyContent = String(message.content || '');
  // 显式技能调用徽标。用户消息首词命中技能命令(`/echo-probe …`)时,气泡上方
  // 标出「技能 · 名称」,悬停给描述 —— 不然斜杠原文对旁人是一串黑话。
  const skillsCatalog = useSkillsCatalog();
  const skillInvocation = useMemo(
    () => (message.type === 'user' ? matchSkillInvocation(userCopyContent, skillsCatalog) : null),
    [message.type, userCopyContent, skillsCatalog]
  );
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
  // 插话的状态(只对用户气泡有意义)
  const mergedMessages = useMergedMessages();
  const mergedState = message.type === 'user' ? mergedMessages?.stateFor(message.clientMessageId) : undefined;
  const userWithdrawn = message.type === 'user' && (message.withdrawn === true || mergedState === 'withdrawn');
  const shouldShowAssistantCopyControl = message.type === 'assistant' &&
    assistantCopyContent.trim().length > 0 &&
    !isCommandOrFileEditToolResponse &&
    !message.isThinking;


  /**
   * 流式那条消息的 timestamp 是哨兵 0(ChatMessagesPane 为稳住下游 memo 特意固定的),
   * 直接格式化会显示 1970 纪元时间(如「08:00:00」);哨兵一律不显示时间。
   */
  const formattedTime = useMemo(() => {
    const raw = message.timestamp;
    if (raw === 0 || raw === '0') return '';
    return new Date(raw).toLocaleTimeString(uiLocale());
  }, [message.timestamp]);
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
   * 但默认收起:平时只占一行,想追溯再展开。
   */
  if (message.isCompactSummary) {
    const summaryText = String(message.content || '');
    return (
      <div
        ref={messageRef}
        data-message-timestamp={message.timestamp || undefined}
        data-row-key={rowKey}
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
      /* 滚动位置锚点只认带这个标识的顶层行(见 useChatSessionState 的行选择器)。
         两处 return 都要带:压缩摘要那一支漏掉的话,会话里只要压缩过一次,
         它前后的行数就与锚点集合对不上。 */
      data-row-key={rowKey}
      className={`chat-message group/msg ${message.type} ${isGrouped ? 'grouped' : ''} ${message.type === 'user' ? 'flex justify-end px-3 sm:px-0' : 'px-3 sm:px-0'}`}
    >
      {message.type === 'user' ? (
        /* User turn on the right: claude.ai-style attachment cards above the bubble */
        <div className="flex w-full min-w-0 items-end justify-end sm:max-w-[70%]">
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
                {skillInvocation && (
                  <div
                    className="flex max-w-full items-center gap-1 rounded-full border border-border bg-muted/60 px-2 py-0.5 text-[11px] text-muted-foreground"
                    title={skillInvocation.description || undefined}
                  >
                    <Zap className="h-3 w-3 flex-none" strokeWidth={2} aria-hidden />
                    <span className="min-w-0 truncate">
                      {t('skills.invokedBadge', { defaultValue: '技能' })} · {skillInvocation.name}
                    </span>
                  </div>
                )}
                <div className={`prism-panel max-w-full rounded-bubble bg-card px-4 py-2.5 text-sm leading-6 text-foreground ${userWithdrawn ? 'opacity-55' : ''}`}>
                  <UserMessageBody content={userCopyContent} />
                </div>
                {/* 插话:模型读到前可撤回;撤掉了就标"已撤回,没有执行" */}
                {userWithdrawn ? (
                  <div className="flex items-center gap-1 text-[11px] text-muted-foreground" data-merged-state="withdrawn">
                    <Undo2 className="h-3 w-3" aria-hidden />
                    {t('merged.withdrawn')}
                  </div>
                ) : mergedState === 'pending' && message.clientMessageId ? (
                  <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground" data-merged-state="pending">
                    <span>{t('merged.pending')}</span>
                    <button
                      type="button"
                      onClick={() => mergedMessages?.withdraw(message.clientMessageId!)}
                      className="rounded px-1 font-medium text-foreground underline-offset-2 hover:underline"
                    >
                      {t('merged.withdraw')}
                    </button>
                  </div>
                ) : null}
                <div className="flex items-center gap-1.5 font-mono text-[10.5px] text-muted-foreground transition-opacity sm:opacity-0 sm:focus-within:opacity-100 sm:group-hover/msg:opacity-100">
                  {onEditRerun && Boolean(message.id) && userCopyContent.trim().length > 0 && (
                    <button
                      type="button"
                      onClick={() => onEditRerun(message)}
                      className="grid h-6 w-6 place-items-center rounded-md transition-colors hover:bg-accent hover:text-foreground"
                      aria-label={t('fork.editRerun', { defaultValue: '编辑重跑' })}
                      title={`${t('fork.editRerun', { defaultValue: '编辑重跑' })} · ${t('fork.editRerunTitle', { defaultValue: '从这里分叉：编辑此消息并重新运行' })}`}
                    >
                      <PencilLine className="h-3.5 w-3.5" aria-hidden />
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
          {/* 只有错误和工具两档挂头部(说明这一块是什么);助手回复不挂署名,实际回答的模型未必是 Claude */}
          {!isGrouped && (message.type === 'error' || message.type === 'tool') && (
            <div className="mb-2 flex items-center space-x-3">
              {message.type === 'error' ? (
                <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full border border-border bg-muted text-sm text-foreground">
                  !
                </div>
              ) : (
                <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  <Wrench className="h-4 w-4" aria-hidden />
                </div>
              )}
              <div className="text-sm font-medium text-foreground">
                {message.type === 'error' ? t('messageTypes.error') : t('messageTypes.tool')}
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
                  // 流式走两段式渲染:封版前缀 memo 住,每次 flush 只重解析
                  // 正在打的那一段(见 StreamingMarkdown / splitStreamingMarkdown)。
                  return message.type === 'assistant' ? (
                    message.isStreaming ? (
                      <StreamingMarkdown className="chat-answer prose prose-sm font-sans dark:prose-invert">
                        {content}
                      </StreamingMarkdown>
                    ) : (
                    <Markdown
                      className="chat-answer prose prose-sm font-sans dark:prose-invert"
                      streaming={Boolean(message.isStreaming)}
                    >
                      {content}
                    </Markdown>
                    )
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

                {/* 本轮产出:正文的最后一块,压在复制 / 重跑那一行之上 */}
                {turnOutputs && turnOutputs.length > 0 && (
                  <div className="mt-3">
                    <TurnOutputsCard files={turnOutputs} onFileOpen={onFileOpenPath} sessionId={outputsSessionId} />
                  </div>
                )}

                {/* 调过 skill 的回合结束后的「效果如何」卡:服务端抽中才有,与产出卡同一位置 */}
                {!bare && skillSurvey && onFeedbackSubmit && typeof message.id === 'string' && (
                  <div className="mt-3">
                    <SkillSurveyCard messageId={String(message.id).split('#')[0]} skill={skillSurvey.skill} onSubmit={onFeedbackSubmit} />
                  </div>
                )}
              </div>
            )}

            {!bare && (shouldShowAssistantCopyControl || !isGrouped) && (
              <div className="mt-2 flex w-full items-center gap-2 font-mono text-[10.5px] text-muted-foreground transition-opacity sm:opacity-0 sm:focus-within:opacity-100 sm:group-hover/msg:opacity-100">
                {shouldShowAssistantCopyControl && (
                  <MessageCopyControl content={assistantCopyContent} messageType="assistant" />
                )}
                {/* 赞 / 踩:与复制同一行,只在真正的回答(能复制的那条)上画 */}
                {shouldShowAssistantCopyControl && onFeedbackSubmit && onFeedbackRemove && typeof message.id === 'string' && (
                  <MessageFeedbackControl
                    messageId={String(message.id).split('#')[0]}
                    feedback={feedback}
                    skillHint={feedbackSkillHint}
                    onSubmit={onFeedbackSubmit}
                    onRemove={onFeedbackRemove}
                  />
                )}
                {/* 重跑只挂在收尾那条上(由 ChatMessagesPane 判定):它重发的是上一条用户消息,挂在历史中段就成了「编辑重跑」的分叉语义 */}
                {canRerun && onRetry && (
                  <button
                    type="button"
                    onClick={onRetry}
                    className="grid h-6 w-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    aria-label={t('retry.lastTurn', { defaultValue: '重发上一条消息' })}
                    title={t('retry.lastTurn', { defaultValue: '重发上一条消息' })}
                  >
                    <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                  </button>
                )}
                {!isGrouped && <span>{formattedTime}</span>}
                {/* 这一轮实际服务的模型(响应元数据)。模型的自我介绍会顺着上下文
                    复述历史("我是 XX"),不可信;这个小标签才是铁证。
                    注意不能绑 !isGrouped —— 回复常以 thinking 块开头,正文会被判成
                    "同类分组"而藏掉时间戳;徽标必须独立于分组,否则几乎永远看不见。 */}
                {typeof message.model === 'string' && message.model && (
                  <span
                    className="rounded-sm border border-border px-1 py-px font-mono text-[10px] text-muted-foreground"
                    title={t('messageTypes.servedModelTitle', { defaultValue: '这一轮实际服务的模型（来自响应元数据，非模型自述）' })}
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

