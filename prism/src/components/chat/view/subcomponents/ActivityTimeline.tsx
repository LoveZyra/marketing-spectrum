import { memo, useEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpen,
  Bot,
  Brain,
  FilePlus2,
  FolderSearch,
  Globe,
  ChevronDown,
  ChevronRight,
  ListChecks,
  MessageSquareText,
  PencilLine,
  Plug,
  Search,
  SquareTerminal,
  Wrench,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { ChatMessage, ClaudePermissionSuggestion, PermissionGrantResult } from '../../types/types';
import type { Project } from '../../../../types/app';
import type { ToolGroupItem } from '../../utils/toolGrouping';
import type { ActivityIconKey, ActivityVerb } from '../../utils/toolRowSummary';
import { ACTIVITY_TAIL_ROWS, collapsedVisibleCount, formatRunDuration, planActivityFold, summarizeActivityRun, summarizeToolRow, toolTarget } from '../../utils/toolRowSummary';
import { cn } from '../../../../lib/utils';
import { ClampedBlock } from '../../../../shared/view/ui';

import MessageComponent from './MessageComponent';
import { Markdown } from './Markdown';

type DiffLine = {
  type: string;
  content: string;
  lineNum: number;
};

interface ActivityTimelineProps {
  group: ToolGroupItem;
  prevMessage: ChatMessage | null;
  createDiff: (oldStr: string, newStr: string) => DiffLine[];
  getMessageKey: (message: ChatMessage) => string;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onShowSettings?: () => void;
  onGrantToolPermission?: (suggestion: ClaudePermissionSuggestion) => PermissionGrantResult | null | undefined;
  showRawParameters?: boolean;
  showThinking?: boolean;
  selectedProject?: Project | null;
  /** 这一段属于正在跑的那一轮吗 —— 决定没结果的工具行是「运行中」还是「已中断」。 */
  sessionIsProcessing?: boolean;
  /**
   * 这一段要不要留着尾部三行不折。
   *
   * 判据在调用方(`focusActivityGroup` + `shouldKeepActivityTailOpen`)——
   * 它要看整张列表才答得出"正文出现了没有",段内看不到。
   */
  keepTailOpen?: boolean;
  /** 滚动位置锚点用的稳定行标识(见 useChatSessionState 里的 data-row-key)。 */
  rowKey?: string;
}

const ICONS: Record<ActivityIconKey, LucideIcon> = {
  read: BookOpen,
  write: FilePlus2,
  edit: PencilLine,
  bash: SquareTerminal,
  search: Search,
  glob: FolderSearch,
  fetch: Globe,
  agent: Bot,
  todo: ListChecks,
  mcp: Plug,
  thinking: Brain,
  tool: Wrench,
  // narration 行不走这张表(渲染成小圆点),这里只为类型完备
  narration: MessageSquareText,
};

/** 动词 → i18n 键与中文兜底。目标为空时退化成只有动词的短句。 */
const VERB_TEXT: Record<Exclude<ActivityVerb, 'generic'>, { key: string; withTarget: string; bare: string }> = {
  read: { key: 'activity.read', withTarget: '读取 {{target}}', bare: '读取文件' },
  write: { key: 'activity.write', withTarget: '写入 {{target}}', bare: '写入文件' },
  edit: { key: 'activity.edit', withTarget: '编辑 {{target}}', bare: '编辑文件' },
  bash: { key: 'activity.bash', withTarget: '执行 {{target}}', bare: '执行命令' },
  search: { key: 'activity.search', withTarget: '搜索 {{target}}', bare: '搜索' },
  glob: { key: 'activity.glob', withTarget: '匹配 {{target}}', bare: '列目录' },
  fetch: { key: 'activity.fetch', withTarget: '抓取 {{target}}', bare: '抓取网页' },
  agent: { key: 'activity.agent', withTarget: '子代理 {{target}}', bare: '子代理' },
  todo: { key: 'activity.todo', withTarget: '更新任务清单', bare: '更新任务清单' },
};

/** 抬头里每一类的计数文案。 */
const SUMMARY_TEXT: Record<ActivityIconKey, { key: string; fallback: string }> = {
  bash: { key: 'activity.summary.bash', fallback: '执行 {{count}} 条命令' },
  write: { key: 'activity.summary.write', fallback: '新建 {{count}} 个文件' },
  edit: { key: 'activity.summary.edit', fallback: '编辑 {{count}} 处' },
  read: { key: 'activity.summary.read', fallback: '读取 {{count}} 个文件' },
  search: { key: 'activity.summary.search', fallback: '搜索 {{count}} 次' },
  glob: { key: 'activity.summary.glob', fallback: '列目录 {{count}} 次' },
  fetch: { key: 'activity.summary.fetch', fallback: '抓取 {{count}} 个网页' },
  agent: { key: 'activity.summary.agent', fallback: '子代理 {{count}} 个' },
  todo: { key: 'activity.summary.todo', fallback: '更新任务清单 {{count}} 次' },
  mcp: { key: 'activity.summary.mcp', fallback: '外部工具 {{count}} 次' },
  tool: { key: 'activity.summary.tool', fallback: '其它工具 {{count}} 次' },
  narration: { key: 'activity.summary.narration', fallback: '说明 {{count}} 段' },
  thinking: { key: 'activity.summary.thinking', fallback: '思考 {{count}} 次' },
};

/**
 * 活动时间轴 —— 一轮里的思考与工具调用按发生顺序排在同一条竖线上。
 *
 * **默认展开多少,取决于这一轮跑完没有**:
 * - 还在跑:只摊开最新 3 步 —— 正在看的永远是"现在在干什么",更早的先收起来;
 * - 已跑完:**无论几步都整段收成抬头那一行** —— 做完的活儿不该继续占着屏幕。
 *
 * 两种情况都点抬头展开全部。进行中且不足 3 步的段全摊着,没什么可折的。
 *
 * 竖线是每行图标下方那一截拼出来的:`flex-1` 撑到本行底部,末行不画。于是线
 * 正好起于第一个图标、止于最后一个图标;某一行展开后,它这一截自然拉长,
 * 竖线继续贯穿展开区,不会断(ej 修:此前写死 10px,展开就断)。
 *
 * 每行只给一句人话(工具自带 description 就用它),原始命令、参数、输出都收在
 * 展开区里 —— 展开走的还是既有的 MessageComponent,渲染能力一项不减。
 */
function ActivityTimeline({
  group,
  prevMessage,
  createDiff,
  getMessageKey,
  onFileOpen,
  onShowSettings,
  onGrantToolPermission,
  showRawParameters,
  showThinking,
  selectedProject,
  sessionIsProcessing = true,
  keepTailOpen = false,
  rowKey,
}: ActivityTimelineProps) {
  const { t } = useTranslation('chat');
  const [expandedKeys, setExpandedKeys] = useState<ReadonlySet<string>>(() => new Set<string>());
  /**
   * 用户手动定过的展开状态,`null` = 跟着自动规则走。
   *
   * 以前这里是一个布尔 `isRunOpen`("是否展开全部"),自动规则一变它就表达不了
   * "我手动收起来了" —— 抬头现在只要有一行就出现,而这一行可能一条都没折,
   * 点它必须是**收起**,布尔那套只能在"展开全部 / 回到自动"之间来回。
   */
  const [manualFold, setManualFold] = useState<'open' | 'closed' | null>(null);
  /**
   * gh:用户点「收起」时如果收到的是 0 行(段内 ≤3 行、或回合已结束),就记住"收到 0"。
   * 否则回合还在跑、第 4 步一到,`collapsedVisibleCount` 从 0 变 3,三行在用户
   * 明确收起的抬头下面自己弹出来,而 manualFold 仍是 closed、再点一次反而全开。
   * 用户反向点开时清掉。
   */
  const closedToZeroRef = useRef(false);
  /**
   * gh:**"正文出现了"要坐实 250ms 才算数。**
   *
   * 每条助手 text 都是 'reply',于是 `[组][text]` 一到,keepTailOpen 翻假、整段折起;
   * 下一帧 tool_use 到达,text 被吸进组里,keepTailOpen 又翻真、整段展开 ——
   * 一段跑 30 步的回合里每句「Now let me check X」都让时间轴缩一下再长回来。
   * 这里只把 true→false 这一个方向延后 250ms:真正的正文(后面不再有工具)照旧折,
   * 只是晚一眨眼;要被吸收的过渡正文在这 250ms 里就被吸收了,不再抖。
   */
  const settledKeepTail = useSettledTrue(keepTailOpen, 250);

  const rows = useMemo(
    () => group.messages.map((message, index) => {
      const kind: 'thinking' | 'narration' | 'tool' = message.isThinking
        ? 'thinking'
        : message.isToolUse
          ? 'tool'
          : 'narration';
      return {
        message,
        index,
        kind,
        key: getMessageKey(message),
        summary: kind === 'tool' ? summarizeToolRow(message, sessionIsProcessing) : null,
      };
    }),
    // sessionIsProcessing 必须进依赖:会话由「在跑」变成「不在跑」时,
    // 那些还没有结果的工具行要从「运行中」翻成「已中断」,不重算就翻不过来。
    [group.messages, getMessageKey, sessionIsProcessing],
  );

  const summarySegments = useMemo(() => summarizeActivityRun(group.messages), [group.messages]);
  const summaryText = summarySegments
    .map(({ key, count }) => t(SUMMARY_TEXT[key].key, { count, defaultValue: SUMMARY_TEXT[key].fallback }))
    .join(' · ');

  // 这一轮还有没有在跑的步骤 —— 决定收起时留几行(规则见 planActivityFold)。
  // 折不折看的是**回合有没有结束**,而不是这一段里还有没有工具在跑 ——
  // 后者会在最后一个工具刚返回、正文还没开始写的那一刻把整段塌掉(见 planActivityFold)。
  const hasRunning = rows.some((row) => row.summary?.status === 'running');
  // 抬头右端的整段耗时:把各行耗时加起来(没有一行报出耗时就不显示)。
  const runDuration = useMemo(() => formatRunDuration(group.messages), [group.messages]);
  // 自动规则(见 planActivityFold):正文没出现前留尾部三行,出现后整段收起。
  const auto = planActivityFold(rows.length, settledKeepTail);
  /**
   * 手动定过就以手动为准 —— 用户明确点过的状态不该被下一次自动重算冲掉。
   *
   * gb:**手动"收起"的目标不再是写死的 0**,而是与自动规则同一个判据
   * (`collapsedVisibleCount`):回合还在跑就留尾部三行,回合结束才收干净。
   * 写死 0 时,一轮跑到几十步点一下收起,正在跑的那几步也一起没了,
   * 而且这一轮剩下的全程都不再露出来(manualFold 压过自动规则)。
   */
  const collapsedCount = collapsedVisibleCount(rows.length, settledKeepTail);
  const visibleCount = manualFold === 'open'
    ? rows.length
    : manualFold === 'closed'
      ? (closedToZeroRef.current ? 0 : collapsedCount)
      : auto.visibleCount;
  const foldedCount = rows.length - visibleCount;
  const { canFold, showSummary } = auto;
  /** 全都摊开了 —— 抬头此时的动作是「收起」,不是「展开」。 */
  const isFullyOpen = rows.length > 0 && visibleCount >= rows.length;

  /**
   * 收尾折叠走**高度过渡**,不是瞬间卸载。
   *
   * 回合结束时 `visibleCount` 从 3 掉到 0,如果直接把行卸载,几百像素当场消失 ——
   * 页面"啪"地跳一下。这里让行**留在 DOM 里**,由容器从 `1fr` 过渡到 `0fr`
   * (grid 的收起技巧,不需要量高度),看着是收进抬头,而不是凭空不见。
   * 代价是每段多留 3 行不可见的 DOM,换一次不刺眼的收尾。
   */
  const rowsCollapsed = visibleCount === 0;
  const visibleRows = isFullyOpen
    ? rows
    : rows.slice(Math.max(0, rows.length - Math.max(visibleCount, rowsCollapsed ? ACTIVITY_TAIL_ROWS : 0)));

  const toggle = (key: string) => {
    setExpandedKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div
      className="chat-message tool px-3 sm:px-0"
      data-message-timestamp={group.timestamp || undefined}
      /* ga:滚动位置恢复靠它精确找回"上次读到的那一行"(见 rowKey)。 */
      data-row-key={rowKey}
    >
      {/* 整段小结:一句话说清这一轮干了什么,并且是这些步骤的**唯一入口**。
          fw:**只要有一行就出现**。此前"少于三步不给抬头",于是一个回合刚开跑
          时行光秃秃地摊着,等第三行落地抬头才凭空冒出来、整段还往下错一档。
          点它 = 全摊开 / 全收起(半折状态点一次先摊开)。
          ei:**不套白框**。eg 那轮按 mockup 给它加了卡片外框,实机看下来那是给
          对话流凭空多加一层容器 —— 一轮里可能有好几段活动,几个白框摞在正文之间
          比内容本身还抢眼。回到一行次级墨色的纯文本(Cowork 的做法),
          容器交给消息本身。 */}
      {showSummary && canFold && (
        <button
          type="button"
          data-activity-summary
          onClick={() => {
            if (isFullyOpen) {
              // 收到 0 行的那一下要记住(见 closedToZeroRef)。
              closedToZeroRef.current = collapsedCount === 0;
              setManualFold('closed');
            } else {
              closedToZeroRef.current = false;
              setManualFold('open');
            }
          }}
          aria-expanded={isFullyOpen}
          className="group flex w-full items-center gap-2 py-1.5 text-left text-[13px] leading-5 text-muted-foreground transition-colors hover:text-foreground"
        >
          {isFullyOpen
            ? <ChevronDown className="h-3.5 w-3.5 flex-none text-muted-foreground" aria-hidden />
            : <ChevronRight className="h-3.5 w-3.5 flex-none text-muted-foreground" aria-hidden />}
          <span className="min-w-0 flex-1 truncate">{summaryText}</span>
          {/* 右端只出一样东西,按优先级:
              全摊开 → 「收起」;半折 → 被折了多少;整段收起 → 整段耗时。 */}
          {runDuration && rowsCollapsed && (
            <span className="flex-none font-mono text-[11px] text-muted-foreground">{runDuration}</span>
          )}
          {hasRunning && (
            <span className="flex flex-none items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
              <span className="prism-dot h-1.5 w-1.5 flex-none bg-primary" aria-hidden />
              {t('activity.running', { defaultValue: '运行中' })}
            </span>
          )}
          {isFullyOpen ? (
            <span className="flex-none font-mono text-[11px] text-muted-foreground">
              {t('activity.collapseRun', { defaultValue: '收起' })}
            </span>
          ) : foldedCount > 0 && !rowsCollapsed ? (
            <span className="flex-none font-mono text-[11px] text-muted-foreground">
              {t('activity.foldedCount', { count: foldedCount, defaultValue: '+{{count}}' })}
            </span>
          ) : null}
        </button>
      )}

      <div
        className={cn('prism-activity-rows', rowsCollapsed && 'is-collapsed')}
        aria-hidden={rowsCollapsed || undefined}
        // 收起的行留在 DOM 里做高度过渡,但对键盘和读屏必须真正不存在:
        // aria-hidden 挡不住 Tab 焦点落进看不见的按钮。inert 经 ref 设置,
        // 因为 React 18 还不认布尔的 inert 属性。
        ref={(el) => { if (el) el.inert = rowsCollapsed; }}
      >
      <div className="min-h-0 overflow-hidden pt-0.5">
      {visibleRows.map((row, position) => {
        const isLastRow = position === visibleRows.length - 1;
        const index = row.index;
        const isExpanded = expandedKeys.has(row.key);
        const summary = row.summary;

        // 过渡性正文(cd 轮):不是"一行标签点开看详情",正文本身就是内容 ——
        // 小圆点挂在竖线上,全文内联(超长由 ClampedBlock 先折),流程不断线。
        if (row.kind === 'narration') {
          const narrationText = String(row.message.content || '');
          return (
            <div key={row.key} className="flex gap-2">
              {/*
                ek:圆点要和正文**第一行的中心**对齐,所以这一格的高度得跟着正文算:
                正文 `py-1.5`(6px)+ 13.5px/22 的首行 → 中心在 6 + 11 = 17px,
                格高 34px 时圆点正好落在那儿。此前写的是 26px(格中心 13px),
                圆点比字高了 4px —— 探针量出来就是 −4(用户截图里看得出来)。
              */}
              <span className="flex w-4 flex-none flex-col items-center" aria-hidden>
                <span className="flex h-[34px] items-center justify-center">
                  <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground" />
                </span>
                {!isLastRow && <span className="prism-activity-link min-h-[10px] w-px flex-1" />}
              </span>

              {/* ej:复制只留 ClampedBlock 右上角那一枚。这里原本在正文下面又挂了
                  一个 MessageCopyControl,同一段话两个复制按钮(用户截图)——
                  一个悬停出现在右上、一个常驻在左下,谁也说不清有什么区别。 */}
              <div className="min-w-0 flex-1 py-1.5">
                <ClampedBlock maxHeight={320} copyText={narrationText}>
                  <Markdown className="prose prose-sm max-w-none font-sans text-[13.5px] leading-[22px] text-body dark:prose-invert">
                    {narrationText}
                  </Markdown>
                </ClampedBlock>
              </div>
            </div>
          );
        }

        const iconKey: ActivityIconKey = summary ? summary.icon : 'thinking';
        /**
         * 行首图标 = **工具类型**(读=书、写=加号文件、执行=终端…),失败换 XCircle。
         *
         * eh:eg 那轮改成过一列 ✓ / ◌ / ✕ 的状态图标,试下来是丢信息 ——
         * 扫一眼看不出这一段里都动用了什么。**状态交给颜色**(这也是竖线时代
         * 就在用的那套):进行中 = 强调紫,跑完 = 次级墨色,失败 = 红。
         * 竖线不恢复:抬头卡片已经把这一段框起来了,里面再画一条贯穿线是第二层框。
         */
        const Icon = summary?.status === 'error' ? XCircle : ICONS[iconKey];

        const label = summary
          ? summary.label.description
            || (summary.label.verb === 'generic'
              ? [summary.label.toolLabel, summary.label.target].filter(Boolean).join(' ')
              : t(VERB_TEXT[summary.label.verb].key, {
                target: summary.label.target,
                defaultValue: summary.label.target
                  ? VERB_TEXT[summary.label.verb].withTarget
                  : VERB_TEXT[summary.label.verb].bare,
              })).trim()
          : t('activity.thinking', { defaultValue: '思考' });

        // 悬停提示给全量目标(标签里是缩短过的文件名 / 主机名)
        const title = summary
          ? [summary.name, toolTarget(summary.name, row.message.toolInput)].filter(Boolean).join(' · ')
          : t('activity.thinking', { defaultValue: '思考' });

        return (
          <div key={row.key} className="flex gap-2">
            {/*
              图标列:图标 + 图标下方的连接线(最后一行不画)。
              eh:这是 Cowork 那种「竖线把相邻两步串起来」的连法 —— 只连相邻两个
              图标之间的空档,不是 eg 之前那条贯穿整段的长轨(长轨在抬头卡片里
              等于第二层框)。
              ej:连接线由固定 10px 改成 `flex-1`(行不再 items-start,图标列跟着
              行高撑满)。之前展开某一行,行高涨了几百像素、线还是那 10px,
              线就在展开区顶上断成一小截、下一个图标孤零零挂在下面(用户截图)。
              现在展开多高、线就跟到多高,始终把上下两个图标连起来。
            */}
            <span className="flex w-4 flex-none flex-col items-center" aria-hidden>
              <span className="flex h-[30px] items-center justify-center">
              <Icon
                className={cn(
                  'h-4 w-4 flex-none',
                  summary?.status === 'error'
                    ? 'text-destructive'
                    : summary?.status === 'running'
                      ? 'text-primary'
                      : 'text-muted-foreground',
                )}
                strokeWidth={2}
              />
              </span>
              {!isLastRow && <span className="prism-activity-link min-h-[10px] w-px flex-1" />}
            </span>

            <div className="min-w-0 flex-1">
              <button
                type="button"
                onClick={() => toggle(row.key)}
                aria-expanded={isExpanded}
                className="group flex w-full items-center gap-2.5 py-[5px] text-left"
              >
                <span
                  className="min-w-0 flex-1 truncate text-[13px] leading-5 text-body transition-colors group-hover:text-foreground"
                  title={title}
                >
                  {label}
                </span>

                {summary?.metric && (
                  <span
                    className={cn(
                      'flex-none font-mono text-[11px]',
                      // 写操作的增删用强调色;淡色模式下绿色不做小字,改墨色
                      summary.metricIsWrite ? 'text-card-foreground dark:text-primary' : 'text-muted-foreground',
                    )}
                  >
                    {summary.metric}
                  </span>
                )}

                <span className="flex-none font-mono text-[11px] text-muted-foreground">
                  {summary?.status === 'running'
                    ? t('activity.running', { defaultValue: '运行中' })
                    : summary?.status === 'interrupted'
                      ? t('activity.interrupted', { defaultValue: '已中断' })
                      : summary?.status === 'error'
                        ? t('activity.failed', { defaultValue: '失败' })
                        : summary?.duration}
                </span>
              </button>

              {isExpanded && (
                <div className="pb-2 pt-0.5">
                  {row.message.isThinking ? (
                    /* 思考是旁注不是正文:压一档字号与颜色,左侧留发丝线,
                       太长先折 10 行左右,底下给「展开全部」。复制同样只留
                       ClampedBlock 右上角那一枚(ej)。 */
                    <ClampedBlock
                      maxHeight={220}
                      copyText={String(row.message.content || '')}
                      contentClassName="border-l border-border pl-3"
                    >
                      <Markdown className="prose prose-sm max-w-none font-sans text-[13px] leading-[21px] text-muted-foreground dark:prose-invert">
                        {String(row.message.content || '')}
                      </Markdown>
                    </ClampedBlock>
                  ) : (
                    <MessageComponent
                      bare
                      message={row.message}
                      prevMessage={index > 0 ? group.messages[index - 1] : prevMessage}
                      createDiff={createDiff}
                      onFileOpen={onFileOpen}
                      onShowSettings={onShowSettings}
                      onGrantToolPermission={onGrantToolPermission}
                      showRawParameters={showRawParameters}
                      showThinking={showThinking}
                      selectedProject={selectedProject}
                    />
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })}
      </div>
      </div>
    </div>
  );
}

/**
 * memo 的前提是 `group` 引用稳定 —— ChatMessagesPane 在分组后做了身份保持:
 * 成员没变的段沿用上一轮的同一个 ToolGroupItem 对象。于是流式期间只有
 * 正在跑的那一段重渲,已完成的时间轴整段跳过(每段都要重算 rows/摘要,
 * 长对话里这占了 tick 开销的大头)。
 */
/**
 * gh:布尔值的"true→false 延后 N 毫秒"版本(false→true 立刻)。
 * 用于把"正文出现了 → 折叠"这一下延后一眨眼,让会被吸收的过渡正文来得及被吸收。
 */
function useSettledTrue(value: boolean, delayMs: number): boolean {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    if (value) {
      setSettled(true);
      return undefined;
    }
    const timer = setTimeout(() => setSettled(false), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return value ? true : settled;
}

export default memo(ActivityTimeline);
