import { memo, useMemo, useState } from 'react';
import {
  BookOpen,
  Bot,
  Brain,
  FilePlus2,
  FolderSearch,
  Globe,
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
import { ACTIVITY_TAIL_ROWS, planActivityFold, summarizeActivityRun, summarizeToolRow, toolTarget } from '../../utils/toolRowSummary';
import { cn } from '../../../../lib/utils';
import { ClampedBlock } from '../../../../shared/view/ui';

import MessageComponent from './MessageComponent';
import { Markdown } from './Markdown';
import MessageCopyControl from './MessageCopyControl';

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
  /** 会话此刻还在跑吗 —— 决定没结果的工具行是「运行中」还是「已中断」。 */
  sessionIsProcessing?: boolean;
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
 * 竖线是靠每行图标列里的两截线拼出来的:图标上方固定 8px、下方 `flex-1` 撑到行底。
 * 首行不画上截、末行不画下截,于是线正好起于第一个图标、止于最后一个图标;
 * 某一行展开后,它的下截会自然拉长,竖线继续贯穿展开区,不会断。
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
}: ActivityTimelineProps) {
  const { t } = useTranslation('chat');
  const [expandedKeys, setExpandedKeys] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [isRunOpen, setIsRunOpen] = useState(false);

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
  const keepTail = hasRunning || sessionIsProcessing;
  const { visibleCount, foldedCount, canFold, showSummary } = planActivityFold(rows.length, keepTail);
  const collapsedRows = visibleCount === 0 ? [] : rows.slice(rows.length - visibleCount);

  /**
   * 收尾折叠走**高度过渡**,不是瞬间卸载。
   *
   * 回合结束时 `visibleCount` 从 3 掉到 0,如果直接把行卸载,几百像素当场消失 ——
   * 页面"啪"地跳一下。这里让行**留在 DOM 里**,由容器从 `1fr` 过渡到 `0fr`
   * (grid 的收起技巧,不需要量高度),看着是收进抬头,而不是凭空不见。
   * 代价是每段多留 3 行不可见的 DOM,换一次不刺眼的收尾。
   */
  const rowsCollapsed = !isRunOpen && visibleCount === 0;
  const visibleRows = isRunOpen
    ? rows
    : (rowsCollapsed ? rows.slice(Math.max(0, rows.length - ACTIVITY_TAIL_ROWS)) : collapsedRows);

  const toggle = (key: string) => {
    setExpandedKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="chat-message tool px-3 sm:px-0" data-message-timestamp={group.timestamp || undefined}>
      {/* 整段小结:一句话说清这一轮干了什么。上面还压着更早的步骤时,
          这一行就是那些步骤的入口(点开=展开全部,再点=收回到最新 3 步)。 */}
      {showSummary && (canFold ? (
        <button
          type="button"
          onClick={() => setIsRunOpen((current) => !current)}
          aria-expanded={isRunOpen}
          className="group flex w-full items-center gap-1.5 py-1.5 text-left text-[13px] leading-5 text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronRight
            className={cn('h-3.5 w-3.5 flex-none transition-transform', isRunOpen && 'rotate-90')}
            strokeWidth={2}
            aria-hidden
          />
          <span className="min-w-0 truncate">{summaryText}</span>
          {/* 整段收起时不给「+N」—— 抬头那句话本身已经把这一轮说完了;
              只有"上面还压着一截"的半折状态才需要标出被折了多少。 */}
          {(isRunOpen || collapsedRows.length > 0) && (
            <span className="flex-none font-mono text-[11px] text-muted-foreground">
              {isRunOpen
                ? t('activity.collapseRun', { defaultValue: '收起' })
                : t('activity.foldedCount', { count: foldedCount, defaultValue: '+{{count}}' })}
            </span>
          )}
        </button>
      ) : (
        <div className="flex w-full items-center gap-1.5 py-1.5 pl-[19px] text-[13px] leading-5 text-muted-foreground">
          <span className="min-w-0 truncate">{summaryText}</span>
        </div>
      ))}

      <div
        className={cn('prism-activity-rows', rowsCollapsed && 'is-collapsed')}
        aria-hidden={rowsCollapsed || undefined}
      >
      <div className="min-h-0 overflow-hidden">
      {visibleRows.map((row, position) => {
        const index = row.index;
        const isFirst = position === 0;
        const isLast = position === visibleRows.length - 1;
        const isExpanded = expandedKeys.has(row.key);
        const summary = row.summary;

        // 过渡性正文(cd 轮):不是"一行标签点开看详情",正文本身就是内容 ——
        // 小圆点挂在竖线上,全文内联(超长由 ClampedBlock 先折),流程不断线。
        if (row.kind === 'narration') {
          const narrationText = String(row.message.content || '');
          return (
            <div key={row.key} className="flex items-start gap-2.5">
              <span className="flex w-[18px] flex-none flex-col items-center self-stretch" aria-hidden>
                <span
                  className={cn('h-3 w-px flex-none', isFirst ? 'bg-transparent' : 'prism-rail-line')}
                  data-state="charged"
                />
                <span className="flex h-4 w-4 flex-none items-center justify-center">
                  <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground" />
                </span>
                <span
                  className={cn('w-px flex-1', isLast ? 'bg-transparent' : 'prism-rail-line')}
                  data-state="charged"
                />
              </span>

              <div className="group/narration min-w-0 flex-1 py-1.5">
                <ClampedBlock maxHeight={320} copyText={narrationText}>
                  <Markdown className="prose prose-sm max-w-none font-sans text-[13.5px] leading-[22px] text-body dark:prose-invert">
                    {narrationText}
                  </Markdown>
                </ClampedBlock>
                <div className="mt-1 flex items-center text-[11px] opacity-0 transition-opacity focus-within:opacity-100 group-hover/narration:opacity-100">
                  <MessageCopyControl content={narrationText} messageType="assistant" />
                </div>
              </div>
            </div>
          );
        }

        const iconKey: ActivityIconKey = summary ? summary.icon : 'thinking';
        const Icon = summary?.status === 'error' ? XCircle : ICONS[iconKey];

        // 竖线的「充能」:某一步跑完,它下面那截线就亮起来(深色下是自上而下
        // 的强调色渐变,淡色下仍是一条普通发丝线)。还没轮到的那截保持暗。
        const isRowDone = summary ? summary.status !== 'running' : true;
        const prevDone = index > 0 && rows[index - 1].summary?.status !== 'running';
        const railState = (done: boolean) => (done ? 'charged' : 'pending');

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
          <div key={row.key} className="flex items-start gap-2.5">
            {/* 图标列:上截 8px 对齐文字中线,下截撑满整行(含展开区) */}
            <span className="flex w-[18px] flex-none flex-col items-center self-stretch" aria-hidden>
              <span
                className={cn('h-3 w-px flex-none', isFirst ? 'bg-transparent' : 'prism-rail-line')}
                data-state={railState(prevDone)}
              />
              <Icon
                className={cn(
                  'h-4 w-4 flex-none',
                  summary?.status === 'running' ? 'text-primary' : 'text-muted-foreground',
                )}
                strokeWidth={2}
              />
              <span
                className={cn('w-px flex-1', isLast ? 'bg-transparent' : 'prism-rail-line')}
                data-state={railState(isRowDone)}
              />
            </span>

            <div className="min-w-0 flex-1">
              <button
                type="button"
                onClick={() => toggle(row.key)}
                aria-expanded={isExpanded}
                className="group flex w-full items-center gap-2.5 py-2.5 text-left"
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
                  {summary?.status === 'running' && !summary.duration
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
                    <>
                      {/* 思考是旁注不是正文:压一档字号与颜色,左侧留发丝线,
                          太长先折 10 行左右,底下给「展开全部」。 */}
                      <ClampedBlock
                        maxHeight={220}
                        copyText={String(row.message.content || '')}
                        contentClassName="border-l border-border pl-3"
                      >
                        <Markdown className="prose prose-sm max-w-none font-sans text-[13px] leading-[21px] text-muted-foreground dark:prose-invert">
                          {String(row.message.content || '')}
                        </Markdown>
                      </ClampedBlock>
                      <div className="mt-2 flex items-center text-[11px]">
                        <MessageCopyControl
                          content={String(row.message.content || '')}
                          messageType="assistant"
                        />
                      </div>
                    </>
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
export default memo(ActivityTimeline);
