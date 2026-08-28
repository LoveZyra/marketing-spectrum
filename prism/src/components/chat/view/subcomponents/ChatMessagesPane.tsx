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
import { createGroupIdentityState, groupConsecutiveTools, isSubagentGroupItem, isToolGroupItem, stabilizeGroupIdentity } from '../../utils/toolGrouping';
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
  /** 保留在接口上:调用方仍据此决定要不要传 activity。留白已改成常驻。 */
  hasActivityIndicator?: boolean;
  /** 正在打字的助手正文。列表外的独立元素,永远在最后一条消息之后。 */
  streamingText?: string | null;
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
  expandAllMessages: () => void;
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

/**
 * 流式气泡的时间戳。**恒定值** —— 它不参与排序(不在列表里),而一个每 100ms
 * 变一次的时间戳会让下游所有以它为依据的 memo 全部失效。
 */
const STREAMING_TIMESTAMP = 0;

function ChatMessagesPane({
  scrollContainerRef,
  onWheel,
  onTouchMove,
  isLoadingSessionMessages,
  isProcessing = false,
  streamingText = null,
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
  expandAllMessages,
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
  // 上一轮的组身份登记表(每条消息都指回它所属的组)—— 见 stabilizeGroupIdentity。
  const groupIdentityRef = useRef(createGroupIdentityState());
  const groupedVisibleMessages = useMemo(
    () => {
      const grouped = groupConsecutiveTools(visibleMessages, Boolean(showThinking));
      const { items, next } = stabilizeGroupIdentity(grouped, groupIdentityRef.current);
      groupIdentityRef.current = next;
      return items;
    },
    [visibleMessages, showThinking],
  );

  /**
   * 组的 React key。取组自己的稳定身份,**不能取段首消息** —— 窗口从头部长大
   * (补页 / 看更早 / 全部展开)会换掉段首,key 一变 React 就卸载重建整个
   * 时间轴:展开态丢失、高度当场突变。
   */
  /**
   * 流式气泡的消息对象。只随正文变化重建,其余一切保持不变;key 写死成
   * `message-streaming`,整段打字过程 DOM 节点从头到尾是同一个。
   */
  const streamingMessage = useMemo<ChatMessage | null>(
    () => (streamingText
      ? { type: 'assistant', content: streamingText, timestamp: STREAMING_TIMESTAMP, isStreaming: true }
      : null),
    [streamingText],
  );

  const getGroupKey = (item: ToolGroupItem | SubagentGroupItem) =>
    // `_key` 由 stabilizeGroupIdentity 保证存在;兜底只为类型完备。
    item._key ?? `${item.messages.length}-${String(item.timestamp)}`;

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
      /*
       * 底部留白**常驻**,不随运行状态切换。
       *
       * 原来是 `pb-3 ↔ pb-12`(桌面 `pb-4 ↔ pb-14`),一开跑一收尾各跳约 40px:
       * scrollHeight 骤变、浏览器钳一次 scrollTop,整屏内容上跳。留白本来就是
       * 给活动指示器让位的,常驻的代价只是空会话底部多一点空,比每轮跳两次划算。
       */
      className="chat-messages-pane relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto pb-12 pt-3 sm:pb-14 sm:pt-4"
    >
      {/*
        * 正文宽度**恒定**。原来空会话用 68rem(给起始卡片排得开),有消息之后收到
        * 54.25rem —— 第一条消息落地的瞬间容器从 1088px 缩到 868px,已渲染的内容
        * 全部重新折行。宽度改成只属于空态那一块,消息列表这一支永远是 54.25rem。
        */}
      <div className="mx-auto w-full max-w-[54.25rem] space-y-3 px-4 sm:space-y-4">
      {(isLoadingSessionMessages || isProcessing) && chatMessages.length === 0 ? (
        <div className="mt-8 text-center text-muted-foreground">
          <div className="flex items-center justify-center space-x-2">
            <Shimmer as="p">{t('session.loading.sessionMessages')}</Shimmer>
          </div>
        </div>
      ) : chatMessages.length === 0 ? (
        <div className="mx-auto w-full max-w-[68rem]">
          <ChatEmptyState
            selectedSession={selectedSession}
            currentSessionId={currentSessionId}
            provider={provider}
            setInput={setInput}
          />
        </div>
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

          {/* 渲染窗口指示条。会话区没有虚拟化,窗口有多大就有多少真实 DOM,
              所以这里既要说清当前显示了多少,也要把"再放一批"和"整段展开"分成
              两个动作 —— 后者代价明显更大,得用户自己点。 */}
          {!hasMoreMessages && chatMessages.length > visibleMessageCount && (
            <div className="border-b border-border py-2 text-center text-sm text-muted-foreground">
              {t('session.messages.showingLast', { count: visibleMessageCount, total: chatMessages.length })} |
              <button className="ml-1 text-foreground underline hover:text-primary dark:text-primary" onClick={loadEarlierMessages}>
                {t('session.messages.loadEarlier')}
              </button>
              {' | '}
              <button
                className="text-foreground underline hover:text-primary dark:text-primary"
                onClick={allMessagesLoaded ? expandAllMessages : loadAllMessages}
              >
                {allMessagesLoaded ? t('session.messages.expandAll') : t('session.messages.loadAll')}
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
                    key={`subagents-${getGroupKey(item)}`}
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
                    key={`activity-${getGroupKey(item)}`}
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
                    sessionIsProcessing={isProcessing}
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

          {/*
            * 正在打字的正文。**列表外的独立元素**,不参与合并排序。
            *
            * 时序上它天然在末尾:`stream_end` 在下一批工具行之前就到并提交
            * (提交后它就是列表里一条普通的助手消息)。所以任意时刻最多只有
            * 一个活跃流式块,而且一定在这儿。key 恒定,内容变化只更新文本节点 ——
            * 不再是"每 100ms 重排整份 transcript + 重建全部 React element"。
            */}
          {streamingText ? (
            <MessageComponent
              key="message-streaming"
              message={streamingMessage!}
              prevMessage={null}
              createDiff={createDiff}
              onFileOpen={onFileOpen}
              onShowSettings={onShowSettings}
              onGrantToolPermission={onGrantToolPermission}
              showRawParameters={showRawParameters}
              showThinking={showThinking}
              selectedProject={selectedProject}
            />
          ) : null}

          {/* 运行中指示器站在消息流末尾 —— 输入框不再因为"在跑"而改形状 */}
          <ActivityIndicator activity={activity} />
        </>
      )}
      </div>
    </div>
  );
}

export default memo(ChatMessagesPane);
