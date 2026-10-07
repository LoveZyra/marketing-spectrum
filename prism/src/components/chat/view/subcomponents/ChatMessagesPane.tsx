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
import type { ChatViewState } from '../../hooks/useChatSessionState';
import { extractTurnOutputsCached, mergeTurnOutputs, type TurnOutputFile } from '../../utils/turnOutputs';
import type { FeedbackPayload, MessageFeedbackRow } from '../../hooks/useMessageFeedback';
import { cn } from '../../../../lib/utils';
import { createGroupIdentityState, groupConsecutiveTools, isSubagentGroupItem, isToolGroupItem, stabilizeGroupIdentity } from '../../utils/toolGrouping';
import { focusActivityGroup, lastTurnBoundaryIndex, shouldKeepActivityTailOpen } from '../../utils/toolRowSummary';
import { activityItemRole, canRenderTurnOutputs, endsTurnForOutputs } from '../../utils/turnBoundary';
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
  /** 这条会话的正文处于哪一步 —— 'error' 与 'empty' 必须分开渲染。 */
  chatViewState: ChatViewState;
  /** 首屏拉取失败时的重试入口。 */
  onRetryLoadMessages: () => void;
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
  /** 失败一键重试:重发最近一条用户消息。 */
  onRetryLastTurn?: () => void;
  /**
   * 首页空态(没选会话、没有消息)。这时滚动容器铺点阵画布(全库只此一处)。
   * `isHome` 只管点阵画布和居中;输入框始终在页面底部。
   */
  isHome?: boolean;
  /**
   * 助手回答 id → 这一轮的产出文件,由服务端按全量历史算好。
   * 有它就以它为准,没有(还没拉到 / 刚跑完的这一轮)才退回窗口内现推。
   */
  serverTurnOutputs?: ReadonlyMap<string, TurnOutputFile[]>;
  /** 服务端抽中的「效果如何」卡(助手回答 id → skill)。 */
  skillSurveys?: ReadonlyMap<string, string>;
  /** 当前用户对各条回答的反馈(message id → 行),以及提交 / 撤销两个回调。 */
  feedbackByMessageId?: ReadonlyMap<string, MessageFeedbackRow>;
  onFeedbackSubmit?: (messageId: string, payload: FeedbackPayload) => Promise<unknown>;
  onFeedbackRemove?: (messageId: string) => Promise<void>;
}

/**
 * 流式气泡的时间戳。恒定值 —— 它不参与排序(不在列表里),而一个每 100ms
 * 变一次的时间戳会让下游所有以它为依据的 memo 全部失效。
 */
const STREAMING_TIMESTAMP = 0;

/**
 * 模块级空数组常量,不能写成字面量 []:MessageComponent 是浅比较的 memo,每次渲染一个新数组
 * 就会让整条列表重渲;流式期间本组件约 10Hz 重渲,窗口内的消息会跟着全部重渲。
 */
const NO_TURN_OUTPUTS: TurnOutputFile[] = [];


function ChatMessagesPane({
  scrollContainerRef,
  onWheel,
  onTouchMove,
  isLoadingSessionMessages,
  chatViewState,
  onRetryLoadMessages,
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
  serverTurnOutputs,
  skillSurveys,
  feedbackByMessageId,
  onFeedbackSubmit,
  onFeedbackRemove,
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
   * 组的 React key。取组自己的稳定身份,不能取段首消息 —— 窗口从头部长大
   * (补页 / 看更早 / 全部展开)会换掉段首,key 一变 React 就卸载重建整个
   * 时间轴:展开态丢失、高度当场突变。
   */
  /**
   * 把服务端产出映射落到这一遍渲染的下标上。
   *
   * 一条显示日志消息可能被拆成多条 ChatMessage(id 带 `#序号` 后缀),卡片只
   * 挂最后一条 —— 产出该在这一轮说完话之后。先扫一遍再渲染,省得渲染中途
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
   * 「效果如何」卡落到这一遍渲染的下标上,与 serverOutputsByIndex 同理:
   * 一条显示日志消息可能被拆成多条,卡只挂最后一条。
   */
  const surveyByIndex = useMemo(() => {
    if (!skillSurveys || skillSurveys.size === 0) return null;
    const lastIndexById = new Map<string, number>();
    groupedVisibleMessages.forEach((item, index) => {
      if (isToolGroupItem(item) || isSubagentGroupItem(item)) return;
      if (item.type !== 'assistant' || item.isStreaming) return;
      const rawId = typeof item.id === 'string' ? item.id : '';
      if (!rawId) return;
      const baseId = rawId.split('#')[0];
      if (skillSurveys.has(baseId)) lastIndexById.set(baseId, index);
    });
    if (lastIndexById.size === 0) return null;
    const byIndex = new Map<number, string>();
    for (const [baseId, index] of lastIndexById) byIndex.set(index, skillSurveys.get(baseId) as string);
    return byIndex;
  }, [groupedVisibleMessages, skillSurveys]);

  /**
   * 每条助手回答所属回合调用的 skill(点踩表单预填用)。从扁平的可见消息扫:
   * 用户消息开新一轮,`Skill` 工具帧记 skill,助手正文都记为这一轮的回答。
   */
  const skillByAnswerId = useMemo(() => {
    const map = new Map<string, string>();
    let currentSkill = '';
    for (const item of visibleMessages) {
      if (item.type === 'user') { currentSkill = ''; continue; }
      if (item.isToolUse && item.toolName === 'Skill') {
        // 工具行的 toolInput 在 useChatMessages 里被 JSON.stringify 成了字符串(实时流里则可能还是对象),两种都认。
        let input: { skill?: unknown } | null = null;
        if (typeof item.toolInput === 'string') {
          try { input = JSON.parse(item.toolInput) as { skill?: unknown }; } catch { input = null; }
        } else if (item.toolInput && typeof item.toolInput === 'object') {
          input = item.toolInput as { skill?: unknown };
        }
        if (typeof input?.skill === 'string' && input.skill.trim() && !currentSkill) currentSkill = input.skill.trim();
        continue;
      }
      if (item.type === 'assistant' && currentSkill && typeof item.id === 'string') {
        map.set(item.id.split('#')[0], currentSkill);
      }
    }
    return map;
  }, [visibleMessages]);

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
  /**
   * 滚动锚点用的行标识必须跨会话稳定,不能用 `_key`。
   *
   * `_key` 是 `group_${流水号}`,只在上一次渲染的登记表里认得出时沿用;登记表不分会话,
   * 切走再回来,这条会话的每个组都会换号,`resolveReadingSpot` 按 rowKey 就找不回阅读位置。
   * React 的 `key` 仍用 `_key`(保持组件身份);DOM 上的 data-row-key 用尾成员的内在 key:
   * 头部补页时不变,跨会话也不变。
   */
  const getGroupRowKey = (item: ToolGroupItem | SubagentGroupItem) => {
    const last = item.messages[item.messages.length - 1];
    return (last && getIntrinsicMessageKey(last)) || getGroupKey(item);
  };

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

  // getMessageKey 的引用要恒定:它是 ActivityTimeline 的 prop,每轮换新
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
       * 底部留白(给活动指示器让位)常驻,不随运行状态切换:切换会让 scrollHeight
       * 在每轮开跑 / 收尾时各跳约 40px,浏览器钳一次 scrollTop,整屏内容跟着上跳。
       */
      className={cn(
        'chat-messages-pane relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto',
        isHome ? 'prism-canvas py-6' : 'pb-12 pt-3 sm:pb-14 sm:pt-4',
      )}
    >
      {/* 消息列表这一支宽度恒定 54.25rem(空态的宽度只属于空态那一块):第一条消息落地时容器宽度不变,已渲染的内容不会重新折行 */}
      <div className={isHome ? 'flex min-h-full flex-col justify-center' : 'mx-auto w-full max-w-[54.25rem] space-y-3 px-4 sm:space-y-4'}>
      {(isLoadingSessionMessages || isProcessing) && chatMessages.length === 0 ? (
        <div className="mt-8 text-center text-muted-foreground">
          <div className="flex items-center justify-center space-x-2">
            <Shimmer as="p">{t('session.loading.sessionMessages')}</Shimmer>
          </div>
        </div>
      ) : chatViewState === 'error' && chatMessages.length === 0 ? (
        /*
         * 加载失败不是空会话:不能落到「这里还没有消息」的起始卡片,
         * 要说明是加载失败并给出重试入口。
         */
        <div className="mt-8 text-center" role="alert">
          <p className="text-sm text-muted-foreground">{t('session.messages.loadFailed')}</p>
          <button
            type="button"
            onClick={onRetryLoadMessages}
            className="mt-2 rounded-md border border-border px-3 py-1.5 text-sm text-foreground transition-colors hover:bg-accent"
          >
            {t('session.messages.retryLoad')}
          </button>
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
          {/* 补更早一页时顶端显示骨架行(load-all 进行中不显示);高度固定,落地后由滚动控制器守位 */}
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
            /**
             * 「最后一条」跳过回执行。定时任务的「✅ 执行完成」落在模型回复之后,
             * 若把它当最后一条,真正的最后一条回复/报错就失去「重发上一条」的控制。
             */
            let lastItem = groupedVisibleMessages[groupedVisibleMessages.length - 1];
            for (let i = groupedVisibleMessages.length - 1; i >= 0; i -= 1) {
              const candidate = groupedVisibleMessages[i];
              if ((candidate as ChatMessage).isTaskNotification) continue;
              lastItem = candidate;
              break;
            }
            /**
             * 哪一段属于"正在跑的这一轮",以及它的正文写了没有。
             *
             * 两件事一次倒扫算出来,判据收在 `focusActivityGroup` 里
             * (为什么必须一起算,见那个函数的注释)。这里只负责把结果分发下去:
             * `sessionIsProcessing` 管行状态(运行中 / 已中断),
             * `keepTailOpen` 管折不折。
             *
             * 正文正在流式打字时它不在这张列表里(流式气泡在 map 之外单独渲染),
             * 所以要把 `streamingText` 显式告诉它 —— 否则"正文出现就收起"
             * 会一直等到这一段正文落地才生效,慢整整一个回合。
             */
            // 最后一条回合边界之后的项都属于最新那一轮 —— 子代理卡拿它判
            // 「进行中」还是「已中断」(见 lastTurnBoundaryIndex 的注释)。
            const turnBoundaryIndex = lastTurnBoundaryIndex(
              groupedVisibleMessages.length,
              (index) => activityItemRole(groupedVisibleMessages[index]),
            );
            const activityFocus = focusActivityGroup(
              groupedVisibleMessages.length,
              (index) => activityItemRole(groupedVisibleMessages[index]),
              Boolean(streamingText),
            );
            /**
             * 一轮的「产出」卡跟在回答正文之后。产出来自前面的工具流,所以渲染工具组时
             * 先算好存在这里,等这一轮的助手回答渲染时再挂上;遇到回合边界(用户又发了
             * 一条、错误)就丢掉 —— 那说明这一轮没有正文可挂。
             */
            let pendingTurnOutputs: TurnOutputFile[] = NO_TURN_OUTPUTS;
            /**
             * 窗口没到头时,第一段工具流是被切断的,不能拿它算产出。
             *
             * 重进会话时先渲染的是尾部窗口,窗口起点常常落在某一轮的工具流中间 ——
             * 这一段只有末尾几个 Write,卡片先显示「产出 2」;等更早的消息补进来、
             * 这一段接回完整,又变成「产出 5」。数字当着人的面跳,比晚一点出现糟得多。
             *
             * 判据很直白:渲染列表的第一项就是工具组,而且窗口并没有覆盖到
             * 对话开头 —— 真实对话的第一条永远是用户消息,所以"工具组排在最前"
             * 只可能是被窗口切掉了前半截。这种情况下这一轮不出卡片,等窗口补齐。
             */
            const windowStartsAtBeginning = !hasMoreMessages && visibleMessageCount >= chatMessages.length;

            return groupedVisibleMessages.map((item, renderedIndex) => {
              // 子代理卡片组:抬头 + 网格子卡 + 点开看各自的步骤时间轴。
              if (isSubagentGroupItem(item)) {
                const groupPrevMessage = item.messages[item.messages.length - 1] || prevMessage;
                prevMessage = groupPrevMessage;
                /**
                 * 子代理写出的文件也算本轮产出(extractTurnOutputs 会扫 subagentState.childTools):
                 * 一轮里只派子代理干活时也要有产出卡,与右侧工作面板的会话级产出表对得上。
                 */
                if (renderedIndex !== 0 || windowStartsAtBeginning) {
                  pendingTurnOutputs = mergeTurnOutputs(
                    pendingTurnOutputs,
                    extractTurnOutputsCached(
                      item, item.messages, selectedProject?.fullPath || selectedProject?.path,
                    ),
                  );
                }
                return (
                  <SubagentGroupCard
                    key={`subagents-${getGroupKey(item)}`}
                    rowKey={`subagents-${getGroupRowKey(item)}`}
                    group={item}
                    getMessageKey={getMessageKey}
                    isCurrentTurn={isProcessing && renderedIndex > turnBoundaryIndex}
                  />
                );
              }

              if (isToolGroupItem(item)) {
                const isCurrentTurnGroup = isProcessing && renderedIndex === activityFocus.index;
                const groupPrevMessage = prevMessage;
                prevMessage = item.messages[item.messages.length - 1] || prevMessage;
                /**
                 * 累加而不是赋值,与子代理分支一致:一轮里常有多段工具流(子代理组、
                 * ExitPlanMode / AskUserQuestion、压缩摘要、任务通知都会把它切开),
                 * 赋值会让后一段覆盖前面攒下的产出。
                 */
                pendingTurnOutputs = renderedIndex === 0 && !windowStartsAtBeginning
                  ? NO_TURN_OUTPUTS
                  : mergeTurnOutputs(
                    pendingTurnOutputs,
                    extractTurnOutputsCached(item, item.messages, selectedProject?.fullPath || selectedProject?.path),
                  );

                return (
                  <ActivityTimeline
                    key={`activity-${getGroupKey(item)}`}
                    rowKey={`activity-${getGroupRowKey(item)}`}
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
                    // 行状态:只有"正在跑的这一轮"那一段的无结果工具行算「运行中」。
                    sessionIsProcessing={isCurrentTurnGroup}
                    // 折叠:属于这一轮 且正文还没开始出现才留尾部三行。
                    keepTailOpen={shouldKeepActivityTailOpen(isCurrentTurnGroup, activityFocus.replyStarted)}
                  />
                );
              }

              const messagePrevMessage = prevMessage;
              prevMessage = item;
              // 服务端那份优先:它随消息一起到达、算的是全量历史,所以卡片
              // 一出现就是最终形态。拉不到(接口失败)或这一轮刚跑完还没回写时,
              // 才退回窗口内现推 —— 那一轮就在眼前,窗口一定是完整的。
              const serverOutputs = serverOutputsByIndex?.get(renderedIndex);
              /**
               * 判据是"这条能不能真的挂产出卡"(canRenderTurnOutputs),不只是"助手且不在流式":
               * ExitPlanMode / AskUserQuestion、任务通知、压缩摘要也满足后者,但它们的渲染分支
               * 不读 turnOutputs,让它们领走产出就丢了。挂不了的项不领取,pending 继续传给
               * 真正的正文那条;要不要清空由下面的回合边界判断决定。
               */
              const canCarryOutputs = canRenderTurnOutputs(item);
              const turnOutputs = canCarryOutputs
                ? (serverOutputs ?? pendingTurnOutputs)
                : NO_TURN_OUTPUTS;
              if (canCarryOutputs) {
                pendingTurnOutputs = NO_TURN_OUTPUTS;
              } else if (endsTurnForOutputs(item)) {
                /**
                 * 回合边界要清账,否则产出会跨到下一轮的回答下面(Write → 报错 → 用户又问一句 → 助手回答)。
                 * 挂不了卡但属于本轮的(思考、工具行、交互式提示)继续往下传;开启新一轮的(用户消息)
                 * 和终结本轮的(错误行)就地清空。
                 */
                pendingTurnOutputs = NO_TURN_OUTPUTS;
              }

              // 只有收尾在错误上的对话才给重试按钮:老错误早被后面的
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
                  rowKey={getMessageKey(item)}
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
                  feedback={feedbackByMessageId?.get(String(item.id ?? '').split('#')[0]) ?? null}
                  feedbackSkillHint={skillByAnswerId.get(String(item.id ?? '').split('#')[0]) ?? null}
                  skillSurvey={canCarryOutputs && surveyByIndex?.has(renderedIndex) ? { skill: surveyByIndex.get(renderedIndex) as string } : null}
                  onFeedbackSubmit={onFeedbackSubmit}
                  onFeedbackRemove={onFeedbackRemove}
                />
              );
            });
          })()}

          {/*
            * 正在打字的正文。列表外的独立元素,不参与合并排序。
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
