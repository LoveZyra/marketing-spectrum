import React from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronsUpDown, FileText } from 'lucide-react';

import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardFooter,
  Button,
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
  Shimmer,
} from '../../../../shared/view/ui';
import { usePermission } from '../../../../contexts/PermissionContext';

import { MarkdownContent } from './ContentRenderers';

interface PlanDisplayProps {
  title: string;
  content: string;
  defaultOpen?: boolean;
  isStreaming?: boolean;
  showRawParameters?: boolean;
  rawContent?: string;
  toolName: string;
  toolId?: string;
}

export const PlanDisplay: React.FC<PlanDisplayProps> = ({
  title,
  content,
  defaultOpen = false,
  isStreaming = false,
  showRawParameters = false,
  rawContent,
  toolName: _toolName,
}) => {
  const { t } = useTranslation('chat');
  const permissionCtx = usePermission();

  // 只认领**属于这张卡**的待批请求 —— 按计划正文匹配。
  //
  // 修前:每张 PlanDisplay 都全局 find 任意一个 pending 的 ExitPlanMode 请求,
  // 不与自身内容对应。于是会话里有旧计划时,新请求一来,所有旧计划卡都会长出
  // Build/Revise 按钮,点旧卡的 Build 批的却是新计划。
  const normalizePlan = (value: unknown): string =>
    (typeof value === 'string' ? value : '').replace(/\\n/g, '\n').trim();
  const thisPlan = normalizePlan(content);
  const pendingRequest = permissionCtx?.pendingPermissionRequests.find((r) => {
    if (r.toolName !== 'ExitPlanMode' && r.toolName !== 'exit_plan_mode') return false;
    const requestPlan = normalizePlan((r.input as { plan?: unknown } | undefined)?.plan);
    // 正文一致才是这张卡的请求;计划通常又长又独特,足以区分。取不到正文时
    // (理论上不该发生)宁可不显示按钮,也不错配到别的计划上。
    return requestPlan.length > 0 && requestPlan === thisPlan;
  });

  const handleBuild = () => {
    if (pendingRequest && permissionCtx) {
      permissionCtx.handlePermissionDecision(pendingRequest.requestId, { allow: true });
    }
  };

  const handleRevise = () => {
    if (pendingRequest && permissionCtx) {
      permissionCtx.handlePermissionDecision(pendingRequest.requestId, {
        allow: false,
        message: 'User asked to revise the plan',
      });
    }
  };

  return (
    <Collapsible defaultOpen={defaultOpen}>
      <Card className="my-1 flex flex-col shadow-none">
        {/* Header — always visible */}
        <CardHeader className="flex flex-row items-start justify-between space-y-0 px-4 pb-0 pt-4">
          <div className="flex items-center gap-2">
            <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
            <CardTitle className="text-sm font-semibold">
              {(() => {
                const displayTitle = title === 'Implementation plan'
                  ? t('plan.title', { defaultValue: '实施计划' })
                  : title;
                return isStreaming ? <Shimmer>{displayTitle}</Shimmer> : displayTitle;
              })()}
            </CardTitle>
          </div>
          <CollapsibleTrigger className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground">
            <ChevronsUpDown className="h-4 w-4" />
            <span className="sr-only">Toggle plan</span>
          </CollapsibleTrigger>
        </CardHeader>

        {/* Collapsible content */}
        <CollapsibleContent>
          <CardContent className="px-4 pb-4 pt-3">
            {content ? (
              <MarkdownContent
                content={content}
                className="prose prose-sm max-w-none dark:prose-invert"
              />
            ) : isStreaming ? (
              <div className="py-2">
                <Shimmer>{t('plan.generating', { defaultValue: '正在生成计划…' })}</Shimmer>
              </div>
            ) : null}

            {showRawParameters && rawContent && (
              <Collapsible className="mt-3">
                <CollapsibleTrigger className="flex items-center gap-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground">
                  <svg
                    className="h-2.5 w-2.5 flex-shrink-0 transition-transform duration-150 data-[state=open]:rotate-90"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                  {t('plan.rawParams', { defaultValue: '原始参数' })}
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <pre className="mt-1 overflow-hidden whitespace-pre-wrap break-words rounded border border-border bg-muted p-2 font-mono text-[11px] text-muted-foreground">
                    {rawContent}
                  </pre>
                </CollapsibleContent>
              </Collapsible>
            )}
          </CardContent>
        </CollapsibleContent>

        {/* Footer — always visible when permission is pending */}
        {pendingRequest && (
          <CardFooter className="justify-end gap-2 border-t border-border px-4 pb-3 pt-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleRevise}
              className="text-muted-foreground"
            >
              {t('plan.revise', { defaultValue: '继续修改' })}
            </Button>
            <Button size="sm" onClick={handleBuild}>
              {t('plan.build', { defaultValue: '开始实施' })}
            </Button>
          </CardFooter>
        )}
      </Card>
    </Collapsible>
  );
};
