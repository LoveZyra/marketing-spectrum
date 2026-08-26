import { memo, useMemo, useState } from 'react';
import { Bot, Check, ChevronRight, Loader2, XCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { ChatMessage, SubagentChildTool } from '../../types/types';
import type { SubagentGroupItem } from '../../utils/toolGrouping';
import { shortToolName } from '../../utils/toolRowSummary';
import { cn } from '../../../../lib/utils';
import { ClampedBlock } from '../../../../shared/view/ui';

import { Markdown } from './Markdown';

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

function ChildStepRow({ child, isLast }: { child: SubagentChildTool; isLast: boolean }) {
  const running = !child.toolResult;
  const target = childTarget(child.toolName, child.toolInput);
  return (
    <div className="flex items-start gap-2">
      <span className="flex w-[16px] flex-none flex-col items-center self-stretch" aria-hidden>
        <span className={cn('h-1.5 w-px flex-none', 'prism-rail-line')} data-state="charged" />
        <span className="grid h-3.5 w-3.5 flex-none place-items-center">
          {child.toolResult?.isError ? (
            <XCircle className="h-3 w-3 text-muted-foreground" strokeWidth={2} />
          ) : running ? (
            <Loader2 className="h-3 w-3 animate-spin text-primary" strokeWidth={2} />
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
      </div>
    </div>
  );
}

function SubagentCard({
  message,
  isOpen,
  onToggle,
}: {
  message: ChatMessage;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation('chat');
  const input = parseInput(message.toolInput);
  const description = input.description || input.subagent_type
    || t('subagent.defaultTitle', { defaultValue: '子代理任务' });
  const childTools = message.subagentState?.childTools ?? [];
  const isComplete = Boolean(message.subagentState?.isComplete || message.toolResult);
  const isError = Boolean(message.toolResult?.isError);
  const current = !isComplete && childTools.length > 0 ? childTools[childTools.length - 1] : null;

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
          {t('subagent.steps', { count: childTools.length, defaultValue: '{{count}} 步' })}
        </span>
        {current && (
          <span className="min-w-0 truncate text-[11.5px] text-muted-foreground">
            {shortToolName(current.toolName)} {childTarget(current.toolName, current.toolInput)}
          </span>
        )}
      </span>
    </button>
  );
}

interface SubagentGroupCardProps {
  group: SubagentGroupItem;
  getMessageKey: (message: ChatMessage) => string;
}

function SubagentGroupCard({ group, getMessageKey }: SubagentGroupCardProps) {
  const { t } = useTranslation('chat');
  const [openKey, setOpenKey] = useState<string | null>(null);

  const totalSteps = useMemo(
    () => group.messages.reduce((sum, message) => sum + (message.subagentState?.childTools.length ?? 0), 0),
    [group.messages],
  );
  const runningCount = group.messages.filter(
    (message) => !(message.subagentState?.isComplete || message.toolResult),
  ).length;

  const openMessage = openKey
    ? group.messages.find((message) => getMessageKey(message) === openKey) ?? null
    : null;
  const openChildren = openMessage?.subagentState?.childTools ?? [];
  const openInput = openMessage ? parseInput(openMessage.toolInput) : {};
  const openResultText = openMessage?.toolResult && !openMessage.toolResult.isError
    ? extractResultText(openMessage.toolResult.content)
    : '';

  return (
    <div
      className="chat-message tool px-3 sm:px-0"
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
              />
            );
          })}
        </div>

        {/* 展开区:选中子代理的步骤时间轴 + 最终汇报 */}
        {openMessage && (
          <div className="mt-2 rounded-lg border border-border bg-background p-3">
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
                  <ChildStepRow key={child.toolId || index} child={child} isLast={index === openChildren.length - 1} />
                ))}
              </div>
            )}

            {openResultText && (
              <div className="mt-2 border-t border-border pt-2">
                <div className="mb-1 flex items-center gap-1.5 text-[12px] font-medium text-muted-foreground">
                  <ChevronRight className="h-3 w-3" strokeWidth={2} aria-hidden />
                  {t('subagent.resultLabel', { defaultValue: '子代理汇报' })}
                </div>
                <ClampedBlock maxHeight={260} copyText={openResultText}>
                  <Markdown className="prose prose-sm max-w-none font-sans text-[13px] leading-[21px] text-body dark:prose-invert">
                    {openResultText}
                  </Markdown>
                </ClampedBlock>
              </div>
            )}
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
