import { memo, useMemo, useState } from 'react';
import { Bot, Brain, Check, ChevronRight, Loader2, XCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { ChatMessage, SubagentChildTool } from '../../types/types';
import type { SubagentGroupItem } from '../../utils/toolGrouping';
import { shortToolName, shouldFoldNarration } from '../../utils/toolRowSummary';
import { cn } from '../../../../lib/utils';

/**
 * 子代理卡片组(ci 轮,用户点名的样式)。
 *
 * 相邻的 Task/Agent 调用渲染成一张聚合卡:抬头「运行 N 个子代理 · 共 M 步」,
 * 里面是并排的子卡网格 —— 每张卡:状态(✓ / 转圈 / ✗)+ 任务描述 + 步数;
 * 点开子卡,在网格下方展开**该子代理自己的步骤时间轴**(实时增长)与最终汇报。
 *
 * 子步骤数据两路合一(useChatMessages):实时 parentToolUseId 帧 + 跑完后的
 * agent-*.jsonl 解析,按 toolId 去重 —— 运行中逐步点亮,刷新后不丢。
 */

type ParsedInput = { description?: string; subagent_type?: string; prompt?: string };

function parseInput(toolInput: unknown): ParsedInput {
  if (typeof toolInput === 'string') {
    try { return JSON.parse(toolInput) as ParsedInput; } catch { return {}; }
  }
  return (toolInput as ParsedInput) || {};
}

/** 子步骤一行的目标短文案(文件名/命令/模式)。 */
function childTarget(toolName: string, toolInput: unknown): string {
  const input = parseInput(toolInput) as Record<string, unknown>;
  const pick = (value: unknown) => (typeof value === 'string' ? value : '');
  switch (toolName) {
    case 'Read': case 'Write': case 'Edit': case 'ApplyPatch': case 'NotebookEdit': {
      const path = pick(input.file_path);
      return path.split(/[\\/]/).pop() || path;
    }
    case 'Bash': {
      const cmd = pick(input.command);
      return cmd.length > 48 ? `${cmd.slice(0, 48)}…` : cmd;
    }
    case 'Grep': case 'Glob': return pick(input.pattern);
    case 'WebFetch': return pick(input.url);
    case 'WebSearch': return pick(input.query);
    default: return '';
  }
}

/** 提取父结果里的正文(SDK 把它包成 [{type:'text',text}] 或 JSON 串)。 */
function extractResultText(content: unknown): string {
  let value: unknown = content;
  if (typeof value === 'string') {
    const raw: string = value;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) value = parsed;
      else return raw;
    } catch { return raw; }
  }
  if (Array.isArray(value)) {
    const parts = (value as Array<{ type?: string; text?: string }>)
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text as string);
    if (parts.length > 0) return parts.join('\n');
  }
  return typeof value === 'string' ? value : value ? JSON.stringify(value, null, 2) : '';
}

function ChildStepRow({ child, isLast, stillRunning }: {
  child: SubagentChildTool;
  isLast: boolean;
  /** 这一步现在还可能有结果送来吗 —— 回合还在跑、且这个子代理自己还没收工。 */
  stillRunning: boolean;
}) {
  const { t } = useTranslation('chat');
  /** gg:长叙述默认折起来,点开才铺全文(见 NARRATION_FOLD_CHARS)。 */
  const [narrationOpen, setNarrationOpen] = useState(false);
  /**
   * ga:**没有结果 ≠ 还在跑。**
   *
   * fz 给这张卡本身和抬头都接上了"这一轮还在不在跑",唯独展开区里的步骤行
   * 没拿到这个信号。于是卡片抬头显示 ✗「已中断」,点开一看最后一条子步骤还在
   * 转圈 —— 同一张卡上两块牌子说反话(门口牌子翻成"今日打烊",后厨取餐屏
   * 还亮着"正在烹饪中")。
   *
   * 还要加一条"这个子代理自己收工了没有":回合仍在跑、但这个子代理已经交了
   * 最终结果时,它名下那些没有结果的步骤同样不会再有结果了。
   */
  /**
   * ge:**正文与思考也是一步。**
   *
   * `forwardSubagentText` 打开之后,子代理自己说的话与思考也带着
   * `parent_tool_use_id` 过来(SDK 明说那就是给"渲染嵌套 transcript"用的)。
   * 它们没有 toolResult、也不该转圈 —— 那是"它说了这么一句",不是"一步在跑"。
   */
  const isNarration = child.kind === 'text' || child.kind === 'thinking';
  const running = !isNarration && !child.toolResult && stillRunning;
  const interrupted = !isNarration && !child.toolResult && !stillRunning;
  const target = childTarget(child.toolName, child.toolInput);

  if (isNarration) {
    const body = String(child.content || '').trim()
      || (child.kind === 'thinking' ? t('activity.thinking', { defaultValue: '思考' }) : '');
    /** 折起来时露的那一行:第一段非空的行。 */
    const firstLine = body.split('\n').find((line) => line.trim()) ?? body;
    const foldable = shouldFoldNarration(body);
    const rail = (
      <span className="flex w-[16px] flex-none flex-col items-center self-stretch" aria-hidden>
        <span className={cn('h-1.5 w-px flex-none', 'prism-rail-line')} data-state="charged" />
        <span className="grid h-3.5 w-3.5 flex-none place-items-center">
          {child.kind === 'thinking'
            ? <Brain className="h-3 w-3 text-muted-foreground" strokeWidth={2} />
            : <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/70" />}
        </span>
        <span className={cn('w-px flex-1', isLast ? 'bg-transparent' : 'prism-rail-line')} data-state="charged" />
      </span>
    );

    if (!foldable) {
      return (
        <div className="flex items-start gap-2">
          {rail}
          <div className="min-w-0 flex-1 whitespace-pre-wrap break-words py-0.5 text-[12.5px] leading-5 text-muted-foreground">
            {body}
          </div>
        </div>
      );
    }

    /**
     * gg:**长叙述默认只露一行。**
     *
     * 折起来的是**这一条**,不是整段轴 —— 每条自己记开合,展开一条不会把别的
     * 也掀开。露出来的那一行用 `line-clamp-1` 而不是截断字符串:截断要猜宽度,
     * 而这块区域从手机到宽屏差着好几倍。
     */
    return (
      <div className="flex items-start gap-2">
        {rail}
        <button
          type="button"
          onClick={() => setNarrationOpen((open) => !open)}
          aria-expanded={narrationOpen}
          className="flex min-w-0 flex-1 items-start gap-1 py-0.5 text-left text-[12.5px] leading-5 text-muted-foreground hover:text-body"
        >
          <ChevronRight
            className={cn('mt-1 h-3 w-3 flex-none transition-transform', narrationOpen && 'rotate-90')}
            strokeWidth={2}
            aria-hidden
          />
          <span className={cn('min-w-0 flex-1 break-words', narrationOpen ? 'whitespace-pre-wrap' : 'line-clamp-1')}>
            {narrationOpen ? body : firstLine}
          </span>
        </button>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-2">
      <span className="flex w-[16px] flex-none flex-col items-center self-stretch" aria-hidden>
        <span className={cn('h-1.5 w-px flex-none', 'prism-rail-line')} data-state="charged" />
        <span className="grid h-3.5 w-3.5 flex-none place-items-center">
          {child.toolResult?.isError ? (
            <XCircle className="h-3 w-3 text-muted-foreground" strokeWidth={2} />
          ) : running ? (
            <Loader2 className="h-3 w-3 animate-spin text-primary" strokeWidth={2} />
          ) : interrupted ? (
            <XCircle
              className="h-3 w-3 text-muted-foreground"
              strokeWidth={2}
              aria-label={t('activity.interrupted', { defaultValue: '已中断' })}
            />
          ) : (
            <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/70" />
          )}
        </span>
        <span className={cn('w-px flex-1', isLast ? 'bg-transparent' : 'prism-rail-line')} data-state="charged" />
      </span>
      <div className="flex min-w-0 flex-1 items-center gap-2 py-0.5 text-[12.5px] leading-5">
        <span className={cn('flex-none font-medium', running ? 'text-primary' : 'text-body')}>
          {shortToolName(child.toolName)}
        </span>
        {target && <span className="min-w-0 truncate font-mono text-muted-foreground">{target}</span>}
        {child.toolResult?.isError && (
          <span className="flex-none text-[11px] text-muted-foreground">(出错)</span>
        )}
        {interrupted && (
          <span className="flex-none text-[11px] text-muted-foreground">
            ({t('activity.interrupted', { defaultValue: '已中断' })})
          </span>
        )}
      </div>
    </div>
  );
}

function SubagentCard({
  message,
  isOpen,
  onToggle,
  isCurrentTurn,
}: {
  message: ChatMessage;
  isOpen: boolean;
  onToggle: () => void;
  /** 这一段属于正在跑的那一轮吗 —— 决定没有结果的子代理是「进行中」还是「已中断」。 */
  isCurrentTurn: boolean;
}) {
  const { t } = useTranslation('chat');
  const input = parseInput(message.toolInput);
  const description = input.description || input.subagent_type
    || t('subagent.defaultTitle', { defaultValue: '子代理任务' });
  const childTools = message.subagentState?.childTools ?? [];
  /**
   * gd:**转到后台之后,这张卡的真相在 `background` 里。**
   *
   * 任务一转后台,那次工具调用**立刻**拿到一个"running in the background"的
   * tool_result(SDK 原话)—— 按老判据(`isComplete = 有 toolResult`)卡片当场
   * 就算"完成"了,步数也停在转后台之前跑到的那几步。线上看到的「2 步 ✓」
   * 就是这么来的:它其实还在跑,而且后来跑了几十步。
   *
   * 真正的进展与终态在 SDK 的 `task_progress` / `task_notification` 里,
   * 由 `useChatMessages` 按 `tool_use_id` 归到这里(见 subagentState.background)。
   */
  const background = message.subagentState?.background;
  const isComplete = background
    ? background.status !== 'running'
    : Boolean(message.subagentState?.isComplete || message.toolResult);
  const isError = background
    ? background.status === 'failed'
    : Boolean(message.toolResult?.isError);
  /**
   * 步数。
   *
   * ge(纠错):gd 写的是 `background?.toolUses ?? childTools.length`,前提是
   * "转后台之后子步骤不再走实时流"—— **那个前提是错的**。SDK 的
   * `forwardSubagentText` 文档原话:默认就转发子代理的 tool_use / tool_result
   * ("enough for a heartbeat counter")。也就是说 `childTools` 一直是全的,
   * 用 `??` 会让一条早到的 `task_progress`(比如刚跑了 3 步)把已经收到的
   * 54 步盖成 3。
   *
   * 两个数来源不同、各有可能更全(后台计数含 CLI 侧统计,childTools 含实际到达
   * 的帧),取大的那个。
   */
  const stepCount = Math.max(background?.toolUses ?? 0, childTools.length);
  /**
   * fz:**没有结果 + 这一轮已经不在跑了 = 已中断,不是"还在跑"。**
   *
   * `ActivityTimeline` 那侧的 `summarizeToolRow` 早就这么判了,这条并行的渲染
   * 路径没跟上 —— 它连"会话在不在跑"这个入参都没有。于是 Task/Agent 容器的
   * `tool_result` 永远不会到时(用户按停止、服务重启把回合掐断、CLI 崩了),
   * 这张卡就**永久**转着圈:刷新、明天、下个月翻回这条会话,它还在转,
   * 而旁边同一屏的工具清单写着「已中断」—— 两处对同一件事给出相反的说法。
   */
  /**
   * gd:**在后台跑着的任务不算「已中断」。**
   *
   * 「已中断」的意思是"这一轮不跑了,它却没有结果"。而后台任务恰恰相反 ——
   * 主回合早就结束了,它还在自己跑,`task_notification` 会在 settle 时到达。
   * 不区分的话,一转后台立刻被标成 ✗,而几十秒后它成功了。
   */
  const isInterrupted = !isComplete && !isCurrentTurn && !background;
  /** 「现在在跑哪一步」只看真正的工具步 —— 正文/思考不是"在跑"。 */
  const toolSteps = childTools.filter((child) => child.kind !== 'text' && child.kind !== 'thinking');
  const current = !isComplete && toolSteps.length > 0 ? toolSteps[toolSteps.length - 1] : null;
  /** 后台跑着时,"现在在干什么"来自 task_progress 的 last_tool_name。 */
  const backgroundHint = background?.status === 'running'
    ? [background.lastToolName, background.summary].filter(Boolean).join(' · ')
    : '';
  /**
   * gf:**跑完之后只留一个耗时,一行小字。**
   *
   * 撤掉展开区那一大块后台汇报(见展开区的注释),成败已经由抬头的 ✓/✗ 说了,
   * 剩下唯一值得留的量是"跑了多久" —— 压成步数徽标旁边的一句 `耗时 12s`。
   */
  const doneSeconds = background && background.status !== 'running'
    && Number.isFinite(background.durationMs) && (background.durationMs as number) > 0
    ? Math.max(1, Math.round((background.durationMs as number) / 1000))
    : null;

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={isOpen}
      className={cn(
        'flex min-w-0 flex-col gap-1.5 rounded-lg border bg-card p-3 text-left transition-colors',
        isOpen ? 'border-primary/40' : 'border-border hover:border-border-strong',
      )}
    >
      <span className="flex w-full min-w-0 items-center gap-2">
        <span className="grid h-4 w-4 flex-none place-items-center">
          {isError ? (
            <XCircle className="h-4 w-4 text-muted-foreground" strokeWidth={2} />
          ) : isComplete ? (
            <Check className="h-4 w-4 text-primary" strokeWidth={2.5} />
          ) : isInterrupted ? (
            <XCircle className="h-4 w-4 text-muted-foreground" strokeWidth={2} aria-label={t('activity.interrupted', { defaultValue: '已中断' })} />
          ) : (
            <Loader2 className="h-4 w-4 animate-spin text-primary" strokeWidth={2} />
          )}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium leading-5 text-foreground" title={description}>
          {description}
        </span>
      </span>
      <span className="flex w-full min-w-0 items-center gap-2 pl-6">
        <span className="flex-none rounded-full border border-border bg-muted px-2 py-px font-mono text-[11px] text-muted-foreground">
          {t('subagent.steps', { count: stepCount, defaultValue: '{{count}} 步' })}
        </span>
        {backgroundHint ? (
          <span className="min-w-0 truncate text-[11.5px] text-muted-foreground">{backgroundHint}</span>
        ) : current ? (
          <span className="min-w-0 truncate text-[11.5px] text-muted-foreground">
            {shortToolName(current.toolName)} {childTarget(current.toolName, current.toolInput)}
          </span>
        ) : doneSeconds !== null ? (
          <span className="min-w-0 flex-none truncate text-[11.5px] text-muted-foreground">
            {t('subagent.elapsed', { seconds: doneSeconds, defaultValue: '耗时 {{seconds}}s' })}
          </span>
        ) : null}
      </span>
    </button>
  );
}

interface SubagentGroupCardProps {
  group: SubagentGroupItem;
  getMessageKey: (message: ChatMessage) => string;
  /** 这一段属于正在跑的那一轮吗(与 ActivityTimeline 的 sessionIsProcessing 同一个信号)。 */
  isCurrentTurn?: boolean;
  /** 滚动位置锚点用的稳定行标识(见 useChatSessionState 的 data-row-key)。 */
  rowKey?: string;
}

function SubagentGroupCard({ group, getMessageKey, isCurrentTurn = false, rowKey }: SubagentGroupCardProps) {
  const { t } = useTranslation('chat');
  const [openKey, setOpenKey] = useState<string | null>(null);

  /** ge:两个来源取大的那个(理由见 SubagentCard 里 stepCount 的说明)。 */
  const stepCountOf = (message: ChatMessage) => Math.max(
    message.subagentState?.background?.toolUses ?? 0,
    message.subagentState?.childTools.length ?? 0,
  );
  const totalSteps = useMemo(
    () => group.messages.reduce((sum, message) => sum + stepCountOf(message), 0),
    [group.messages],
  );
  /**
   * 「N 个进行中」。
   *
   * fz:回合都不在跑了就没有"进行中"这回事。
   * gd:**后台任务是那条规则的例外** —— 主回合结束之后它还在自己跑,
   * `task_notification` settle 时才到。所以后台状态说了算,不看 `isCurrentTurn`。
   */
  const runningCount = group.messages.filter((message) => {
    const background = message.subagentState?.background;
    if (background) return background.status === 'running';
    if (!isCurrentTurn) return false;
    return !(message.subagentState?.isComplete || message.toolResult);
  }).length;

  const openMessage = openKey
    ? group.messages.find((message) => getMessageKey(message) === openKey) ?? null
    : null;
  const openChildren = openMessage?.subagentState?.childTools ?? [];
  /**
   * ga:展开区里的步骤行也要知道"还会不会有结果送来"(见 ChildStepRow)。
   * 两个条件:这一轮还在跑,**并且**这个子代理自己还没交最终结果。
   */
  const openStillRunning = isCurrentTurn
    && !(openMessage?.subagentState?.isComplete || openMessage?.toolResult);
  const openInput = openMessage ? parseInput(openMessage.toolInput) : {};

  return (
    <div
      className="chat-message tool px-3 sm:px-0"
      data-row-key={rowKey}
      data-message-timestamp={group.timestamp || undefined}
    >
      <div className="prism-panel rounded-lg border border-border bg-card/60 p-3">
        {/* 抬头:运行 N 个子代理 · 共 M 步(还在跑时带转圈) */}
        <div className="flex items-center gap-2 pb-2.5 text-[13px] leading-5 text-muted-foreground">
          <Bot className="h-4 w-4 flex-none" strokeWidth={2} aria-hidden />
          <span className="min-w-0 truncate">
            {t('subagent.groupTitle', {
              count: group.messages.length,
              defaultValue: '运行 {{count}} 个子代理',
            })}
            {' · '}
            {t('subagent.totalSteps', { count: totalSteps, defaultValue: '共 {{count}} 步' })}
          </span>
          {runningCount > 0 && (
            <span className="flex flex-none items-center gap-1.5 font-mono text-[11px] text-primary">
              <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2} />
              {t('subagent.runningCount', { count: runningCount, defaultValue: '{{count}} 个进行中' })}
            </span>
          )}
        </div>

        {/* 子卡网格 */}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {group.messages.map((message) => {
            const key = getMessageKey(message);
            return (
              <SubagentCard
                key={key}
                message={message}
                isOpen={openKey === key}
                onToggle={() => setOpenKey((current) => (current === key ? null : key))}
                isCurrentTurn={isCurrentTurn}
              />
            );
          })}
        </div>

        {/*
          展开区:选中子代理的步骤时间轴 + 最终汇报。

          gd:**不再套一层独立的框。** 之前是 `rounded-lg border bg-background`,
          于是点开一个子代理,主对话流里就多出一个与上下都不连的白盒子 ——
          而它本该读作"这一条时间轴接在上面那根轴上继续往下走"。
          现在改成左侧一根竖线把它挂在卡片组下面(与 ChildStepRow 自己的
          `prism-rail-line` 同一根),视觉上是同一条轴的延续。
        */}
        {openMessage && (
          <div className="mt-1 border-l border-border pl-3">
            {typeof openInput.prompt === 'string' && openInput.prompt.trim() && (
              <div className="mb-2 border-l-2 border-border pl-2.5 text-[12px] leading-5 text-muted-foreground">
                <span className="mr-1 font-medium">{t('subagent.promptLabel', { defaultValue: '指令:' })}</span>
                <span className="line-clamp-3 whitespace-pre-wrap break-words">{openInput.prompt}</span>
              </div>
            )}

            {openChildren.length === 0 ? (
              <div className="py-1 text-[12.5px] text-muted-foreground">
                {t('subagent.noStepsYet', { defaultValue: '还没有步骤 —— 子代理正在启动。' })}
              </div>
            ) : (
              <div>
                {openChildren.map((child, index) => (
                  <ChildStepRow
                    key={child.toolId || index}
                    child={child}
                    isLast={index === openChildren.length - 1}
                    stillRunning={openStillRunning}
                  />
                ))}
              </div>
            )}

            {/*
              gf:**展开区只有这个子代理自己的那根轴。**

              gd/ge 在轴下面还挂了两块:后台任务的 `summary`(那时是一坨
              `✅ 后台任务完成 · 耗时…\n\n<全文>` 的多行大块)和「子代理汇报」
              (父 tool_result 的全文 Markdown)。用户原话:「子agent点开时的
              子代理汇报不要,后台任务完成这个详细信息,能不能简洁,排版正常些」。

              两块都撤:成败与耗时压成卡片抬头那一行的小字(见 SubagentCard),
              汇报的内容主代理本来就会在下一句话里说 —— 轴上不再另起一段。
              **只留失败原因**:那是这根轴上唯一"不说就丢了"的信息。
            */}
            {openMessage.toolResult?.isError && (
              <div className="mt-2 border-t border-border pt-2 text-[12.5px] text-muted-foreground">
                {t('subagent.failed', { defaultValue: '子代理执行失败:' })}
                <span className="ml-1 break-words">{extractResultText(openMessage.toolResult.content).slice(0, 400)}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default memo(SubagentGroupCard);
