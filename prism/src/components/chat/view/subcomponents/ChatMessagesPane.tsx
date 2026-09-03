import { useTranslation } from 'react-i18next';
import { memo, useCallback, useMemo, useRef } from 'react';
import type { Dispatch, ReactNode, RefObject, SetStateAction } from 'react';

import type { ChatMessage } from '../../types/types';
import type {
  Project,
  ProjectSession,
  LLMProvider,
} from '../../../../types/app';
import { Shimmer } from '../../../../shared/view/ui';
import { getIntrinsicMessageKey } from '../../utils/messageKeys';
import type { SessionActivity } from '../../../../hooks/useSessionProtection';
import type { RecentSessionEntry } from '../../utils/recentSessions';
import { extractTurnOutputsCached, type TurnOutputFile } from '../../utils/turnOutputs';
import { cn } from '../../../../lib/utils';
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
  /**
   * ef:首页空态(没选会话、没有消息)。这时滚动容器铺点阵画布(全库只此一处),
   * 输入框以 composerSlot 的形式嵌在问候语下面,再带上跨项目的最近会话。
   */
  isHome?: boolean;
  composerSlot?: ReactNode;
  recentSessions?: RecentSessionEntry[];
  onOpenSession?: (sessionId: string) => void;
  /**
   * ej:助手回答 id → 这一轮的产出文件,**服务端按全量历史算好**的那份。
   * 有它就以它为准,没有(还没拉到 / 刚跑完的这一轮)才退回窗口内现推。
   */
  serverTurnOutputs?: ReadonlyMap<string, TurnOutputFile[]>;
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
  isHome = false,
  composerSlot = null,
  recentSessions,
  onOpenSession,
  serverTurnOutputs,
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
   * ej:服务端产出映射落到**这一遍渲染的下标**上。
   *
   * 一条显示日志消息可能被拆成多条 ChatMessage(id 带 `#序号` 后缀),卡片只
   * 挂**最后一条** —— 产出该在这一轮说完话之后。先扫一遍再渲染,省得渲染中途
   * 还要往后看。
   */
  const serverOutputsByIndex = useMemo(() => {
    if (!serverTurnOutputs || serverTurnOutputs.size === 0) return null;
    const lastIndexById = new Map<string, number>();
    groupedVisibleMessages.forEach((item, index) => {
      if (isToolGroupItem(item) || isSubagentGroupItem(item)) return;
      if (item.type !== 'assistant' || item.isStreaming) return;
      const rawId = typeof item.id === 'string' ? item.id : '';
      if (!rawId) return;
      const baseId = rawId.split('#')[0];
      if (serverTurnOutputs.has(baseId)) lastIndexById.set(baseId, index);
    });
    if (lastIndexById.size === 0) return null;
    const byIndex = new Map<number, TurnOutputFile[]>();
    for (const [baseId, index] of lastIndexById) {
      const files = serverTurnOutputs.get(baseId);
      if (files) byIndex.set(index, files);
    }
    return byIndex;
  }, [groupedVisibleMessages, serverTurnOutputs]);

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
      className={cn(
        'chat-messages-pane relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto',
        isHome ? 'prism-canvas py-6' : 'pb-12 pt-3 sm:pb-14 sm:pt-4',
      )}
    >
      {/*
        * 正文宽度**恒定**。原来空会话用 68rem(给起始卡片排得开),有消息之后收到
        * 54.25rem —— 第一条消息落地的瞬间容器从 1088px 缩到 868px,已渲染的内容
        * 全部重新折行。宽度改成只属于空态那一块,消息列表这一支永远是 54.25rem。
        */}
      <div className={isHome ? 'flex min-h-full flex-col justify-center' : 'mx-auto w-full max-w-[54.25rem] space-y-3 px-4 sm:space-y-4'}>
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
          composerSlot={composerSlot}
          recentSessions={recentSessions}
          onOpenSession={onOpenSession}
        />
      ) : (
        <>
          {/* Loading indicator for older messages (hide when load-all is active).
              dl:换成骨架行 —— 顶端在补一页的时候,看到的是"内容的形状",
              而不是一行孤零零的文字。高度固定,落地后由滚动控制器守位。 */}
          {isLoadingMoreMessages && !isLoadingAllMessages && !allMessagesLoaded && (
            <div className="space-y-2.5 py-3" role="status" aria-label={t('session.loading.olderMessages')}>
              <div className="h-3.5 w-2/5 animate-pulse rounded bg-muted" />
              <div className="h-3.5 w-4/5 animate-pulse rounded bg-muted" />
              <div className="h-3.5 w-3/5 animate-pulse rounded bg-muted" />
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
            /**
             * ef:一轮的「产出」卡跟在**回答正文之后**(设计稿)。产出来自上面
             * 那段工具流,所以先在渲染工具组时把它算出来存这儿,等这一轮的助手
             * 回答渲染完再一起吐出来;中途遇到别的东西(用户又发了一条、错误)
             * 就丢掉 —— 那说明这一轮没有正文可挂。
             */
            let pendingTurnOutputs: TurnOutputFile[] = [];
            /**
             * eh 修:**窗口没到头时,第一段工具流是被切断的,不能拿它算产出。**
             *
             * 重进会话时先渲染的是尾部窗口,窗口起点常常落在某一轮的工具流中间 ——
             * 这一段只有末尾几个 Write,卡片先显示「产出 2」;等更早的消息补进来、
             * 这一段接回完整,又变成「产出 5」(用户截图)。数字当着人的面跳,
             * 比晚一点出现糟得多。
             *
             * 判据很直白:**渲染列表的第一项就是工具组**,而且窗口并没有覆盖到
             * 对话开头 —— 真实对话的第一条永远是用户消息,所以"工具组排在最前"
             * 只可能是被窗口切掉了前半截。这种情况下这一轮不出卡片,等窗口补齐。
             */
            const windowStartsAtBeginning = !hasMoreMessages && visibleMessageCount >= chatMessages.length;

            return groupedVisibleMessages.map((item, renderedIndex) => {
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
                pendingTurnOutputs = renderedIndex === 0 && !windowStartsAtBeginning
                  ? []
                  : extractTurnOutputsCached(item, item.messages, selectedProject?.fullPath || selectedProject?.path);

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
              // 服务端那份优先:它随消息一起到达、算的是全量历史,所以卡片
              // 一出现就是最终形态。拉不到(接口失败)或这一轮刚跑完还没回写时,
              // 才退回窗口内现推 —— 那一轮就在眼前,窗口一定是完整的。
              const serverOutputs = serverOutputsByIndex?.get(renderedIndex);
              const turnOutputs = item.type === 'assistant' && !item.isStreaming
                ? (serverOutputs ?? pendingTurnOutputs)
                : [];
              if (item.type !== 'assistant' || !item.isStreaming) pendingTurnOutputs = [];

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
                  canRerun={Boolean(onRetryLastTurn && item === lastItem && item.type === 'assistant' && !isProcessing)}
                  turnOutputs={turnOutputs}
                  onFileOpenPath={onFileOpen}
                  outputsSessionId={selectedSession?.id || currentSessionId || null}
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
