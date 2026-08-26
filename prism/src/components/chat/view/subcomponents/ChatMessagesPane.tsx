import { useTranslation } from 'react-i18next';
import { memo, useCallback, useMemo, useRef } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';

import type { ChatMessage } from '../../types/types';
import type {
  Project,
  ProjectSession,
  LLMProvider,
} from '../../../../types/app';
import { Shimmer } from '../../../../shared/view/ui';
import { getIntrinsicMessageKey } from '../../utils/messageKeys';
import type { SessionActivity } from '../../../../hooks/useSessionProtection';
import { groupConsecutiveTools, isSubagentGroupItem, isToolGroupItem, stabilizeGroupIdentity } from '../../utils/toolGrouping';
import type { SubagentGroupItem, ToolGroupItem } from '../../utils/toolGrouping';

import MessageComponent from './MessageComponent';
import ChatEmptyState from './ChatEmptyState';
import ActivityTimeline from './ActivityTimeline';
import SubagentGroupCard from './SubagentGroupCard';
import ActivityIndicator from './ActivityIndicator';
import LoadAllMessagesOverlay from './LoadAllMessagesOverlay';

interface ChatMessagesPaneProps {
  scrollContainerRef: RefObject<HTMLDivElement>;
  onWheel: () => void;
  onTouchMove: () => void;
  isLoadingSessionMessages: boolean;
  /** True while the viewed session has an active provider run in flight. */
  isProcessing?: boolean;
  /** True while the run indicator occupies the tail of the stream(底部留白用)。 */
  hasActivityIndicator?: boolean;
  /** 运行中指示器的数据;为空表示这一刻没有在跑的回合。 */
  activity?: SessionActivity | null;
  chatMessages: ChatMessage[];
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  provider: LLMProvider;
  setInput: Dispatch<SetStateAction<string>>;
  isLoadingMoreMessages: boolean;
  hasMoreMessages: boolean;
  totalMessages: number;
  sessionMessagesCount: number;
  visibleMessageCount: number;
  visibleMessages: ChatMessage[];
  loadEarlierMessages: () => void;
  loadAllMessages: () => void;
  allMessagesLoaded: boolean;
  isLoadingAllMessages: boolean;
  loadAllJustFinished: boolean;
  showLoadAllOverlay: boolean;
  /** 补页放弃、容器滚不动时为真:浮层常驻、不自动淡出。 */
  loadAllStuck?: boolean;
  createDiff: any;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onShowSettings?: () => void;
  onGrantToolPermission: (suggestion: { entry: string; toolName: string }) => { success: boolean };
  showRawParameters?: boolean;
  showThinking?: boolean;
  selectedProject: Project;
  /** Prism: fork + edit-and-rerun from a user message. */
  onEditRerun?: (message: ChatMessage) => void;
  /** F2:失败一键重试 —— 重发最近一条用户消息。 */
  onRetryLastTurn?: () => void;
}

function ChatMessagesPane({
  scrollContainerRef,
  onWheel,
  onTouchMove,
  isLoadingSessionMessages,
  isProcessing = false,
  hasActivityIndicator = false,
  activity = null,
  chatMessages,
  selectedSession,
  currentSessionId,
  provider,
  setInput,
  isLoadingMoreMessages,
  hasMoreMessages,
  totalMessages,
  sessionMessagesCount,
  visibleMessageCount,
  visibleMessages,
  loadEarlierMessages,
  loadAllMessages,
  allMessagesLoaded,
  isLoadingAllMessages,
  loadAllJustFinished,
  showLoadAllOverlay,
  loadAllStuck,
  createDiff,
  onFileOpen,
  onShowSettings,
  onGrantToolPermission,
  showRawParameters,
  showThinking,
  selectedProject,
  onEditRerun,
  onRetryLastTurn,
}: ChatMessagesPaneProps) {
  const { t } = useTranslation('chat');
  // 上一轮的组对象,按段首消息身份索引 —— 见 stabilizeGroupIdentity 的注释。
  const groupIdentityRef = useRef<WeakMap<ChatMessage, ToolGroupItem | SubagentGroupItem>>(new WeakMap());
  const groupedVisibleMessages = useMemo(
    () => {
      const grouped = groupConsecutiveTools(visibleMessages, Boolean(showThinking));
      const { items, nextByAnchor } = stabilizeGroupIdentity(grouped, groupIdentityRef.current);
      groupIdentityRef.current = nextByAnchor;
      return items;
    },
    [visibleMessages, showThinking],
  );

  // Stable, deterministic keys for the messages rendered this pass.
  //
  // `normalizedToChatMessages` rebuilds fresh ChatMessage objects on every store
  // update, so caching keys by object identity (or via a cross-render allocation
  // Set) minted a brand-new key for the *same* logical message on each prepend —
  // remounting the whole list, which disconnects the scroll-restore anchor and
  // reflows heights, jumping the viewport to the bottom. Deriving keys purely
  // from this render's ordered messages (intrinsic key, disambiguated by
  // occurrence index on collision) yields the same key for the same message
  // order, so React preserves existing DOM nodes and component state on prepend.
  const messageKeyMap = useMemo(() => {
    const keys = new WeakMap<ChatMessage, string>();
    const occurrences = new Map<string, number>();
    const assign = (message: ChatMessage) => {
      const intrinsicKey = getIntrinsicMessageKey(message) ?? 'message-generated';
      const seen = occurrences.get(intrinsicKey) ?? 0;
      occurrences.set(intrinsicKey, seen + 1);
      keys.set(message, seen === 0 ? intrinsicKey : `${intrinsicKey}__${seen}`);
    };
    for (const item of groupedVisibleMessages) {
      if (isToolGroupItem(item) || isSubagentGroupItem(item)) {
        item.messages.forEach(assign);
      } else {
        assign(item);
      }
    }
    return keys;
  }, [groupedVisibleMessages]);

  // getMessageKey 的引用要**恒定**:它是 ActivityTimeline 的 prop,每轮换新
  // 引用会把上面组身份保持换来的 memo 又全部击穿。改成经 ref 读,值永远是本轮
  // 的 key 表(ref 在渲染期先于子组件赋值),引用一次都不变。
  const messageKeyMapRef = useRef(messageKeyMap);
  messageKeyMapRef.current = messageKeyMap;
  const getMessageKey = useCallback(
    (message: ChatMessage) =>
      messageKeyMapRef.current.get(message) ?? getIntrinsicMessageKey(message) ?? 'message-generated',
    [],
  );

  return (
    <div
      ref={scrollContainerRef}
      onWheel={onWheel}
      onTouchMove={onTouchMove}
      className={`chat-messages-pane relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden pt-3 sm:pt-4 ${
        hasActivityIndicator ? 'pb-12 sm:pb-14' : 'pb-3 sm:pb-4'
      }`}
    >
      <div className={`mx-auto w-full space-y-3 px-4 sm:space-y-4 ${chatMessages.length === 0 ? 'max-w-[68rem]' : 'max-w-[54.25rem]'}`}>
      {(isLoadingSessionMessages || isProcessing) && chatMessages.length === 0 ? (
        <div className="mt-8 text-center text-muted-foreground">
          <div className="flex items-center justify-center space-x-2">
            <Shimmer as="p">{t('session.loading.sessionMessages')}</Shimmer>
          </div>
        </div>
      ) : chatMessages.length === 0 ? (
        <ChatEmptyState
          selectedSession={selectedSession}
          currentSessionId={currentSessionId}
          provider={provider}
          setInput={setInput}
        />
      ) : (
        <>
          {/* Loading indicator for older messages (hide when load-all is active) */}
          {isLoadingMoreMessages && !isLoadingAllMessages && !allMessagesLoaded && (
            <div className="py-3 text-center text-muted-foreground">
              <div className="flex items-center justify-center space-x-2">
                <Shimmer as="p" className="text-sm">{t('session.loading.olderMessages')}</Shimmer>
              </div>
            </div>
          )}

          {/* Indicator showing there are more messages to load (hide when all loaded) */}
          {hasMoreMessages && !isLoadingMoreMessages && !allMessagesLoaded && (
            <div className="border-b border-border py-2 text-center text-sm text-muted-foreground">
              {totalMessages > 0 && (
                <span>
                  {t('session.messages.showingOf', { shown: sessionMessagesCount, total: totalMessages })}{' '}
                  <span className="text-xs">{t('session.messages.scrollToLoad')}</span>
                </span>
              )}
            </div>
          )}

          <LoadAllMessagesOverlay
            showLoadAllOverlay={showLoadAllOverlay}
            isLoadingAllMessages={isLoadingAllMessages}
            loadAllJustFinished={loadAllJustFinished}
            stuck={loadAllStuck}
            totalMessages={totalMessages}
            onLoadAllMessages={loadAllMessages}
          />

          {/* Legacy message count indicator (for non-paginated view) */}
          {!hasMoreMessages && chatMessages.length > visibleMessageCount && (
            <div className="border-b border-border py-2 text-center text-sm text-muted-foreground">
              {t('session.messages.showingLast', { count: visibleMessageCount, total: chatMessages.length })} |
              <button className="ml-1 text-foreground underline hover:text-primary dark:text-primary" onClick={loadEarlierMessages}>
                {t('session.messages.loadEarlier')}
              </button>
              {' | '}
              <button
                className="text-foreground underline hover:text-primary dark:text-primary"
                onClick={loadAllMessages}
              >
                {t('session.messages.loadAll')}
              </button>
            </div>
          )}

          {(() => {
            let prevMessage: ChatMessage | null = null;
            const lastItem = groupedVisibleMessages[groupedVisibleMessages.length - 1];

            return groupedVisibleMessages.map((item) => {
              // 子代理卡片组:抬头 + 网格子卡 + 点开看各自的步骤时间轴(ci 轮)。
              if (isSubagentGroupItem(item)) {
                const groupPrevMessage = item.messages[item.messages.length - 1] || prevMessage;
                prevMessage = groupPrevMessage;
                return (
                  <SubagentGroupCard
                    key={`subagents-${getMessageKey(item.messages[0])}`}
                    group={item}
                    getMessageKey={getMessageKey}
                  />
                );
              }

              if (isToolGroupItem(item)) {
                const groupPrevMessage = prevMessage;
                prevMessage = item.messages[item.messages.length - 1] || prevMessage;

                return (
                  <ActivityTimeline
                    key={`activity-${getMessageKey(item.messages[0])}`}
                    group={item}
                    prevMessage={groupPrevMessage}
                    createDiff={createDiff}
                    getMessageKey={getMessageKey}
                    onFileOpen={onFileOpen}
                    onShowSettings={onShowSettings}
                    onGrantToolPermission={onGrantToolPermission}
                    showRawParameters={showRawParameters}
                    showThinking={showThinking}
                    selectedProject={selectedProject}
                  />
                );
              }

              const messagePrevMessage = prevMessage;
              prevMessage = item;

              // 只有**收尾在错误上**的对话才给重试按钮:老错误早被后面的
              // 对话翻篇了,回合在跑时也不该再塞一条。
              const showRetry = Boolean(
                onRetryLastTurn
                && item === lastItem
                && item.type === 'error'
                && !isProcessing,
              );

              return (
                <MessageComponent
                  key={getMessageKey(item)}
                  message={item}
                  prevMessage={messagePrevMessage}
                  createDiff={createDiff}
                  onFileOpen={onFileOpen}
                  onShowSettings={onShowSettings}
                  onGrantToolPermission={onGrantToolPermission}
                  showRawParameters={showRawParameters}
                  showThinking={showThinking}
                  selectedProject={selectedProject}
                  onEditRerun={onEditRerun}
                  showRetry={showRetry}
                  onRetry={onRetryLastTurn}
                />
              );
            });
          })()}

          {/* 运行中指示器站在消息流末尾 —— 输入框不再因为"在跑"而改形状 */}
          <ActivityIndicator activity={activity} />
        </>
      )}
      </div>
    </div>
  );
}

export default memo(ChatMessagesPane);
